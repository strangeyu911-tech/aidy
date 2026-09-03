"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ComponentLogger } = require("../src/core/component-logger");
const { CodeBuddyClient } = require("../src/adapters/runtime/codebuddy/client");
const { createCodeBuddyRuntimeAdapter } = require("../src/adapters/runtime/codebuddy");

const IDENTITY = "a".repeat(64);

function createHarness({ root, clientOverrides = {}, sessionId = "session-1" } = {}) {
  const sessionsFile = path.join(root, "sessions.json");
  const logger = new ComponentLogger({ logDir: path.join(root, "logs"), component: "bridge" });
  const calls = [];
  const client = {
    async connect() { calls.push("connect"); },
    async initialize() { calls.push("initialize"); return { protocolVersion: 1 }; },
    async getIdentityFingerprint() { calls.push("identity"); return IDENTITY; },
    async newSession(input) { calls.push(["new", input]); return { sessionId, modelId: "auto" }; },
    async resumeSession(input) { calls.push(["resume", input]); return { sessionId: input.sessionId }; },
    async prompt() { calls.push("prompt"); return { text: "reply", stopReason: "end_turn" }; },
    async disconnect() {},
    ...clientOverrides,
  };
  const adapter = createCodeBuddyRuntimeAdapter({
    config: {
      stateDir: root,
      workspaceRoot: "D:\\CyberBoss",
      sessionsFile,
      randomUUID: () => "turn-1",
      logger,
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
    clientFactory: () => client,
  });
  return { adapter, calls, logger, logDir: path.join(root, "logs"), sessionsFile };
}

function readRecords(logDir) {
  const filePath = path.join(logDir, "bridge.jsonl");
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
}

function errorWithDiagnostic(code, message) {
  return Object.assign(new Error("private inbound text must not be persisted"), {
    code: "CODEBUDDY_SESSION_FAILED",
    diagnostic: { method: code, upstreamCode: -32602, upstreamMessage: message },
  });
}

test("new attach persists a correlation trace through runtime.turn.started", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-new-"));
  const { adapter, logDir } = createHarness({ root });
  await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "hello", turnCorrelation: "corr-new" });
  await adapter.close();

  const records = readRecords(logDir);
  const relevant = records.filter((record) => record.data.turnCorrelation === "corr-new");
  assert.deepEqual(relevant.map((record) => record.event), [
    "runtime.dispatch.started",
    "runtime.session_attach.started",
    "runtime.session_attach.decision",
    "runtime.session_attach.succeeded",
    "runtime.turn.started",
    "runtime.turn.completed",
  ]);
  assert.equal(relevant.find((record) => record.event === "runtime.session_attach.decision").data.attachDecision, "new");
  assert.equal(relevant.find((record) => record.event === "runtime.session_attach.succeeded").data.sessionId, "session-1");
  assert.equal(JSON.stringify(records).includes("hello"), false);
});

test("resume attach records the persisted-session decision and session ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-resume-"));
  const first = createHarness({ root });
  await first.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "first", turnCorrelation: "corr-first" });
  await first.adapter.close();

  const resumed = createHarness({ root });
  await resumed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "second", turnCorrelation: "corr-resume" });
  await resumed.adapter.close();

  const records = readRecords(resumed.logDir).filter((record) => record.data.turnCorrelation === "corr-resume");
  const decision = records.find((record) => record.event === "runtime.session_attach.decision");
  const success = records.find((record) => record.event === "runtime.session_attach.succeeded");
  assert.equal(decision.data.attachDecision, "resume");
  assert.equal(decision.data.hasPersistedSessionId, true);
  assert.equal(success.data.sessionId, "session-1");
  assert.equal(resumed.calls.filter((call) => call[0] === "resume").length, 1);
  assert.equal(resumed.calls.some((call) => call[0] === "new"), false);
});

test("session/new errors persist structured diagnostics and preserve rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-new-error-"));
  const { adapter, logDir } = createHarness({
    root,
    clientOverrides: { async newSession() { throw errorWithDiagnostic("session/new", "Invalid params: expected cwd"); } },
  });
  await assert.rejects(
    adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "hello", turnCorrelation: "corr-new-error" }),
    (error) => error.code === "CODEBUDDY_SESSION_FAILED",
  );
  await adapter.close();

  const records = readRecords(logDir).filter((record) => record.data.turnCorrelation === "corr-new-error");
  const failure = records.find((record) => record.event === "runtime.session_attach.failed");
  assert.equal(failure.data.attachDecision, "new");
  assert.deepEqual(failure.data.error, { class: "Error", code: -32602, detail: "Invalid params: expected cwd" });
  assert.equal(records.some((record) => record.event === "runtime.turn.started"), false);
});

test("session/resume errors are recorded while existing fallback semantics remain intact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-resume-error-"));
  const first = createHarness({ root });
  await first.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "first", turnCorrelation: "corr-seed" });
  await first.adapter.close();
  const resumed = createHarness({
    root,
    clientOverrides: {
      async resumeSession() { throw errorWithDiagnostic("session/resume", "session is unavailable"); },
    },
  });
  await resumed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "second", turnCorrelation: "corr-resume-error" });
  await resumed.adapter.close();

  const records = readRecords(resumed.logDir).filter((record) => record.data.turnCorrelation === "corr-resume-error");
  const failure = records.find((record) => record.event === "runtime.session_attach.failed");
  assert.equal(failure.data.phase, "resume");
  assert.equal(failure.data.error.code, -32602);
  assert.equal(records.some((record) => record.event === "runtime.session_attach.succeeded" && record.data.phase === "new"), true);
  assert.equal(resumed.calls.some((call) => call[0] === "new"), true);
});

test("early pre-attach errors are persisted without changing exception propagation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-early-error-"));
  const { adapter, logDir } = createHarness({
    root,
    clientOverrides: { async getIdentityFingerprint() { throw new Error("private inbound text must not be persisted"); } },
  });
  await assert.rejects(
    adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "private inbound text", turnCorrelation: "corr-early" }),
    /private inbound text/,
  );
  await adapter.close();

  const records = readRecords(logDir).filter((record) => record.data.turnCorrelation === "corr-early");
  const failure = records.find((record) => record.event === "runtime.dispatch.failed");
  assert.equal(failure.data.phase, "initialize");
  assert.equal(records.some((record) => record.event === "runtime.session_attach.started"), false);
  assert.equal(JSON.stringify(records).includes("private inbound text"), false);
});

test("low-level ACP structured errors are persisted without credentials or prompt bodies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-client-error-"));
  const logger = new ComponentLogger({ logDir: path.join(root, "logs"), component: "bridge" });
  const responses = [
    { ok: true, status: 200, async text() { return JSON.stringify({ connectionId: "c", sessionToken: "credential-token" }); } },
    { ok: true, status: 200, async text() { return ["data: {\"jsonrpc\":\"2.0\",\"id\":\"rpc-1\",\"error\":{\"code\":-32602,\"message\":\"Invalid params: expected cwd\"}}", ""].join("\n"); } },
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:45000",
    servicePassword: "credential-token",
    logger,
    randomUUID: () => "rpc-1",
    fetchImpl: async () => responses.shift(),
  });
  await client.connect();
  await assert.rejects(client.newSession({
    workingDirectory: "D:\\CyberBoss",
    observability: { turnCorrelation: "corr-client", attachDecision: "new", phase: "new" },
  }));

  const records = readRecords(path.join(root, "logs"));
  const failure = records.find((record) => record.event === "runtime.acp.response.error");
  assert.equal(failure.data.error.code, -32602);
  assert.equal(failure.data.error.detail, "Invalid params: expected cwd");
  assert.equal(JSON.stringify(records).includes("credential-token"), false);
  assert.equal(JSON.stringify(records).includes("private inbound text"), false);
});

test("low-level ACP successful session/new records transport status and session ID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-attach-client-success-"));
  const logger = new ComponentLogger({ logDir: path.join(root, "logs"), component: "bridge" });
  const responses = [
    { ok: true, status: 200, async text() { return JSON.stringify({ connectionId: "c", sessionToken: "credential-token" }); } },
    { ok: true, status: 200, async text() { return ["data: {\"jsonrpc\":\"2.0\",\"id\":\"rpc-1\",\"result\":{\"sessionId\":\"session-1\"}}", ""].join("\n"); } },
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:45000",
    servicePassword: "credential-token",
    logger,
    randomUUID: () => "rpc-1",
    fetchImpl: async () => responses.shift(),
  });
  await client.connect();
  await client.newSession({
    workingDirectory: "D:\\CyberBoss",
    observability: { turnCorrelation: "corr-client-success", attachDecision: "new", phase: "new" },
  });

  const records = readRecords(path.join(root, "logs"));
  const started = records.find((record) => record.event === "runtime.acp.request.started");
  const succeeded = records.find((record) => record.event === "runtime.acp.response.succeeded");
  assert.equal(started.data.method, "session/new");
  assert.equal(succeeded.data.transport.status, 200);
  assert.equal(succeeded.data.sessionId, "session-1");
});

test("session/prompt records fetch, headers, SSE, terminal, and abort-safe metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-prompt-wire-"));
  const logger = new ComponentLogger({ logDir: path.join(root, "logs"), component: "bridge" });
  const responses = [
    { ok: true, status: 200, async text() { return JSON.stringify({ connectionId: "connection-secret", sessionToken: "credential-token" }); } },
    {
      ok: true,
      status: 200,
      headers: { get(name) { return name === "content-type" ? "text/event-stream" : ""; } },
      async text() {
        return [
          "data: {\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\"}}}",
          "",
          "data: {\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_thought_chunk\"}}}",
          "",
          "data: {\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"tool_call\"}}}",
          "",
          "data: {\"jsonrpc\":\"2.0\",\"id\":\"rpc-prompt\",\"result\":{\"stopReason\":\"end_turn\"}}",
          "",
        ].join("\n");
      },
    },
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:45000",
    servicePassword: "credential-token",
    logger,
    randomUUID: () => "rpc-prompt",
    runtimeInstanceId: "adapter-instance-1",
    transportGenerationId: "transport-generation-1",
    fetchImpl: async () => responses.shift(),
  });
  await client.connect();
  await client.prompt({
    sessionId: "session-secret",
    text: "private prompt body",
    observability: { turnCorrelation: "corr-prompt" },
  });

  const records = readRecords(path.join(root, "logs"));
  const relevant = records.filter((record) => record.data.turnCorrelation === "corr-prompt");
  const events = relevant.map((record) => record.event);
  assert.deepEqual(events, [
    "runtime.acp.request.prepared",
    "runtime.acp.request.started",
    "runtime.acp.fetch.started",
    "runtime.acp.headers",
    "runtime.acp.sse.opened",
    "runtime.acp.sse.first_event",
    "runtime.acp.sse.closed",
    "runtime.acp.response.succeeded",
  ]);
  const started = relevant.find((record) => record.event === "runtime.acp.request.started");
  assert.equal(started.data.method, "session/prompt");
  assert.equal(started.data.requestSequenceId, "rpc-prompt");
  assert.equal(started.data.runtimeInstanceId, "adapter-instance-1");
  assert.equal(started.data.transportGenerationId, "transport-generation-1");
  assert.match(started.data.sessionIdFingerprint, /^sha256:[a-f0-9]{16}$/);
  assert.match(started.data.connectionIdFingerprint, /^sha256:[a-f0-9]{16}$/);
  const headers = relevant.find((record) => record.event === "runtime.acp.headers");
  assert.deepEqual({
    headersReceived: headers.data.headersReceived,
    latencyToHeadersMs: typeof headers.data.latencyToHeadersMs,
    httpStatus: headers.data.httpStatus,
    contentType: headers.data.contentType,
  }, { headersReceived: true, latencyToHeadersMs: "number", httpStatus: 200, contentType: "text/event-stream" });
  const closed = relevant.find((record) => record.event === "runtime.acp.sse.closed");
  assert.equal(closed.data.firstSseEventReceived, true);
  assert.equal(closed.data.sseEventCount, 4);
  assert.deepEqual(closed.data.sseEventTypeCounts, { assistant: 1, thought: 1, other: 1, jsonrpc_result: 1 });
  assert.equal(closed.data.terminalEventSeen, true);
  assert.equal(closed.data.terminalSignal, "end_turn");
  assert.equal(closed.data.jsonRpcResultSeen, true);
  assert.equal(closed.data.jsonRpcErrorSeen, false);
  assert.equal(JSON.stringify(records).includes("private prompt body"), false);
  assert.equal(JSON.stringify(records).includes("credential-token"), false);
  assert.equal(JSON.stringify(records).includes("session-secret"), false);
  assert.equal(JSON.stringify(records).includes("connection-secret"), false);
});

test("session/prompt timeout records the wire stage without changing the timeout error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-prompt-abort-"));
  const logger = new ComponentLogger({ logDir: path.join(root, "logs"), component: "bridge" });
  let call = 0;
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:45000",
    servicePassword: "credential-token",
    timeoutMs: 20,
    logger,
    randomUUID: () => "rpc-timeout",
    runtimeInstanceId: "adapter-instance-timeout",
    transportGenerationId: "transport-generation-timeout",
    fetchImpl: async (_url, options) => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, async text() { return JSON.stringify({ connectionId: "connection-secret", sessionToken: "credential-token" }); } };
      return {
        ok: true,
        status: 200,
        headers: { get() { return "text/event-stream"; } },
        text: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      };
    },
  });
  await client.connect();
  await assert.rejects(
    client.prompt({ sessionId: "session-timeout", text: "private timeout prompt", observability: { turnCorrelation: "corr-timeout" } }),
    (error) => error.code === "CODEBUDDY_START_TIMEOUT",
  );

  const records = readRecords(path.join(root, "logs"));
  const relevant = records.filter((record) => record.data.turnCorrelation === "corr-timeout");
  const aborted = relevant.find((record) => record.event === "runtime.acp.request.aborted");
  assert.equal(aborted.data.method, "session/prompt");
  assert.equal(aborted.data.stage, "awaiting_first_sse");
  assert.equal(aborted.data.httpStatus, 200);
  assert.equal(aborted.data.sseEventCount, 0);
  assert.equal(aborted.data.terminalEventSeen, false);
  assert.equal(relevant.find((record) => record.event === "runtime.acp.headers").data.headersReceived, true);
  assert.equal(JSON.stringify(records).includes("private timeout prompt"), false);
  assert.equal(JSON.stringify(records).includes("session-timeout"), false);
  assert.equal(JSON.stringify(records).includes("credential-token"), false);
});
