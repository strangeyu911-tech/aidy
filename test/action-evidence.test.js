"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  authorizeActionClaim,
  buildActionRequest,
  enforceActionClaimReply,
  extractActionTargets,
  finalizeActionEvidence,
  createActionEvidenceLedger,
  recordCodeBuddyNotification,
} = require("../src/adapters/runtime/shared/action-evidence");
const { StreamDelivery } = require("../src/core/stream-delivery");

function toolUpdate(toolCallId, title, status, extra = {}) {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title,
        status,
        ...extra,
      },
    },
  };
}

function recordTool(ledger, id, title, outcome, target) {
  recordCodeBuddyNotification(ledger, {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title,
        rawInput: { title: target },
      },
    },
  });
  recordCodeBuddyNotification(ledger, toolUpdate(id, title, outcome, {
    result: { ok: outcome === "completed" },
  }));
}

test("explicit successful write evidence authorizes a success claim", () => {
  const request = buildActionRequest("清掉：\n1. CyberBoss bug A");
  const ledger = createActionEvidenceLedger(request);
  recordTool(ledger, "write-1", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug A");
  const evidence = finalizeActionEvidence(ledger);

  assert.equal(evidence.status, "all_success");
  assert.equal(authorizeActionClaim(evidence, { text: "已清掉 CyberBoss bug A" }).allowed, true);
});

test("missing write invocation fails closed", () => {
  const request = buildActionRequest("清掉 1. CyberBoss bug A");
  const evidence = finalizeActionEvidence(createActionEvidenceLedger(request));
  const text = enforceActionClaimReply("已清掉 CyberBoss bug A", { actionRequest: request, actionEvidence: evidence });

  assert.equal(evidence.status, "not_called");
  assert.equal(authorizeActionClaim(evidence, { text: "已清掉 CyberBoss bug A" }).allowed, false);
  assert.match(text, /不能声称/);
});

test("unavailable, failed, and timeout-like unknown outcomes cannot authorize a claim", () => {
  const request = buildActionRequest("修改：\n1. CyberBoss bug A");

  const unavailable = finalizeActionEvidence(createActionEvidenceLedger(request));
  assert.equal(unavailable.status, "not_called");

  const failedLedger = createActionEvidenceLedger(request);
  recordTool(failedLedger, "write-failed", "mcp__zhijiantime__update_todo", "failed", "CyberBoss bug A");
  const failed = finalizeActionEvidence(failedLedger);
  assert.equal(failed.status, "failed");
  assert.equal(authorizeActionClaim(failed, { text: "已修改" }).allowed, false);

  const timeoutLedger = createActionEvidenceLedger(request);
  recordCodeBuddyNotification(timeoutLedger, {
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call", toolCallId: "write-timeout", title: "mcp__zhijiantime__update_todo", rawInput: { title: "CyberBoss bug A" } } },
  });
  const unknown = finalizeActionEvidence(timeoutLedger);
  assert.equal(unknown.status, "unknown");
  assert.equal(authorizeActionClaim(unknown, { text: "已修改" }).allowed, false);
});

test("three successful targets are reported as all successful", () => {
  const request = buildActionRequest([
    "弄错了，之前cyberboss那两个bug早修好了。",
    "1. CyberBoss bug A",
    "2. CyberBoss bug B",
    "3. 【Aidy验收】20260904140153",
  ].join("\n"));
  assert.deepEqual(request.requestedTargets, ["CyberBoss bug A", "CyberBoss bug B", "【Aidy验收】20260904140153"]);
  const ledger = createActionEvidenceLedger(request);
  recordTool(ledger, "write-a", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug A");
  recordTool(ledger, "write-b", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug B");
  recordTool(ledger, "write-c", "mcp__zhijiantime__update_todo", "completed", "【Aidy验收】20260904140153");
  const evidence = finalizeActionEvidence(ledger);

  assert.equal(evidence.status, "all_success");
  assert.deepEqual(evidence.targetResults.map((item) => item.status), ["success", "success", "success"]);
  assert.equal(authorizeActionClaim(evidence, { text: "三项都已勾选" }).allowed, true);
});

test("partial success is item-specific and never collapses into an overall success", () => {
  const request = buildActionRequest("清掉：\n1. CyberBoss bug A\n2. CyberBoss bug B\n3. 【Aidy验收】20260904140153");
  const ledger = createActionEvidenceLedger(request);
  recordTool(ledger, "write-a", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug A");
  recordTool(ledger, "write-b", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug B");
  recordTool(ledger, "write-c", "mcp__zhijiantime__update_todo", "failed", "【Aidy验收】20260904140153");
  const evidence = finalizeActionEvidence(ledger);
  const text = enforceActionClaimReply("已清掉全部三项", { actionRequest: request, actionEvidence: evidence });

  assert.equal(evidence.status, "partial");
  assert.deepEqual(evidence.targetResults.map((item) => item.status), ["success", "success", "failed"]);
  assert.match(text, /CyberBoss bug A/);
  assert.match(text, /CyberBoss bug B/);
  assert.match(text, /Aidy验收/);
  assert.equal(authorizeActionClaim(evidence, { text: "已清掉全部三项" }).allowed, false);
});

test("a contradictory success and inability claim is rewritten even after a successful write", () => {
  const request = buildActionRequest("清掉 1. CyberBoss bug A");
  const ledger = createActionEvidenceLedger(request);
  recordTool(ledger, "write-1", "mcp__zhijiantime__update_todo", "completed", "CyberBoss bug A");
  const evidence = finalizeActionEvidence(ledger);
  const text = enforceActionClaimReply("已清掉那条，但我这边没法直接改你那边数据。", {
    actionRequest: request,
    actionEvidence: evidence,
  });

  assert.doesNotMatch(text, /没法直接改/);
  assert.match(text, /CyberBoss bug A/);
});

test("non-action replies are not altered by the evidence guard", () => {
  const request = buildActionRequest("今天心情不错");
  const evidence = finalizeActionEvidence(createActionEvidenceLedger(request));
  assert.equal(enforceActionClaimReply("我已经记住啦", { actionRequest: request, actionEvidence: evidence }), "我已经记住啦");
});

test("final reply delivery consumes the evidence contract before sending", async () => {
  const sent = [];
  const delivery = new StreamDelivery({
    channelAdapter: { async sendText(payload) { sent.push(payload.text); } },
    sessionStore: { findBindingForThreadId: () => ({ bindingKey: "binding" }) },
    runtimeId: "codebuddy",
  });
  const request = buildActionRequest("清掉：\n1. CyberBoss bug A\n2. CyberBoss bug B");
  delivery.bindReplyTargetForTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    target: { userId: "user", contextToken: "context", provider: "weixin" },
  });
  await delivery.handleRuntimeEvent({ type: "runtime.turn.started", payload: { threadId: "thread-1", turnId: "turn-1", actionRequest: request } });
  await delivery.handleRuntimeEvent({ type: "runtime.reply.delta", payload: { threadId: "thread-1", turnId: "turn-1", itemId: "reply", text: "已清掉全部两项" } });
  await delivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "已清掉全部两项",
      actionEvidence: {
        status: "partial",
        targetResults: [
          { target: "CyberBoss bug A", status: "success" },
          { target: "CyberBoss bug B", status: "failed" },
        ],
      },
    },
  });

  assert.deepEqual(sent, ["已确认完成：CyberBoss bug A；未确认或未修改：CyberBoss bug B。"]);
});
