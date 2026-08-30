"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const { OutboundMessageBoundary } = require("../src/core/outbound-message-boundary");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

function systemMessage(overrides = {}) {
  return {
    id: "supervision:task-1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "D:\\CyberBoss",
    text: "follow up",
    createdAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}
test("outbound boundary accepts only typed final assistant envelopes", async () => {
  const sent = [];
  const boundary = new OutboundMessageBoundary({
    channelAdapter: { async sendText(payload) { sent.push(payload); } },
  });
  await boundary.send({
    audience: "user",
    kind: "assistant.final",
    source: "runtime.reply",
    userId: "user-1",
    contextToken: "ctx-1",
    text: "正常回复",
  });
  for (const envelope of [
    { audience: "internal", kind: "provider.exception", source: "runtime.reply" },
    { audience: "user", kind: "permission.request", source: "runtime.reply" },
    { audience: "user", kind: "tool.request", source: "runtime.reply" },
    { audience: "user", kind: "assistant.final", source: "debug.trace" },
  ]) {
    await assert.rejects(boundary.send({
      ...envelope,
      userId: "user-1",
      contextToken: "ctx-1",
      text: "internal",
    }), (error) => error.code === "OUTBOUND_MESSAGE_REJECTED");
  }
  assert.deepEqual(sent.map((item) => item.text), ["正常回复"]);
});

test("turn failures, permission events, tool events, and recovery metadata do not enter delivery", async () => {
  const sent = [];
  const delivery = new StreamDelivery({
    channelAdapter: { async sendText(payload) { sent.push(payload); } },
    sessionStore: { findBindingForThreadId: () => ({ bindingKey: "binding-1" }) },
  });
  delivery.setReplyTarget("binding-1", { userId: "user-1", contextToken: "ctx-1", provider: "weixin" });
  for (const event of [
    { type: "runtime.tool.started", payload: { threadId: "thread-1", turnId: "turn-1", toolName: "shell" } },
    { type: "runtime.approval.requested", payload: { threadId: "thread-1", turnId: "turn-1", requestId: "approval-1" } },
    { type: "runtime.context.updated", payload: { threadId: "thread-1", currentTokens: 99 } },
    { type: "runtime.turn.failed", payload: { threadId: "thread-1", turnId: "turn-1", text: "CodeBuddy turn failed." } },
  ]) {
    await delivery.handleRuntimeEvent(event);
  }
  assert.deepEqual(sent, []);
});

test("legacy context-token recovery framing is removed before the next assistant reply", () => {
  let prefix = "";
  const app = {
    deferredSystemReplyQueue: {
      drainForSender: () => [{
        text: [
          "由于微信 context_token 的限制，上轮内容未送达。",
          "===== 上轮对话遗留内容 =====",
          "旧回复",
          "===== 期间模型主动联系 =====",
          "主动回复",
        ].join("\n"),
      }],
    },
    runtimeAdapter: { getSessionStore: () => ({ buildBindingKey: () => "binding-1" }) },
    streamDelivery: { setDeferredReplyPrefix: (_binding, text) => { prefix = text; } },
  };
  CyberbossApp.prototype.primeDeferredRepliesForSender.call(app, {
    accountId: "account-1", senderId: "user-1", contextToken: "ctx-1", workspaceId: "default",
  });
  assert.equal(prefix, "旧回复\n主动回复");
  assert.doesNotMatch(prefix, /context_token|=====|\/chunk/);
});

test("system outbox deduplicates task ids and honors retry time", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-outbox-")), "queue.json");
  const queue = new SystemMessageQueueStore({ filePath });
  queue.enqueue(systemMessage());
  queue.enqueue(systemMessage({ attempt: 2, nextAttemptAt: "2026-08-29T00:02:00.000Z" }));
  assert.equal(queue.state.messages.length, 1);
  assert.equal(queue.drainForAccount("account-1", Date.parse("2026-08-29T00:01:59.000Z")).length, 0);
  const due = queue.drainForAccount("account-1", Date.parse("2026-08-29T00:02:00.000Z"));
  assert.equal(due.length, 1);
  assert.equal(due[0].attempt, 2);
});

test("repeated proactive provider failures back off, open a circuit, and keep one task", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-circuit-")), "queue.json");
  const app = {
    systemMessageQueue: new SystemMessageQueueStore({ filePath }),
    proactiveProviderFailures: 0,
    proactiveProviderCooldownUntil: 0,
  };
  let queued = systemMessage();
  for (let index = 0; index < 3; index += 1) {
    queued = CyberbossApp.prototype.scheduleSystemMessageRetry.call(app, queued, { code: "CODEBUDDY_CONNECTION_LOST" });
  }
  assert.equal(app.systemMessageQueue.state.messages.length, 1);
  assert.equal(queued.attempt, 3);
  assert.ok(Date.parse(queued.nextAttemptAt) >= app.proactiveProviderCooldownUntil);
  assert.ok(app.proactiveProviderCooldownUntil > Date.now());
  CyberbossApp.prototype.recordProactiveProviderSuccess.call(app);
  assert.equal(app.proactiveProviderFailures, 0);
  assert.equal(app.proactiveProviderCooldownUntil, 0);
});

test("provider unavailable at turn start is logged and retried without a WeChat error", async () => {
  const sent = [];
  const queued = [];
  const app = {
    drainingForSwitch: false,
    activeTurnRecords: new Map(),
    turnGateStore: {
      begin: () => "scope-1",
      releaseScope() {},
    },
    channelAdapter: {
      async sendTyping() {},
      async sendText(payload) { sent.push(payload); },
    },
    runtimeAdapter: {
      describe: () => ({ id: "codebuddy", model: "auto", profileId: "profile-1" }),
      getSessionStore: () => ({ getRuntimeParamsForWorkspace: () => ({ model: "auto" }) }),
      async sendTurn() { throw Object.assign(new Error("CodeBuddy public API is unavailable."), { code: "CODEBUDDY_CONNECTION_LOST" }); },
    },
    threadStateStore: { getThreadState: () => null },
    activeProfile: null,
    buildRuntimeTurn: async ({ prepared }) => ({ text: prepared.text, attachments: [], usageAttributions: [] }),
    scheduleSystemMessageRetry(message, error) { queued.push({ message, error }); },
  };
  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(app, {
    bindingKey: "binding-1",
    workspaceRoot: "D:\\CyberBoss",
    prepared: {
      provider: "system", senderId: "user-1", contextToken: "ctx-1", text: "trigger",
      accountId: "account-1", workspaceId: "default", systemMessage: systemMessage(),
    },
  });
  assert.equal(dispatched, true);
  assert.equal(queued.length, 1);
  assert.deepEqual(sent, []);
});
