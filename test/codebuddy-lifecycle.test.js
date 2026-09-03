"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCodeBuddyRuntimeAdapter } = require("../src/adapters/runtime/codebuddy");
const { CodeBuddyClient } = require("../src/adapters/runtime/codebuddy/client");

const IDENTITY = "a".repeat(64);

function createHarness({ root, clientOverrides = {}, generation = "generation-1" } = {}) {
  const calls = [];
  let lifecycle = null;
  const client = {
    async connect() { calls.push("connect"); },
    async initialize() { calls.push("initialize"); return { protocolVersion: 1 }; },
    async getIdentityFingerprint() { return IDENTITY; },
    async newSession() { calls.push("new"); return { sessionId: "session-1", modelId: "auto" }; },
    async resumeSession(input) { calls.push(["resume", input]); return { sessionId: input.sessionId }; },
    async prompt() { calls.push("prompt"); return { text: "reply", stopReason: "end_turn" }; },
    async disconnect() { calls.push("disconnect"); },
    ...clientOverrides,
  };
  const adapter = createCodeBuddyRuntimeAdapter({
    config: {
      stateDir: root,
      workspaceRoot: "D:\\CyberBoss",
      sessionsFile: path.join(root, "sessions.json"),
      runtimeInstanceId: "runtime-1",
    },
    profile: {
      id: "profile-1",
      runtimeId: "codebuddy",
      modelId: "auto",
      secretGeneration: 1,
      options: {},
      capabilities: { accountIdentityFingerprint: IDENTITY },
    },
    secrets: { servicePassword: "gateway-secret" },
    locateDistribution: async () => ({ source: "test", version: "2.115.0", command: "codebuddy.exe", argsPrefix: [] }),
    processHostFactory: () => ({
      async start() { return { endpoint: "http://127.0.0.1:45000", health: { ok: true } }; },
      async stop() {},
    }),
    clientFactory: (options) => {
      lifecycle = options.onLifecycle;
      // The adapter's real client receives this generation through the factory.
      assert.equal(options.transportGenerationId.length > 0, true);
      return client;
    },
  });
  return { adapter, calls, getLifecycle: () => lifecycle };
}

async function sendAndWait(adapter, calls, text) {
  const result = await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text });
  await waitFor(() => calls.filter((call) => call === "prompt").length >= 1);
  return result;
}

test("attachment reuse is scoped to the current generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-lifecycle-same-"));
  const { adapter, calls } = createHarness({ root });
  await sendAndWait(adapter, calls, "first");
  await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "second" });
  await waitFor(() => calls.filter((call) => call === "prompt").length >= 2);

  assert.equal(calls.filter((call) => call === "new").length, 1);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "resume").length, 0);
  await adapter.close();
});

test("disconnect and generation change invalidate only the in-memory attachment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-lifecycle-change-"));
  const seeded = createHarness({ root });
  await sendAndWait(seeded.adapter, seeded.calls, "seed");
  await seeded.adapter.close();

  const resumed = createHarness({ root });
  await sendAndWait(resumed.adapter, resumed.calls, "resume");
  resumed.getLifecycle()({ type: "disconnected", generationId: "generation-1" });
  await resumed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "after disconnect" });
  await waitFor(() => resumed.calls.filter((call) => call === "prompt").length >= 2);
  resumed.getLifecycle()({ type: "connected", generationId: "generation-2" });
  await resumed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "after generation" });
  await waitFor(() => resumed.calls.filter((call) => call === "prompt").length >= 3);

  assert.equal(resumed.calls.filter((call) => call === "new").length, 0);
  assert.equal(resumed.calls.filter((call) => Array.isArray(call) && call[0] === "resume").length, 3);
  assert.equal(resumed.adapter.getSessionStore().getThreadIdForWorkspace("binding", "D:\\CyberBoss"), "session-1");
  await resumed.adapter.close();
});

test("prompt timeout does not invalidate a healthy attachment or delete persistence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-lifecycle-timeout-"));
  const { adapter, calls } = createHarness({
    root,
    clientOverrides: {
      async prompt() {
        calls.push("prompt");
        throw Object.assign(new Error("model took too long"), { code: "CODEBUDDY_START_TIMEOUT" });
      },
    },
  });
  await sendAndWait(adapter, calls, "timeout");
  await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "reuse" });
  await waitFor(() => calls.filter((call) => call === "prompt").length >= 2);

  assert.equal(calls.filter((call) => call === "new").length, 1);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === "resume").length, 0);
  assert.equal(adapter.getSessionStore().getThreadIdForWorkspace("binding", "D:\\CyberBoss"), "session-1");
  await adapter.close();
});

test("CodeBuddyClient reports disconnect and rotates generation only on a later reconnect", async () => {
  const lifecycle = [];
  let call = 0;
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:45000",
    servicePassword: "gateway-secret",
    transportGenerationId: "generation-1",
    onLifecycle: (event) => lifecycle.push(event),
    fetchImpl: async (_url, options) => {
      call += 1;
      if (call === 1 || call === 3) return { ok: true, status: 200, async text() { return JSON.stringify({ connectionId: `connection-${call}`, sessionToken: "session-token" }); } };
      return { ok: false, status: 503, async text() { return ""; } };
    },
  });
  await client.connect();
  await assert.rejects(client.prompt({ sessionId: "session-1", text: "hello" }), (error) => error.code === "CODEBUDDY_CONNECTION_LOST");
  assert.equal(client.connectionId, "");
  assert.equal(lifecycle[0].type, "connected");
  assert.equal(lifecycle[1].type, "connection_lost");
  await client.connect();
  assert.equal(lifecycle[2].type, "connected");
  assert.notEqual(lifecycle[2].generationId, "generation-1");
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}
