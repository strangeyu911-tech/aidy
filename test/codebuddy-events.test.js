"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapCodeBuddyNotification,
  mapCodeBuddyFailure,
  normalizeCodeBuddyUsage,
} = require("../src/adapters/runtime/codebuddy/events");

test("CodeBuddy ACP updates map to existing runtime stream, tool, context, and approval events", () => {
  const context = { threadId: "session-1", turnId: "turn-1" };
  assert.equal(mapCodeBuddyNotification({ method: "session/update", params: {
    sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
  } }, context)[0].type, "runtime.reply.delta");
  assert.equal(mapCodeBuddyNotification({ method: "session/update", params: {
    sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "exec" },
  } }, context)[0].type, "runtime.tool.started");
  assert.equal(mapCodeBuddyNotification({ method: "session/update", params: {
    sessionId: "session-1", update: { sessionUpdate: "usage_update", used: 20, size: 100, cost: { amount: 2, currency: "CNY" } },
  } }, context)[0].payload.currentTokens, 20);

  const approval = mapCodeBuddyNotification({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {
    sessionId: "session-1",
    toolCall: { title: "run command", rawInput: { command: ["node", "script.js"] } },
    options: [{ optionId: "a", kind: "allow_once" }, { optionId: "n", kind: "reject_once" }],
  } }, context)[0];
  assert.equal(approval.type, "runtime.approval.requested");
  assert.equal(approval.payload.requestId, "7");
  assert.deepEqual(approval.payload.responseTemplate.optionByCommand, { yes: "a", always: "a", no: "n" });
});

test("unknown CodeBuddy permission shapes produce a denial instruction, never an approvable event", () => {
  const events = mapCodeBuddyNotification({ id: "bad", method: "session/request_permission", params: {
    sessionId: "session-1", toolCall: { title: "unknown" }, options: [],
  } }, { threadId: "session-1", turnId: "turn-1" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "runtime.approval.denied");
  assert.equal(events[0].payload.response.outcome, "cancelled");
});

test("only explicit input/output tokens enter generic usage and vendor data stays bounded", () => {
  const normalized = normalizeCodeBuddyUsage({
    inputTokens: 12, outputTokens: 4, cost: { amount: 0.2, currency: "CNY" },
    sessionToken: "must-not-leak", workbuddyPromotion: "unknown",
  });
  assert.deepEqual(normalized.usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(JSON.stringify(normalized).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(normalized).includes("workbuddyPromotion"), true);
});

test("failure mapping keeps stable codes and removes upstream error text", () => {
  const event = mapCodeBuddyFailure({ code: "MODEL_NOT_FOUND", message: "secret upstream details" }, { threadId: "s", turnId: "t" });
  assert.equal(event.type, "runtime.turn.failed");
  assert.equal(event.payload.code, "CODEBUDDY_MODEL_UNAVAILABLE");
  assert.equal(event.payload.text.includes("secret"), false);
});

test("failure mapping preserves bounded ACP diagnostics for protocol errors", () => {
  const event = mapCodeBuddyFailure({
    code: "CODEBUDDY_SESSION_FAILED",
    diagnostic: {
      method: "session/new",
      upstreamCode: -32602,
      upstreamMessage: "Invalid params: expected cwd",
    },
  }, { threadId: "s", turnId: "t" });
  assert.deepEqual(event.payload.diagnostic, {
    method: "session/new",
    upstreamCode: -32602,
    upstreamMessage: "Invalid params: expected cwd",
  });
});
