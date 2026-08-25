"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConversationStore } = require("../src/adapters/runtime/api/conversation-store");
const { RuntimeToolBridge } = require("../src/adapters/runtime/api/tool-bridge");
const { runAgentTurn } = require("../src/adapters/runtime/api/agent-loop");
const { createApiRuntimeAdapter } = require("../src/adapters/runtime/api");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-api-agent-test-"));
}

function scope() {
  return {
    runtimeId: "builtin-api",
    profileId: "profile-1",
    modelId: "synthetic-model",
    secretGeneration: 3,
  };
}

function createConversation(filePath, threadId = "thread-1") {
  const store = new ConversationStore({ filePath, randomUUID: () => "turn-1" });
  const turn = store.beginTurn(scope(), { role: "user", content: "use the echo tool" }, { conversationId: threadId });
  return {
    store,
    scope: scope(),
    threadId,
    turnId: turn.id,
    messages: [{ role: "user", content: "use the echo tool" }],
    appendAssistant(message) {
      store.commitAssistant(turn.id, message);
    },
    appendToolResult(message) {
      store.commitToolResult(turn.id, message, { continueTurn: true });
    },
    abort() {
      store.abortTurn(turn.id);
    },
  };
}

function echoToolHost({ approval = "auto", result } = {}) {
  const invocations = [];
  return {
    invocations,
    listTools() {
      return [{
        name: "echo",
        description: "Echo text.",
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
          additionalProperties: false,
        },
        approval,
        internalApprovalMetadata: { source: "must-not-leak" },
      }];
    },
    getToolApproval() {
      return approval;
    },
    async invokeTool(name, args, context) {
      invocations.push({ name, args, context });
      return result === undefined ? { text: args.text } : result;
    },
  };
}

function twoStepToolClient() {
  let step = 0;
  return {
    async streamTurn({ messages, tools, onDelta }) {
      step += 1;
      assert.equal(tools[0].name, "echo");
      if (step === 1) {
        onDelta("working");
        return {
          message: { role: "assistant", content: "working" },
          toolCalls: [{ id: "call-1", name: "echo", arguments: { text: "hello" } }],
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      }
      assert.equal(messages.at(-1).role, "tool");
      onDelta("finished");
      return {
        message: { role: "assistant", content: "finished" },
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    },
  };
}

test("agent loop commits every assistant/tool step and emits normalized lifecycle events", async () => {
  const filePath = path.join(makeStateDir(), "conversations.json");
  const conversation = createConversation(filePath);
  const events = [];
  const result = await runAgentTurn({
    client: twoStepToolClient(),
    conversation,
    toolBridge: new RuntimeToolBridge({ projectToolHost: echoToolHost() }),
    emit: (event) => events.push(event),
    limits: { maxToolSteps: 8, timeoutMs: 60_000 },
  });

  assert.equal(result.text, "finished");
  assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 3 });
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.reply.delta",
    "runtime.reply.delta",
    "runtime.reply.completed",
    "runtime.turn.completed",
  ]);

  assert.equal(fs.existsSync(filePath), true);
  const reopened = new ConversationStore({ filePath });
  assert.deepEqual(
    reopened.resume(scope(), { conversationId: "thread-1" }).messages.map((message) => message.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(
    reopened.resume(scope(), { conversationId: "thread-1" }).messages.map((message) => (
      typeof message.content === "string" ? message.content : message.content?.[0]?.text
    )),
    ["use the echo tool", "working", '{"text":"hello"}', "finished"],
  );
});

test("agent loop aborts before a ninth tool step", async () => {
  let callId = 0;
  const conversation = createConversation(path.join(makeStateDir(), "conversations.json"));
  const client = {
    async streamTurn() {
      callId += 1;
      return {
        message: { role: "assistant", content: "" },
        toolCalls: [{ id: `call-${callId}`, name: "echo", arguments: { text: String(callId) } }],
      };
    },
  };

  await assert.rejects(
    runAgentTurn({
      client,
      conversation,
      toolBridge: new RuntimeToolBridge({ projectToolHost: echoToolHost() }),
      limits: { maxToolSteps: 8, timeoutMs: 60_000 },
    }),
    (error) => error.code === "TOOL_STEP_LIMIT",
  );
  assert.equal(callId, 9);
  assert.equal(conversation.store.resume(scope(), { conversationId: "thread-1" }).abortedTurns[0].status, "aborted");
});

test("agent loop enforces one overall timeout and aborts persisted state", async () => {
  const conversation = createConversation(path.join(makeStateDir(), "conversations.json"));
  const events = [];
  const client = {
    streamTurn({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    },
  };

  await assert.rejects(
    runAgentTurn({
      client,
      conversation,
      toolBridge: new RuntimeToolBridge({ projectToolHost: echoToolHost() }),
      emit: (event) => events.push(event),
      limits: { maxToolSteps: 8, timeoutMs: 20 },
    }),
    (error) => error.code === "AGENT_TURN_TIMEOUT",
  );
  assert.deepEqual(events.map((event) => event.type), ["runtime.turn.started", "runtime.turn.failed"]);
  assert.equal(conversation.store.resume(scope(), { conversationId: "thread-1" }).abortedTurns[0].status, "aborted");
});

test("tool bridge hides approval metadata, validates schemas, and bounds serialized results", async () => {
  let approvals = 0;
  const nativeHost = echoToolHost({ approval: "auto" });
  const nativeBridge = new RuntimeToolBridge({
    projectToolHost: nativeHost,
    requestApproval: async () => { approvals += 1; return { decision: "accept" }; },
  });
  assert.deepEqual(Object.keys(nativeBridge.listTools()[0]).sort(), ["description", "inputSchema", "name"]);
  assert.equal(JSON.stringify(nativeBridge.listTools()).includes("approval"), false);
  await nativeBridge.invoke({ call: { id: "call-1", name: "echo", arguments: { text: "ok" } } });
  assert.equal(approvals, 0);

  await assert.rejects(
    nativeBridge.invoke({ call: { id: "call-2", name: "echo", arguments: { text: 42 } } }),
    (error) => error.code === "TOOL_INPUT_INVALID",
  );

  const oversizedBridge = new RuntimeToolBridge({
    projectToolHost: echoToolHost({ result: { text: "x".repeat(256 * 1024) } }),
    maxResultBytes: 1024 * 1024,
  });
  await assert.rejects(
    oversizedBridge.invoke({ call: { id: "call-3", name: "echo", arguments: { text: "ok" } } }),
    (error) => error.code === "TOOL_RESULT_TOO_LARGE",
  );
});

test("approval ask waits for matching requestId and abort rejects all pending approvals", async () => {
  const stateDir = makeStateDir();
  const host = echoToolHost({ approval: "ask" });
  const events = [];
  const adapter = createApiRuntimeAdapter({
    config: {
      stateDir,
      sessionsFile: path.join(stateDir, "sessions.json"),
      apiConversationsFile: path.join(stateDir, "conversations.json"),
      protocolClient: twoStepToolClient(),
      randomUUID: (() => {
        const values = ["thread-1", "approval-1"];
        return () => values.shift() || "fallback-id";
      })(),
    },
    profile: {
      ...scope(),
      id: "profile-1",
      status: "verified",
      providerId: "synthetic",
      modelId: "synthetic-model",
      capabilities: { imageInput: true },
    },
    secrets: {},
    projectToolHost: host,
    profileStore: { markUnverified() {} },
  });
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.sendTurn({
    bindingKey: "workspace:account:sender",
    workspaceRoot: stateDir,
    text: "echo",
  });
  await waitFor(() => events.some((event) => event.type === "runtime.approval.requested"));
  assert.equal(host.invocations.length, 0);
  assert.equal(events.find((event) => event.type === "runtime.approval.requested").payload.requestId, "approval-1");

  await assert.rejects(
    adapter.respondApproval({ requestId: "wrong-id", decision: "accept" }),
    (error) => error.code === "APPROVAL_NOT_FOUND",
  );
  await adapter.respondApproval({ requestId: "approval-1", decision: "accept" });
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));
  assert.equal(host.invocations.length, 1);

  const secondEvents = [];
  const secondHost = echoToolHost({ approval: "ask" });
  const secondStateDir = makeStateDir();
  const second = createApiRuntimeAdapter({
    config: {
      stateDir: secondStateDir,
      protocolClient: twoStepToolClient(),
      randomUUID: (() => {
        const values = ["thread-2", "approval-2"];
        return () => values.shift() || "fallback-id-2";
      })(),
    },
    profile: {
      ...scope(), id: "profile-1", status: "verified", providerId: "synthetic", modelId: "synthetic-model",
    },
    projectToolHost: secondHost,
    profileStore: { markUnverified() {} },
  });
  second.onEvent((event) => secondEvents.push(event));
  const secondTurn = await second.sendTurn({ bindingKey: "b", workspaceRoot: stateDir, text: "echo" });
  await waitFor(() => secondEvents.some((event) => event.type === "runtime.approval.requested"));
  await second.cancelTurn(secondTurn);
  await waitFor(() => secondEvents.some((event) => event.type === "runtime.turn.failed"));
  assert.equal(secondHost.invocations.length, 0);
  const reopened = new ConversationStore({ filePath: path.join(secondStateDir, "api-conversations.json") });
  assert.equal(reopened.resume(scope(), { conversationId: secondTurn.threadId }).abortedTurns[0].status, "aborted");
  await assert.rejects(second.respondApproval({ requestId: "approval-2", decision: "accept" }), /APPROVAL_NOT_FOUND/);
});

test("definitive authentication failure marks the profile unverified before turn.failed", async () => {
  const stateDir = makeStateDir();
  const ordering = [];
  let clientCalls = 0;
  const adapter = createApiRuntimeAdapter({
    config: {
      stateDir,
      protocolClient: {
        async streamTurn() {
          clientCalls += 1;
          throw Object.assign(new Error("denied"), { code: "INVALID_CREDENTIALS", status: 401 });
        },
      },
      randomUUID: () => "thread-auth",
    },
    profile: {
      ...scope(), id: "profile-1", status: "verified", providerId: "synthetic", modelId: "synthetic-model",
    },
    projectToolHost: echoToolHost(),
    profileStore: {
      markUnverified(profileId, reason) {
        ordering.push(`unverified:${profileId}:${reason}`);
      },
    },
  });
  adapter.onEvent((event) => {
    if (event.type === "runtime.turn.failed") ordering.push("failed");
  });
  await adapter.sendTurn({ bindingKey: "b", workspaceRoot: stateDir, text: "hello" });
  await waitFor(() => ordering.includes("failed"));
  assert.deepEqual(ordering, ["unverified:profile-1:invalid_credentials", "failed"]);
  await assert.rejects(
    adapter.sendTurn({ bindingKey: "b", workspaceRoot: stateDir, text: "must not reach client" }),
    (error) => error.code === "INVALID_CREDENTIALS" || error.code === "PROFILE_NOT_VERIFIED",
  );
  await assert.rejects(
    adapter.initialize(),
    (error) => error.code === "INVALID_CREDENTIALS" || error.code === "PROFILE_NOT_VERIFIED",
  );
  assert.equal(clientCalls, 1);
});

test("adapter exposes the full runtime contract and exact profile capabilities", () => {
  const stateDir = makeStateDir();
  const adapter = createApiRuntimeAdapter({
    config: { stateDir, protocolClient: twoStepToolClient() },
    profile: {
      ...scope(), id: "profile-1", status: "verified", providerId: "synthetic", modelId: "synthetic-model",
      capabilities: { imageInput: true },
    },
    projectToolHost: echoToolHost(),
    profileStore: { markUnverified() {} },
  });
  for (const method of [
    "describe", "onEvent", "getSessionStore", "getTurnCapabilities", "initialize", "close", "sendTurn",
    "sendTextTurn", "cancelTurn", "respondApproval", "resumeThread", "compactThread", "startFreshThreadDraft",
  ]) {
    assert.equal(typeof adapter[method], "function", method);
  }
  assert.deepEqual(adapter.describe(), {
    id: "builtin-api", profileId: "profile-1", model: "synthetic-model", provider: "synthetic",
  });
  assert.deepEqual(adapter.getTurnCapabilities(), { nativeImageInput: true, toolImageRead: false });
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
