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

test("CodeBuddy 2.115 session creation stays isolated behind its versioned public parameter shape", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ connectionId: "c", sessionToken: "t" }),
    sseResponse([{ jsonrpc: "2.0", id: "id", result: { protocolVersion: 1 } }]),
    sseResponse([{ jsonrpc: "2.0", id: "id", result: { sessionId: "s", models: {} } }]),
  ];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44128",
    servicePassword: "gateway-secret",
    cliVersion: "2.115.0",
    randomUUID: () => "id",
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  await client.connect();
  await client.initialize();
  await client.newSession({ workingDirectory: "D:\\CyberBoss" });
  assert.deepEqual(JSON.parse(calls[2].options.body).params, { cwd: "D:\\CyberBoss", mcpServers: [] });
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
          async cancel() {},
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
          return { done: false, value: encoder.encode(`data: ${"x".repeat(257 * 1024)}\n\n`) };
        },
        async cancel() {},
        releaseLock() {},
      }) },
    }),
  });
  client.connectionId = "c";
  await assert.rejects(client.initialize(), (error) => error.code === "CODEBUDDY_API_INCOMPATIBLE");
});
