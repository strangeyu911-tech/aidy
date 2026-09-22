"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CodeBuddyClient } = require("../src/adapters/runtime/codebuddy/client");

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(value); } };
}

function sseResponse(messages, status = 200) {
  const body = [":ok", "", ...messages.flatMap((message) => ["event: message", `data: ${JSON.stringify(message)}`, ""])].join("\n");
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

test("minimal ACP smoke returns TEST_OK and never exposes upstream identity tokens", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ connectionId: "connection-1", sessionToken: "sensitive-session-token" }),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-1", result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      serverInfo: { name: "CodeBuddy Code", version: "2.115.0" },
    } }]),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-2", result: { userInfo: {
      userId: "user-123", userName: "worker", userNickname: "Worker",
      token: "must-not-leak", accessToken: "also-must-not-leak",
    } } }]),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-3", result: {
      sessionId: "session-1",
      models: { currentModelId: "hy3", availableModels: [{ modelId: "hy3", name: "HY3" }] },
    } }]),
    sseResponse([
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TEST_" } } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } } },
      { jsonrpc: "2.0", id: "rpc-4", result: { stopReason: "end_turn" } },
    ]),
    jsonResponse({ ok: true }),
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44126",
    servicePassword: "gateway-secret",
    randomUUID: (() => { let value = 0; return () => `rpc-${++value}`; })(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
  });

  const result = await client.runTestOk({ workingDirectory: "D:\\CyberBoss" });
  await client.disconnect();

  assert.equal(result.ok, true);
  assert.equal(result.text, "TEST_OK");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.modelId, "hy3");
  assert.match(result.identityFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("user-123"), false);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(client).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(client).includes("sensitive-session-token"), false);
  assert.equal(JSON.stringify(client).includes("gateway-secret"), false);

  assert.equal(calls[0].url.endsWith("/api/v1/acp/connect"), true);
  for (const call of calls.slice(1, 5)) {
    assert.equal(call.options.headers["acp-connection-id"], "connection-1");
  }
  assert.equal(calls[1].options.headers.Accept, "application/json, text/event-stream");
  const promptRequest = JSON.parse(calls[4].options.body);
  assert.equal(promptRequest.method, "session/prompt");
  assert.deepEqual(promptRequest.params.prompt, [{ type: "text", text: "Respond with exactly TEST_OK and nothing else." }]);
});

test("ACP smoke rejects mismatched ids, missing login, and non-exact model output", async () => {
  const base = {
    endpoint: "http://127.0.0.1:44127",
    servicePassword: "gateway-secret",
    randomUUID: () => "expected-id",
  };
  const mismatched = new CodeBuddyClient({
    ...base,
    fetchImpl: async (url) => url.endsWith("/connect")
      ? jsonResponse({ connectionId: "c", sessionToken: "t" })
      : sseResponse([{ jsonrpc: "2.0", id: "wrong-id", result: {} }]),
  });
  await mismatched.connect();
  await assert.rejects(mismatched.initialize(), (error) => error.code === "CODEBUDDY_API_INCOMPATIBLE");

  const noLoginResponses = [
    jsonResponse({ connectionId: "c", sessionToken: "t" }),
    sseResponse([{ jsonrpc: "2.0", id: "expected-id", result: { protocolVersion: 1 } }]),
    sseResponse([{ jsonrpc: "2.0", id: "expected-id", result: { userInfo: {} } }]),
  ];
  const noLogin = new CodeBuddyClient({ ...base, fetchImpl: async () => noLoginResponses.shift() });
  await noLogin.connect();
  await noLogin.initialize();
  await assert.rejects(noLogin.getIdentityFingerprint(), (error) => error.code === "CODEBUDDY_LOGIN_REQUIRED");
});

test("session creation uses the canonical cwd parameter shape regardless of CLI version", async () => {
  for (const cliVersion of ["2.114.9", "2.115.0", "2.132.0", "9.0.0", "unknown"]) {
    const calls = [];
    const responses = [
      jsonResponse({ connectionId: "c", sessionToken: "t" }),
      sseResponse([{ jsonrpc: "2.0", id: "id", result: { protocolVersion: 1 } }]),
      sseResponse([{ jsonrpc: "2.0", id: "id", result: { sessionId: "s", models: {} } }]),
      sseResponse([{ jsonrpc: "2.0", id: "id", result: {} }]),
    ];
    const client = new CodeBuddyClient({
      endpoint: "http://127.0.0.1:44128",
      servicePassword: "gateway-secret",
      cliVersion,
      randomUUID: () => "id",
      fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
    });
    await client.connect();
    await client.initialize();
    await client.newSession({ workingDirectory: "D:\\CyberBoss" });
    await client.resumeSession({ sessionId: "s", workingDirectory: "D:\\CyberBoss" });
    assert.deepEqual(JSON.parse(calls[2].options.body).params, { cwd: "D:\\CyberBoss", mcpServers: [] });
    assert.deepEqual(JSON.parse(calls[3].options.body).params, { sessionId: "s", cwd: "D:\\CyberBoss", mcpServers: [] });
  }
});

test("session/new Invalid params preserves protocol diagnostics and does not retry", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ connectionId: "c", sessionToken: "t" }),
    sseResponse([{ jsonrpc: "2.0", id: "id", result: { protocolVersion: 1 } }]),
    sseResponse([{ jsonrpc: "2.0", id: "id", error: { code: -32602, message: "Invalid params: expected cwd" } }]),
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44128",
    servicePassword: "gateway-secret",
    randomUUID: () => "id",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.connect();
  await client.initialize();
  await assert.rejects(client.newSession({ workingDirectory: "D:\\CyberBoss" }), (error) => {
    assert.equal(error.code, "CODEBUDDY_SESSION_FAILED");
    assert.deepEqual(error.diagnostic, {
      method: "session/new",
      upstreamCode: -32602,
      upstreamMessage: "Invalid params: expected cwd",
    });
    return true;
  });
  assert.equal(calls.filter((call) => JSON.parse(call.options?.body || "{}").method === "session/new").length, 1);
  assert.equal(calls.filter((call) => JSON.parse(call.options?.body || "{}").params?.workingDirectory).length, 0);
});

test("ACP model discovery returns the real model id separately from its display name", async () => {
  const responses = [
    jsonResponse({ connectionId: "c", sessionToken: "t" }),
    sseResponse([{ jsonrpc: "2.0", id: "id", result: { sessionId: "s", models: {
      currentModelId: "hy4",
      availableModels: [{ modelId: "hy4", name: "Hy4 preview" }],
    } } }]),
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44131",
    servicePassword: "gateway-secret",
    randomUUID: () => "id",
    fetchImpl: async () => responses.shift(),
  });

  await client.connect();
  const result = await client.listModels({ workingDirectory: "D:\\CyberBoss" });

  assert.deepEqual(result, {
    currentModelId: "hy4",
    models: [{ id: "hy4", name: "Hy4 preview" }],
  });
});

test("ACP echo verification requires a completed named tool call containing the echo result", async () => {
  const token = "verification_token_123";
  const responses = [
    jsonResponse({ connectionId: "c", sessionToken: "t" }),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-1", result: { protocolVersion: 1, serverInfo: {} } }]),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-2", result: { userInfo: { userId: "user-1" } } }]),
    sseResponse([{ jsonrpc: "2.0", id: "rpc-3", result: { sessionId: "s", models: { currentModelId: "auto" } } }]),
    sseResponse([
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "cyberboss_capability_echo", rawInput: { value: token }, status: "in_progress" } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", rawOutput: { text: token } } } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TEST_OK" } } } },
      { jsonrpc: "2.0", id: "rpc-4", result: { stopReason: "end_turn" } },
    ]),
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44129",
    servicePassword: "gateway-secret",
    cliVersion: "2.115.0",
    randomUUID: (() => { let value = 0; return () => `rpc-${++value}`; })(),
    fetchImpl: async () => responses.shift(),
  });

  const result = await client.runEchoToolVerification({
    workingDirectory: "D:\\CyberBoss",
    toolName: "cyberboss_capability_echo",
    token,
  });
  assert.equal(result.toolVerified, true);
  assert.equal(result.text, "TEST_OK");
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("ACP timeout remains active while the SSE response body is streaming", async () => {
  let call = 0;
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44130",
    servicePassword: "gateway-secret",
    timeoutMs: 20,
    randomUUID: () => "rpc-timeout",
    fetchImpl: async (_url, options) => {
      call += 1;
      if (call === 1) return jsonResponse({ connectionId: "c", sessionToken: "t" });
      return {
        ok: true,
        status: 200,
        text: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      };
    },
  });
  await client.connect();
  await assert.rejects(client.initialize(), (error) => error.code === "CODEBUDDY_START_TIMEOUT");
});

test("a rejected request keeps the transport, while a real transport failure aborts in-flight work", async () => {
  const encoder = new TextEncoder();
  let call = 0;
  let failureMode = "http";
  let promptStartedResolve;
  const promptStarted = new Promise((resolve) => { promptStartedResolve = resolve; });
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44130",
    servicePassword: "gateway-secret",
    timeoutMs: 1_000,
    randomUUID: (() => { let value = 0; return () => `rpc-${++value}`; })(),
    fetchImpl: async (_url, options) => {
      call += 1;
      if (call === 1) return jsonResponse({ connectionId: "c", sessionToken: "t" });
      if (call === 2) {
        promptStartedResolve();
        let read = 0;
        return {
          ok: true,
          status: 200,
          body: { getReader: () => ({
            async read() {
              if (read++ === 0) {
                return { done: false, value: encoder.encode("data: {\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\"}}}\n\n") };
              }
              return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("prompt aborted")), { once: true }));
            },
            async cancel() {},
            releaseLock() {},
          }) },
        };
      }
      if (failureMode === "http") return { ok: false, status: 503, async text() { return ""; } };
      throw new Error("socket hang up");
    },
  });
  await client.connect();
  const prompt = client.prompt({ sessionId: "s", text: "hello" });
  await promptStarted;

  // A server-side rejection answers the request; it is not transport death.
  // Tearing the connection down here is what previously aborted the permission
  // response the gateway was waiting for and wedged the run forever.
  await assert.rejects(client.getIdentityFingerprint(), (error) => error.code === "CODEBUDDY_CONNECTION_LOST");
  assert.equal(client.isConnected(), true);
  let promptSettled = false;
  prompt.then(() => { promptSettled = true; }, () => { promptSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(promptSettled, false, "a rejected request must not abort the in-flight prompt");

  // A genuine transport failure still aborts everything on that transport.
  failureMode = "transport";
  await assert.rejects(client.getIdentityFingerprint(), (error) => error.code === "CODEBUDDY_CONNECTION_LOST");
  await assert.rejects(prompt, (error) => error.code === "CODEBUDDY_CONNECTION_LOST");
  assert.equal(client.isConnected(), false);
});

test("ACP notifications are delivered incrementally across chunk boundaries before the correlated response", async () => {
  const encoder = new TextEncoder();
  const first = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HEL" } } },
  });
  const second = JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LO" } } },
  });
  const terminal = JSON.stringify({ jsonrpc: "2.0", id: "stream-id", result: { stopReason: "end_turn" } });
  const chunks = [
    ": heartbeat\r\n\r\nevent: message\r\nda",
    `ta: ${first.slice(0, 31)}`,
    `${first.slice(31)}\r\n\r\n`,
    `data: ${second}\n\ndata: ${terminal}\n\n`,
  ];
  let readIndex = 0;
  let readerCancelled = false;
  let releaseTerminal;
  const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (readIndex === 3) await terminalGate;
            if (readIndex >= chunks.length) return { done: true };
            return { done: false, value: encoder.encode(chunks[readIndex++]) };
          },
          async cancel() { readerCancelled = true; },
          releaseLock() {},
        };
      },
    },
  };
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44131",
    servicePassword: "gateway-secret",
    randomUUID: () => "stream-id",
    fetchImpl: async () => response,
  });
  client.connectionId = "c";
  const notifications = [];
  let firstObservedResolve;
  const firstObserved = new Promise((resolve) => { firstObservedResolve = resolve; });
  const pending = client.prompt({
    sessionId: "s",
    text: "hello",
    onNotification(message) {
      notifications.push(message);
      if (notifications.length === 1) firstObservedResolve();
    },
  });

  await firstObserved;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.update.content.text, "HEL");
  releaseTerminal();
  const result = await pending;
  assert.equal(result.text, "HELLO");
  assert.equal(notifications.length, 2);
  assert.equal(readerCancelled, true);
});

test("ACP incremental stream enforces the total response byte limit", async () => {
  const encoder = new TextEncoder();
  let sent = false;
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44132",
    servicePassword: "gateway-secret",
    randomUUID: () => "oversized-id",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({
        async read() {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: encoder.encode(`data: ${"x".repeat(2 * 1024 * 1024 + 1)}\n\n`) };
        },
        async cancel() {},
        releaseLock() {},
      }) },
    }),
  });
  client.connectionId = "c";
  await assert.rejects(client.initialize(), (error) => error.code === "CODEBUDDY_API_INCOMPATIBLE");
});

test("ACP permission requests are separated from notifications and receive the standard JSON-RPC outcome", async () => {
  const calls = [];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44133",
    servicePassword: "gateway-secret",
    randomUUID: () => "prompt-id",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST" && JSON.parse(options.body).result) return jsonResponse({ ok: true });
      return sseResponse([
        { jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "s", options: [] } },
        { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } },
        { jsonrpc: "2.0", id: "prompt-id", result: { stopReason: "end_turn" } },
      ]);
    },
  });
  client.connectionId = "connection-1";
  const requests = [];
  const result = await client.prompt({
    sessionId: "s",
    text: "hello",
    onRequest: (request) => requests.push(request),
  });
  assert.equal(result.text, "done");
  assert.equal(requests[0].method, "session/request_permission");
  await client.respondPermission({ requestId: "permission-1", outcome: "allow_once", sessionId: "s" });
  const responseCall = calls[1];
  assert.equal(responseCall.options.headers["acp-connection-id"], "connection-1");
  assert.equal(responseCall.options.headers["acp-session-id"], "s");
  assert.deepEqual(JSON.parse(responseCall.options.body), {
    jsonrpc: "2.0", id: "permission-1", result: { outcome: "allow_once" },
  });
});
