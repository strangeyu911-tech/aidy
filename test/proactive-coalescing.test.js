"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CyberbossApp } = require("../src/core/app");
const {
  buildDailySupervisionKey,
  resolveSupervisionKey,
} = require("../src/core/supervision-policy");
const {
  SystemMessageQueueStore,
} = require("../src/core/system-message-queue-store");

function createQueue() {
  return new SystemMessageQueueStore({
    filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-")), "queue.json"),
  });
}

function message(overrides = {}) {
  return {
    id: "supervision:task-1",
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: "D:\\CyberBoss",
    text: "old reminder",
    createdAt: "2026-08-29T00:01:00.000Z",
    dueAt: "2026-08-29T00:01:00.000Z",
    taskType: "supervision",
    source: "random",
    supervisionKey: "daily_plan:2026-08-29",
    sendTrigger: "scheduler",
    ...overrides,
  };
}

function createBurstApp(messages, { normalTurn = false } = {}) {
  const requeued = [];
  const dispatched = [];
  const app = Object.assign(Object.create(CyberbossApp.prototype), {
    config: { workspaceId: "default" },
    proactiveBurstByScope: new Map(),
    runtimeAdapter: {
      getSessionStore: () => ({
        buildBindingKey: () => "default:account-1:user-1",
      }),
    },
    systemMessageDispatcher: {
      drainPending: () => messages,
      requeue: (item) => requeued.push(item),
    },
    dispatchSystemMessage: async (item) => {
      dispatched.push(item);
      return true;
    },
  });
  if (normalTurn) {
    CyberbossApp.prototype.beginProactiveBurst.call(app, "default:account-1:user-1", "D:\\CyberBoss");
  }
  return { app, requeued, dispatched };
}

test("same supervision key replaces different task ids with the latest state", () => {
  const queue = createQueue();
  queue.enqueue(message({ id: "supervision:morning", text: "上午空白", createdAt: "2026-08-29T08:30:00.000Z" }));
  queue.enqueue(message({
    id: "supervision:afternoon",
    text: "下午仍为空白",
    createdAt: "2026-08-29T14:00:00.000Z",
    dueAt: "2026-08-29T14:00:00.000Z",
  }));

  assert.equal(queue.state.messages.length, 1);
  assert.equal(queue.state.messages[0].id, "supervision:afternoon");
  assert.equal(queue.state.messages[0].text, "下午仍为空白");
  assert.equal(queue.state.messages[0].supervisionKey, "daily_plan:2026-08-29");
});

test("different supervision keys remain independent", () => {
  const queue = createQueue();
  queue.enqueue(message({ id: "supervision:plan", supervisionKey: "daily_plan:2026-08-29" }));
  queue.enqueue(message({ id: "supervision:meal", supervisionKey: "context:meal" }));
  assert.equal(queue.state.messages.length, 2);
});

test("persisted outbox restart coalesces five overdue copies before dispatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-recovery-"));
  const filePath = path.join(dir, "queue.json");
  fs.writeFileSync(filePath, JSON.stringify({
    messages: Array.from({ length: 5 }, (_, index) => message({
      id: `supervision:overdue-${index}`,
      text: `过时提醒 ${index}`,
      createdAt: `2026-08-29T0${8 + index}:30:00.000Z`,
      dueAt: `2026-08-29T0${8 + index}:30:00.000Z`,
      attempt: index + 1,
      nextAttemptAt: "2026-08-29T09:00:00.000Z",
    })),
  }), "utf8");

  const queue = new SystemMessageQueueStore({ filePath });
  assert.equal(queue.state.messages.length, 1);
  assert.equal(queue.state.messages[0].id, "supervision:overdue-4");
  assert.equal(queue.state.messages[0].text, "过时提醒 4");
  assert.equal(queue.drainForAccount("account-1", Date.parse("2026-08-29T10:00:00.000Z")).length, 1);
});

test("legacy supervision task ids can be migrated through the existing canonical task identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-legacy-"));
  const filePath = path.join(dir, "queue.json");
  fs.writeFileSync(filePath, JSON.stringify({
    messages: [
      message({ id: "supervision:checkpoint-a", supervisionKey: "", createdAt: "2026-08-29T08:30:00.000Z" }),
      message({ id: "supervision:checkpoint-b", supervisionKey: "", createdAt: "2026-08-29T14:00:00.000Z" }),
    ],
  }), "utf8");

  const queue = new SystemMessageQueueStore({
    filePath,
    resolveSupervisionKey: (item) => ({
      "supervision:checkpoint-a": "daily_plan:2026-08-29",
      "supervision:checkpoint-b": "daily_plan:2026-08-29",
    }[item.id] || ""),
  });
  assert.equal(queue.state.messages.length, 1);
  assert.equal(queue.state.messages[0].id, "supervision:checkpoint-b");
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.messages.length, 1);
  assert.equal(persisted.messages[0].supervisionKey, "daily_plan:2026-08-29");
});

test("random and daily planning checkpoints share the date-scoped supervision key", () => {
  assert.equal(buildDailySupervisionKey("2026-08-29T00:30:00.000Z"), "daily_plan:2026-08-29");
  assert.equal(resolveSupervisionKey({
    source: "random",
    canonicalTaskId: "random:current",
    dueAt: "2026-08-29T02:00:00.000Z",
  }), "daily_plan:2026-08-29");
  assert.equal(resolveSupervisionKey({
    source: "zhijiantime",
    canonicalTaskId: "zhijiantime:daily-planning:2026-08-29",
  }), "daily_plan:2026-08-29");
  assert.equal(resolveSupervisionKey({
    source: "conversation",
    canonicalTaskId: "conversation:resume",
  }), "conversation:resume");
});

test("a normal user turn leaves only one proactive message in the burst", async () => {
  const { app, requeued, dispatched } = createBurstApp([
    message({ id: "supervision:random", source: "random", priority: 0 }),
    message({ id: "supervision:important", source: "zhijiantime", supervisionKey: "todo:important", priority: 30 }),
  ], { normalTurn: true });

  await CyberbossApp.prototype.flushPendingSystemMessages.call(app);
  assert.deepEqual(dispatched.map((item) => item.id), ["supervision:important"]);
  assert.deepEqual(requeued.map((item) => item.id), ["supervision:random"]);
  assert.equal(requeued[0].lastErrorCode, "BURST_PROTECTION");
  assert.ok(Date.parse(requeued[0].nextAttemptAt) > Date.now());
});

test("without a user turn, burst protection allows three and retains the fourth", async () => {
  const messages = Array.from({ length: 4 }, (_, index) => message({
    id: `supervision:independent-${index}`,
    supervisionKey: `goal:${index}`,
    priority: index,
  }));
  const { app, requeued, dispatched } = createBurstApp(messages);
  await CyberbossApp.prototype.flushPendingSystemMessages.call(app);
  assert.equal(dispatched.length, 3);
  assert.deepEqual(requeued.map((item) => item.id), ["supervision:independent-0"]);
});

test("retry keeps one task id and the queue's business identity", () => {
  const queue = createQueue();
  const first = queue.enqueue(message({ id: "supervision:retry", attempt: 0 }));
  const retried = queue.enqueue({
    ...first,
    attempt: 1,
    nextAttemptAt: "2026-08-29T00:02:00.000Z",
    lastErrorCode: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(queue.state.messages.length, 1);
  assert.equal(retried.id, first.id);
  assert.equal(queue.state.messages[0].supervisionKey, first.supervisionKey);
  assert.equal(queue.state.messages[0].attempt, 1);
});
