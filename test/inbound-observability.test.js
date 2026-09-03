"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ComponentLogger } = require("../src/core/component-logger");
const { StreamDelivery } = require("../src/core/stream-delivery");
const { createCodeBuddyRuntimeAdapter } = require("../src/adapters/runtime/codebuddy");

const IDENTITY = "a".repeat(64);

function createLoggerHarness() {
  const records = [];
  return { records, logger: { info(event, data) { records.push({ event, data }); } } };
}

function createDelivery({ records, sendText, runtimeId = "codebuddy" } = {}) {
  const sent = [];
  const delivery = new StreamDelivery({
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
        return typeof sendText === "function" ? sendText(payload) : { ret: 0, msg_id: "provider-message-1" };
      },
    },
    sessionStore: { findBindingForThreadId() { return null; } },
    runtimeId,
    logger: { info(event, data) { records?.push({ event, data }); } },
  });
  return { delivery, sent };
}

async function completeDelivery(delivery, { text, turnCorrelation = "corr-stream" } = {}) {
  delivery.queueReplyTargetForThread("session-1", {
    userId: "wx-user-1",
    contextToken: "context-token-1",
    provider: "weixin",
  });
  await delivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "session-1", turnId: "turn-1", turnCorrelation },
  });
  await delivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "session-1", turnId: "turn-1", turnCorrelation, text },
  });
}

function createCodeBuddyHarness({ root, prompt } = {}) {
  const { records, logger } = createLoggerHarness();
  const client = {
    async connect() {},
    async initialize() { return { serverInfo: { version: "2.115.0" } }; },
    async getIdentityFingerprint() { return IDENTITY; },
    async newSession() { return { sessionId: "session-1", modelId: "auto" }; },
    async resumeSession(input) { return { sessionId: input.sessionId }; },
    async prompt(input) { return typeof prompt === "function" ? prompt(input) : { text: "reply", stopReason: "end_turn" }; },
    async disconnect() {},
  };
  const adapter = createCodeBuddyRuntimeAdapter({
    config: {
      stateDir: root,
      workspaceRoot: "D:\\CyberBoss",
      sessionsFile: path.join(root, "sessions.json"),
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
  return { adapter, records };
}

function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for observability event"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("runtime completion telemetry is correlation-aware and privacy-safe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-observability-runtime-"));
  const { adapter, records } = createCodeBuddyHarness({ root });
  const events = [];
  adapter.onEvent((event) => events.push(event));

  await adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "private inbound text", turnCorrelation: "corr-runtime" });
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));

  const completed = records.find((record) => record.event === "runtime.turn.completed");
  assert.equal(completed.data.turnCorrelation, "corr-runtime");
  assert.equal(completed.data.replyEmpty, false);
  assert.equal(completed.data.replyCharLength, 5);
  assert.equal(completed.data.replyByteLength, 5);
  assert.equal(completed.data.stopReason, "end_turn");
  assert.match(completed.data.sessionIdFingerprint, /^sha256:/);
  assert.equal(JSON.stringify(records).includes("private inbound text"), false);
  assert.equal(events.at(-1).payload.turnCorrelation, "corr-runtime");
  await adapter.close();
});

test("runtime empty completion and runtime failure are distinct telemetry outcomes", async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-observability-empty-"));
  const empty = createCodeBuddyHarness({ root: emptyRoot, prompt: async () => ({ text: "", stopReason: "end_turn" }) });
  const emptyEvents = [];
  empty.adapter.onEvent((event) => emptyEvents.push(event));
  await empty.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "empty", turnCorrelation: "corr-empty" });
  await waitFor(() => emptyEvents.some((event) => event.type === "runtime.turn.completed"));
  const emptyCompleted = empty.records.find((record) => record.event === "runtime.turn.completed");
  assert.equal(emptyCompleted.data.turnCorrelation, "corr-empty");
  assert.equal(emptyCompleted.data.replyEmpty, true);
  assert.equal(emptyCompleted.data.replyCharLength, 0);
  await empty.adapter.close();

  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-observability-failed-"));
  const failed = createCodeBuddyHarness({
    root: failedRoot,
    prompt: async () => { throw Object.assign(new Error("upstream details must not be logged"), { code: "MODEL_FAILED" }); },
  });
  const failedEvents = [];
  failed.adapter.onEvent((event) => failedEvents.push(event));
  await failed.adapter.sendTurn({ bindingKey: "binding", workspaceRoot: "D:\\CyberBoss", text: "failed", turnCorrelation: "corr-failed" });
  await waitFor(() => failedEvents.some((event) => event.type === "runtime.turn.failed"));
  const failedRecord = failed.records.find((record) => record.event === "runtime.turn.failed");
  assert.equal(failedRecord.data.turnCorrelation, "corr-failed");
  assert.equal(failedRecord.data.failureStage, "runtime.turn");
  assert.equal(failedRecord.data.errorCode, "MODEL_FAILED");
  assert.equal(JSON.stringify(failed.records).includes("upstream details"), false);
  assert.equal(failedEvents.at(-1).payload.turnCorrelation, "corr-failed");
  await failed.adapter.close();
});

test("reply prepared and sender success preserve correlation without reply body in structured logs", async () => {
  const { records, logger } = createLoggerHarness();
  const sent = [];
  const { delivery } = createDelivery({ records, sendText: (payload) => { sent.push(payload); return { ret: 0, msg_id: "provider-message-1" }; } });
  await completeDelivery(delivery, { text: "private reply body", turnCorrelation: "corr-send" });

  assert.equal(sent.length, 1);
  assert.deepEqual(records.map((record) => record.event), ["reply.prepared", "sender.enqueued", "sender.started", "sender.succeeded"]);
  assert.equal(records.every((record) => record.data.turnCorrelation === "corr-send"), true);
  assert.equal(records.find((record) => record.event === "reply.prepared").data.charLength, 18);
  assert.equal(records.find((record) => record.event === "sender.succeeded").data.apiStatus.rpcSuccess, true);
  assert.match(records.find((record) => record.event === "sender.succeeded").data.providerMessageIdFingerprint, /^sha256:/);
  assert.equal(JSON.stringify(records).includes("private reply body"), false);
});

test("reply suppression and sender failure are observable without changing delivery behavior", async () => {
  const suppressedRecords = [];
  const { delivery: suppressed, sent: suppressedSent } = createDelivery({ records: suppressedRecords, runtimeId: "system" });
  suppressed.queueReplyTargetForThread("session-1", { userId: "user", contextToken: "context", provider: "system" });
  await suppressed.handleRuntimeEvent({ type: "runtime.turn.started", payload: { threadId: "session-1", turnId: "turn-1", turnCorrelation: "corr-suppressed" } });
  await suppressed.handleRuntimeEvent({ type: "runtime.turn.completed", payload: { threadId: "session-1", turnId: "turn-1", turnCorrelation: "corr-suppressed", text: '{"action":"silent"}' } });
  assert.equal(suppressedSent.length, 0);
  assert.equal(suppressedRecords.find((record) => record.event === "reply.skipped").data.reason, "silent");

  const failedRecords = [];
  const { delivery: failed, sent: failedSent } = createDelivery({
    records: failedRecords,
    sendText: async () => { throw Object.assign(new Error("provider unavailable"), { code: "PROVIDER_UNAVAILABLE" }); },
  });
  await completeDelivery(failed, { text: "reply", turnCorrelation: "corr-provider-failed" });
  assert.equal(failedSent.length, 1);
  const failedRecord = failedRecords.find((record) => record.event === "sender.failed");
  assert.equal(failedRecord.data.turnCorrelation, "corr-provider-failed");
  assert.equal(failedRecord.data.failureCode, "PROVIDER_UNAVAILABLE");
  assert.equal(failedRecords.some((record) => record.event === "sender.succeeded"), false);
});

test("component logger keeps inbound telemetry free of reply bodies and credentials", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-observability-redaction-"));
  const logger = new ComponentLogger({ logDir, component: "bridge" });
  logger.info("reply.prepared", {
    turnCorrelation: "corr-redaction",
    charLength: 12,
    byteLength: 12,
    replyBody: "private reply body",
    credential: "gateway-secret",
    authorization: "Bearer secret-token",
  });
  const raw = fs.readFileSync(path.join(logDir, "bridge.jsonl"), "utf8");
  assert.equal(raw.includes("private reply body"), false);
  assert.equal(raw.includes("gateway-secret"), false);
  assert.equal(raw.includes("secret-token"), false);
  assert.equal(raw.includes("corr-redaction"), true);
});
