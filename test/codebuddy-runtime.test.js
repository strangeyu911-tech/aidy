"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCodeBuddyRuntimeAdapter } = require("../src/adapters/runtime/codebuddy");
const { StreamDelivery } = require("../src/core/stream-delivery");

const IDENTITY = "a".repeat(64);

function profile(overrides = {}) {
  return {
    id: "codebuddy-profile",
    runtimeId: "codebuddy",
    modelId: "auto",
    secretGeneration: 3,
    options: {},
    capabilities: { accountIdentityFingerprint: IDENTITY },
    ...overrides,
  };
}

function createHarness({ sessionsFile, clientOverrides = {}, identity = IDENTITY, configOverrides = {}, profileOverrides = {} } = {}) {
  const calls = [];
  const host = {
    async start(input) {
      calls.push(["host.start", input]);
      return { endpoint: "http://127.0.0.1:45000", health: { ok: true, status: "ok" } };
    },
    async stop() { calls.push(["host.stop"]); },
  };
  const client = {
    async connect() { calls.push(["connect"]); },
    async initialize() { calls.push(["initialize"]); return { protocolVersion: 1, serverInfo: { version: "2.115.0" } }; },
    async getIdentityFingerprint() { calls.push(["identity"]); return identity; },
    async newSession(input) { calls.push(["session.new", input]); return { sessionId: "session-1", modelId: "auto" }; },
    async listModels(input) { calls.push(["models.list", input]); return { currentModelId: "hy4", models: [{ id: "hy4", name: "Hy4 preview" }] }; },
    async resumeSession(input) { calls.push(["session.resume", input]); return { sessionId: input.sessionId }; },
    async prompt(input) {
      calls.push(["prompt", { sessionId: input.sessionId, text: input.text }]);
      input.onNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: input.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } },
      });
      input.onNotification({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: input.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } } },
      });
      return { text: "Hello world", stopReason: "end_turn" };
    },
    async disconnect() { calls.push(["disconnect"]); },
    ...clientOverrides,
  };
  const adapter = createCodeBuddyRuntimeAdapter({
    config: {
      stateDir: path.dirname(sessionsFile),
      workspaceRoot: "D:\\CyberBoss",
      sessionsFile,
      randomUUID: () => "turn-1",
      ...configOverrides,
    },
    profile: profile(profileOverrides),
    secrets: { servicePassword: "gateway-secret" },
    locateDistribution: async () => ({
      source: "workbuddy-bundled",
      version: "2.115.0",
      command: "codebuddy.exe",
      argsPrefix: [],
    }),
    processHostFactory: () => host,
    clientFactory: () => client,
  });
  return { adapter, calls, client };
}

test("production adapter initializes, streams a turn, and persists the shared session binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-runtime-"));
  const sessionsFile = path.join(root, "sessions.json");
  const { adapter, calls } = createHarness({ sessionsFile });
  const events = [];
  adapter.onEvent((event) => events.push(event));

  const ready = await adapter.initialize();
  const turn = await adapter.sendTurn({
    bindingKey: "wechat:account:user",
    workspaceRoot: "D:\\CyberBoss",
    text: "hello",
    metadata: { accountId: "account" },
  });
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));

  assert.equal(ready.identityVerified, true);
  assert.deepEqual(turn, { threadId: "session-1", turnId: "turn-1" });
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.reply.delta",
    "runtime.reply.delta",
    "runtime.turn.completed",
  ]);
  assert.equal(events[2].payload.text, " world");
  assert.equal(events[3].payload.text, "Hello world");
  assert.equal(adapter.getSessionStore().getThreadIdForWorkspace("wechat:account:user", "D:\\CyberBoss"), "session-1");
  assert.equal(calls[0][1].model, "auto");
  assert.deepEqual(calls.slice(0, 5).map(([name]) => name), ["host.start", "connect", "initialize", "identity", "identity"]);
  await adapter.close();
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ["disconnect", "host.stop"]);
});

test("managed CodeBuddy ignores stale profile endpoints and reports the discovered host endpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-endpoint-"));
  const { adapter } = createHarness({
    sessionsFile: path.join(root, "sessions.json"),
    profileOverrides: {
      baseUrl: "http://127.0.0.1:44126",
      options: { endpoint: "http://127.0.0.1:44126" },
    },
  });
  const ready = await adapter.initialize();
  assert.equal(ready.endpoint, "http://127.0.0.1:45000");
  await adapter.close();
});

test("production adapter exposes discovery as a separate capability without requiring a verified profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-discovery-"));
  const { adapter, calls } = createHarness({
    sessionsFile: path.join(root, "sessions.json"),
  });
  const discovery = createCodeBuddyRuntimeAdapter({
    config: { stateDir: root, workspaceRoot: "D:\\CyberBoss", discoveryOnly: true },
    profile: profile({ capabilities: {} }),
    secrets: { servicePassword: "gateway-secret" },
    locateDistribution: async () => ({ source: "path", version: "2.115.0", command: "codebuddy.exe", argsPrefix: [] }),
    processHostFactory: () => ({
      async start(input) { calls.push(["discovery.start", input]); return { endpoint: "http://127.0.0.1:45000", health: { ok: true, status: "ok" } }; },
      async stop() { calls.push(["discovery.stop"]); },
    }),
    clientFactory: () => ({
      async connect() { calls.push(["discovery.connect"]); },
      async initialize() { calls.push(["discovery.initialize"]); return { protocolVersion: 1 }; },
      async getIdentityFingerprint() { calls.push(["discovery.identity"]); return IDENTITY; },
      async listModels(input) { calls.push(["discovery.models", input]); return { models: [{ id: "hy4", name: "Hy4 preview" }] }; },
      async disconnect() { calls.push(["discovery.disconnect"]); },
    }),
  });

  const result = await discovery.listModels();

  assert.deepEqual(result.models, [{ id: "hy4", name: "Hy4 preview" }]);
  assert.equal(result.source, "codebuddy-acp-session-new");
  assert.equal(calls.some(([name]) => name === "discovery.models"), true);
  await discovery.close();
});

test("one streamed CodeBuddy turn produces one aggregated WeChat delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-delivery-"));
  const sessionsFile = path.join(root, "sessions.json");
  const { adapter, calls } = createHarness({ sessionsFile });
  const sent = [];
  const delivery = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) { sent.push(payload); },
    },
    sessionStore: adapter.getSessionStore(),
    runtimeId: "codebuddy",
  });
  const events = [];
  adapter.onEvent((event) => {
    events.push(event);
    void delivery.handleRuntimeEvent(event);
  });

  const turn = await adapter.sendTurn({
    bindingKey: "wechat:account:user",
    workspaceRoot: "D:\\CyberBoss",
    text: "hello",
  });
  delivery.bindReplyTargetForTurn({
    threadId: turn.threadId,
    turnId: turn.turnId,
    target: { userId: "user", contextToken: "context", provider: "weixin" },
  });

  await waitFor(() => sent.length > 0);
  assert.equal(calls.filter(([name]) => name === "prompt").length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.reply.delta",
    "runtime.reply.delta",
    "runtime.turn.completed",
  ]);
  assert.deepEqual(sent, [{
    userId: "user",
    text: "Hello world",
    contextToken: "context",
  }]);
  await adapter.close();
});

test("production adapter reuses SessionStore and recreates only the affected binding after resume failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-resume-"));
  const sessionsFile = path.join(root, "sessions.json");
  const first = createHarness({ sessionsFile });
  await first.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "first" });
  await waitFor(() => first.calls.some(([name]) => name === "prompt"));
  await first.adapter.close();

  const resumed = createHarness({ sessionsFile });
  await resumed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "second" });
  await waitFor(() => resumed.calls.some(([name]) => name === "prompt"));
  assert.equal(resumed.calls.filter(([name]) => name === "session.resume").length, 1);
  assert.equal(resumed.calls.filter(([name]) => name === "session.new").length, 0);
  await resumed.adapter.close();

  const recreated = createHarness({
    sessionsFile,
    clientOverrides: {
      async resumeSession(input) {
        recreated.calls.push(["session.resume", input]);
        throw Object.assign(new Error("gone"), { code: "CODEBUDDY_SESSION_FAILED" });
      },
      async newSession(input) {
        recreated.calls.push(["session.new", input]);
        return { sessionId: "session-2", modelId: "auto" };
      },
    },
  });
  await recreated.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "third" });
  await waitFor(() => recreated.calls.some(([name]) => name === "prompt"));
  assert.equal(recreated.adapter.getSessionStore().getThreadIdForWorkspace("binding", "D:\\CyberBoss"), "session-2");
  assert.deepEqual(recreated.calls.filter(([name]) => name.startsWith("session.")).map(([name]) => name), [
    "session.resume", "session.new",
  ]);
  await recreated.adapter.close();
});

test("production adapter blocks a changed OS-user CodeBuddy identity and invalidates runtime profiles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-identity-"));
  const marked = [];
  const calls = [];
  const guarded = createCodeBuddyRuntimeAdapter({
    config: { stateDir: root, workspaceRoot: "D:\\CyberBoss", sessionsFile: path.join(root, "other.json") },
    profile: profile(),
    secrets: { servicePassword: "gateway-secret" },
    profileStore: { markRuntimeProfilesUnverified: (...args) => marked.push(args) },
    locateDistribution: async () => ({ source: "path", version: "2.115.0", command: "codebuddy.exe", argsPrefix: [] }),
    processHostFactory: () => ({ async start() { return { endpoint: "http://127.0.0.1:1", health: { ok: true } }; }, async stop() { calls.push(["guard.stop"]); } }),
    clientFactory: () => ({
      async connect() {},
      async initialize() { return { protocolVersion: 1 }; },
      async getIdentityFingerprint() { return "b".repeat(64); },
      async disconnect() {},
    }),
  });

  await assert.rejects(guarded.initialize(), (error) => error.code === "CODEBUDDY_LOGIN_REQUIRED");
  assert.deepEqual(marked, [["codebuddy", "account_identity_changed"]]);
  await guarded.close();
  assert.equal(calls.some(([name]) => name === "guard.stop"), true);
});

test("supervisor CodeBuddy denies permission requests without emitting an approvable event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-approval-"));
  const sessionsFile = path.join(root, "sessions.json");
  const { adapter, calls } = createHarness({
    sessionsFile,
    clientOverrides: {
      async prompt(input) {
        input.onRequest({
          jsonrpc: "2.0",
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId: input.sessionId,
            toolCall: { title: "Run command", rawInput: { command: ["node", "build.js"] } },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "allow-always", kind: "allow_always" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        input.onNotification({
          method: "session/update",
          params: { sessionId: input.sessionId, update: { sessionUpdate: "usage_update", used: 32, size: 100 } },
        });
        return {
          text: "done",
          stopReason: "end_turn",
          usage: { inputTokens: 12, outputTokens: 5, workbuddyPromotion: "not interpreted" },
        };
      },
      async respondPermission(input) { calls.push(["permission.response", input]); },
    },
  });
  const events = [];
  adapter.onEvent((event) => events.push(event));

  await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "run" });
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));
  const approval = events.find((event) => event.type === "runtime.approval.requested");
  const denied = events.find((event) => event.type === "runtime.approval.denied");
  const context = events.find((event) => event.type === "runtime.context.updated");
  const completed = events.find((event) => event.type === "runtime.turn.completed");
  assert.equal(approval, undefined);
  assert.equal(denied.payload.requestId, "permission-1");
  assert.equal(denied.payload.code, "CODEBUDDY_CAPABILITY_DENIED");
  assert.equal(context.payload.currentTokens, 32);
  assert.deepEqual(completed.payload.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(completed.payload.vendorUsage.workbuddyPromotion, "not interpreted");

  await waitFor(() => calls.some(([name]) => name === "permission.response"));
  assert.equal(calls.find(([name]) => name === "permission.response")[1].outcome, "reject");
  const start = calls.find(([name]) => name === "host.start")[1];
  assert.deepEqual(start.allowedTools, ["mcp__cyberboss_supervisor__disabled"]);
  await adapter.close();
});

test("developer CodeBuddy keeps explicit approval handling available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-developer-"));
  const { adapter, calls } = createHarness({
    sessionsFile: path.join(root, "sessions.json"),
    configOverrides: { codebuddyCapabilityMode: "developer" },
    clientOverrides: {
      async prompt(input) {
        input.onRequest({
          id: "permission-dev",
          method: "session/request_permission",
          params: {
            sessionId: input.sessionId,
            toolCall: { title: "Run command", rawInput: { command: ["node", "build.js"] } },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "allow-always", kind: "allow_always" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return { text: "done", stopReason: "end_turn" };
      },
      async respondPermission(input) { calls.push(["permission.response", input]); },
    },
  });
  const events = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.sendTurn({ bindingKey: "developer", workspaceRoot: "D:\\CyberBoss", text: "run" });
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));
  const approval = events.find((event) => event.type === "runtime.approval.requested");
  assert.equal(approval.payload.requestId, "permission-dev");
  await adapter.respondApproval({ requestId: "permission-dev", decision: "accept", result: { remember: true } });
  assert.equal(calls.find(([name]) => name === "permission.response")[1].outcome, "allow-always");
  assert.equal(calls.find(([name]) => name === "host.start")[1].allowedTools, null);
  await adapter.close();
});

test("CodeBuddy compaction remains unsupported unless an explicit client capability is present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-compact-"));
  const sessionsFile = path.join(root, "sessions.json");
  const calls = [];
  const { adapter } = createHarness({
    sessionsFile,
    clientOverrides: {
      async initialize() { return { protocolVersion: 1, agentCapabilities: { sessionCompaction: true } }; },
      async compactSession(input) { calls.push(input); return { compacted: true }; },
    },
  });
  await adapter.initialize();
  const result = await adapter.compactThread({ threadId: "session-1", workspaceRoot: "D:\\CyberBoss" });
  assert.deepEqual(result, { threadId: "session-1", compacted: true });
  assert.equal(calls.length, 1);
  await adapter.close();

  const unsupported = createHarness({ sessionsFile: path.join(root, "unsupported.json") });
  await assert.rejects(
    unsupported.adapter.compactThread({ threadId: "session-1", workspaceRoot: "D:\\CyberBoss" }),
    (error) => error.code === "CODEBUDDY_COMPACTION_UNSUPPORTED",
  );
  await unsupported.adapter.close();
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
}
