"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ProviderProfileStore } = require("../src/core/provider-profile-store");
const {
  ECHO_TOOL_NAME,
  GLOB_TOOL_NAME,
  RuntimeProfileVerifier,
} = require("../src/desktop/runtime-profile-verifier");
const { createVerificationToolHost } = require("../src/desktop/runtime-verification-mcp-server");

function makeProfile(runtimeId, profileStore) {
  return profileStore.upsertDraft({
    id: `profile-${runtimeId}`,
    name: runtimeId,
    runtimeId,
    ownershipMode: runtimeId === "opencode" ? "external" : "",
    providerId: runtimeId === "opencode" ? "synthetic" : "compatibility",
    protocolId: "",
    baseUrl: runtimeId === "opencode" ? "https://opencode.invalid" : "",
    modelId: "synthetic-model",
    secretRefs: {},
  });
}

function makeHarness(runtimeId, behavior = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-verifier-test-"));
  const profileStore = new ProviderProfileStore({
    stateDir,
    now: () => new Date("2026-08-25T03:00:00.000Z"),
  });
  const profile = makeProfile(runtimeId, profileStore);
  let generation = 1;
  const credentialVault = {
    getGeneration: () => generation,
    read: async () => ({ servicePassword: "not-returned" }),
  };
  const adapters = [];
  const approvals = [];
  const adapterFactory = ({ verification }) => {
    let listener = () => {};
    let turnCount = 0;
    const expectedTool = runtimeId === "opencode" ? GLOB_TOOL_NAME : ECHO_TOOL_NAME;
    const adapter = {
      verification,
      onEvent(callback) {
        listener = callback;
        return () => { listener = () => {}; };
      },
      async initialize() {
        if (behavior.authError) throw Object.assign(new Error("rejected"), behavior.authError);
        return { models: [{ id: profile.modelId }] };
      },
      async sendTurn() {
        turnCount += 1;
        const currentTurn = turnCount;
        const turn = { threadId: `thread-${currentTurn}`, turnId: `turn-${currentTurn}` };
        queueMicrotask(() => {
          listener({ type: "runtime.turn.started", payload: turn });
          if (currentTurn === 1) {
            if (behavior.foreignEvents) {
              const foreign = { threadId: "foreign-thread", turnId: "foreign-turn" };
              listener({
                type: "runtime.approval.requested",
                payload: { ...foreign, requestId: "foreign-approval", toolName: "write_file", commandTokens: ["write_file"] },
              });
              listener({ type: "runtime.tool.started", payload: { ...foreign, toolCallId: "foreign-tool", toolName: expectedTool } });
              listener({ type: "runtime.tool.completed", payload: { ...foreign, toolCallId: "foreign-tool", toolName: expectedTool, isError: false } });
              listener({ type: "runtime.reply.delta", payload: { ...foreign, text: "foreign continuation" } });
              listener({ type: "runtime.turn.completed", payload: foreign });
              const otherTurn = { threadId: turn.threadId, turnId: "other-turn" };
              listener({
                type: "runtime.approval.requested",
                payload: { ...otherTurn, requestId: "other-turn-approval", toolName: "write_file", commandTokens: ["write_file"] },
              });
              listener({ type: "runtime.tool.started", payload: { ...otherTurn, toolCallId: "other-tool", toolName: expectedTool } });
              listener({ type: "runtime.tool.completed", payload: { ...otherTurn, toolCallId: "other-tool", toolName: expectedTool, isError: false } });
              listener({ type: "runtime.reply.delta", payload: { ...otherTurn, text: "other-turn continuation" } });
              listener({ type: "runtime.turn.completed", payload: otherTurn });
            }
            if (behavior.unsafeApproval) {
              listener({
                type: "runtime.approval.requested",
                payload: { ...turn, requestId: "unsafe-1", toolName: "write_file", commandTokens: ["write_file"] },
              });
            }
            if (!behavior.omitTool) {
              listener({
                type: "runtime.tool.started",
                payload: { ...turn, toolCallId: "tool-1", toolName: expectedTool },
              });
              listener({
                type: "runtime.tool.completed",
                payload: { ...turn, toolCallId: "tool-1", toolName: expectedTool, isError: false },
              });
            }
            if (behavior.emptyIdTool) {
              listener({
                type: "runtime.tool.started",
                payload: { threadId: "", turnId: "", toolCallId: "empty-tool", toolName: expectedTool },
              });
              listener({
                type: "runtime.tool.completed",
                payload: { threadId: "", turnId: "", toolCallId: "empty-tool", toolName: expectedTool, isError: false },
              });
            }
            if (!behavior.omitContinuation) {
              listener({ type: "runtime.reply.delta", payload: { ...turn, text: "verified" } });
            }
            listener({
              type: "runtime.turn.completed",
              payload: behavior.emptyTerminalTurnId ? { threadId: turn.threadId, turnId: "" } : turn,
            });
          } else if (behavior.cancellationApproval) {
            listener({
              type: "runtime.approval.requested",
              payload: { ...turn, requestId: "cancel-approval", toolName: expectedTool, commandTokens: [expectedTool] },
            });
          }
        });
        return turn;
      },
      async cancelTurn(turn) {
        if (!behavior.omitCancellation) {
          queueMicrotask(() => listener({
            type: "runtime.turn.failed",
            payload: { ...turn, code: "CANCELLED", text: "cancelled" },
          }));
        }
        return turn;
      },
      async respondApproval(response) {
        approvals.push(response);
        return response;
      },
      async close() {},
    };
    adapters.push(adapter);
    return adapter;
  };
  const verifier = new RuntimeProfileVerifier({
    profileStore,
    credentialVault,
    adapterFactory,
    stateDir,
    eventTimeoutMs: 75,
    now: () => new Date("2026-08-25T03:00:00.000Z"),
  });
  return {
    adapters,
    approvals,
    credentialVault,
    profile,
    profileStore,
    verifier,
    bumpGeneration: () => { generation += 1; },
  };
}

for (const runtimeId of ["opencode", "codex", "claudecode"]) {
  test(`${runtimeId} requires a live normalized tool/stream/cancellation evidence chain`, async () => {
    const harness = makeHarness(runtimeId);
    const result = await harness.verifier.verify(harness.profile.id);

    assert.equal(result.ok, true);
    assert.deepEqual(result.capabilities, {
      authentication: true,
      modelAccess: true,
      streaming: true,
      tools: true,
      toolContinuation: true,
      cancellation: true,
      imageInput: false,
    });
    assert.equal(harness.profileStore.get(harness.profile.id).status, "verified");
    assert.equal(harness.adapters[0].verification.toolName, runtimeId === "opencode" ? GLOB_TOOL_NAME : ECHO_TOOL_NAME);
    assert.equal(harness.adapters[0].verification.readOnly, true);
  });
}

test("missing native tool evidence fails closed and leaves the profile draft", async () => {
  const harness = makeHarness("codex", { omitTool: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_CALLING_UNSUPPORTED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("missing streamed continuation after tool completion fails closed", async () => {
  const harness = makeHarness("claudecode", { omitContinuation: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_CONTINUATION_UNSUPPORTED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("cancellation must be acknowledged by a normalized cancellation event", async () => {
  const harness = makeHarness("opencode", { omitCancellation: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CANCELLATION_UNSUPPORTED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("a secret-generation race cannot mark the candidate verified", async () => {
  const harness = makeHarness("codex");
  const originalFactory = harness.verifier.adapterFactory;
  harness.verifier.adapterFactory = (options) => {
    const adapter = originalFactory(options);
    const originalCancel = adapter.cancelTurn;
    adapter.cancelTurn = async (turn) => {
      harness.bumpGeneration();
      return originalCancel(turn);
    };
    return adapter;
  };
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CREDENTIAL_CHANGED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("a covered profile-field race cannot mark the candidate verified", async () => {
  const harness = makeHarness("claudecode");
  const originalFactory = harness.verifier.adapterFactory;
  harness.verifier.adapterFactory = (options) => {
    const adapter = originalFactory(options);
    const originalCancel = adapter.cancelTurn;
    adapter.cancelTurn = async (turn) => {
      harness.profileStore.upsertDraft({ ...harness.profileStore.get(harness.profile.id), modelId: "changed-model" });
      return originalCancel(turn);
    };
    return adapter;
  };
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROFILE_CHANGED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("401, 403, and ProviderAuthError invalidate credentials; other failures stay draft", async (t) => {
  for (const authError of [
    { status: 401 },
    { statusCode: 403 },
    { name: "ProviderAuthError" },
  ]) {
    await t.test(JSON.stringify(authError), async () => {
      const harness = makeHarness("claudecode", { authError });
      harness.profileStore.markVerified(harness.profile.id, { secretGeneration: 1, capabilities: { tools: true } });
      const result = await harness.verifier.verify(harness.profile.id);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_CREDENTIALS");
      assert.equal(harness.profileStore.get(harness.profile.id).status, "unverified");
    });
  }

  const transient = makeHarness("codex", { authError: { code: "MODEL_SERVICE_TIMEOUT" } });
  const result = await transient.verifier.verify(transient.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MODEL_SERVICE_TIMEOUT");
  assert.equal(transient.profileStore.get(transient.profile.id).status, "draft");
});

test("unknown approval requests are declined and cannot satisfy tool evidence", async () => {
  const harness = makeHarness("opencode", { omitTool: true, unsafeApproval: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNSAFE_TOOL_REQUESTED");
  assert.equal(harness.approvals.some((entry) => entry.decision === "decline"), true);
});

test("shared runtime events from another thread are ignored and never receive an approval response", async () => {
  const harness = makeHarness("opencode", { foreignEvents: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.approvals, []);
});

test("tool evidence with empty thread and turn IDs cannot satisfy the current probe", async () => {
  const harness = makeHarness("codex", { omitTool: true, emptyIdTool: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_CALLING_UNSUPPORTED");
});

test("an official same-thread terminal may omit turnId without weakening tool evidence", async () => {
  const harness = makeHarness("opencode", { emptyTerminalTurnId: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, true);
});

test("a matching cancellation-probe approval is declined and fails verification", async () => {
  const harness = makeHarness("claudecode", { cancellationApproval: true });
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNSAFE_TOOL_REQUESTED");
  assert.deepEqual(harness.approvals.map((entry) => ({ requestId: entry.requestId, decision: entry.decision })), [
    { requestId: "cancel-approval", decision: "decline" },
  ]);
});

test("the dedicated verification MCP tool is side-effect-free and token bound", async () => {
  const host = createVerificationToolHost({ token: "verification_token_123" });
  assert.deepEqual(host.listTools().map((tool) => tool.name), [ECHO_TOOL_NAME]);
  assert.deepEqual(
    await host.invokeTool(ECHO_TOOL_NAME, { value: "verification_token_123" }),
    { text: "verification_token_123" },
  );
  await assert.rejects(host.invokeTool(ECHO_TOOL_NAME, { value: "wrong-token" }), /did not match/);
  await assert.rejects(host.invokeTool("write_file", {}), /Unknown verification tool/);
});

test("the production MCP entrypoint can be opened and called over stdio", async (t) => {
  const script = path.join(__dirname, "..", "src", "desktop", "runtime-verification-mcp-server.js");
  assert.equal(fs.existsSync(script), true);
  const child = spawn(process.execPath, [script, "--token", "verification_token_456"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const response = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("verification MCP response timed out")), 2_000);
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: ECHO_TOOL_NAME, arguments: { value: "verification_token_456" } },
  })}\n`);
  const message = await response;
  assert.equal(message.id, 1);
  assert.equal(message.result.content[0].text, "verification_token_456");
  child.stdin.end();
});
