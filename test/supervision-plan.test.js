const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { inferContextualCheckpoint } = require("../src/core/contextual-checkpoint");
const { extractExplicitCheckpoint } = require("../src/core/explicit-checkpoint");
const { SupervisionPlanStore } = require("../src/core/supervision-plan-store");
const {
  isStaleTimeSensitiveCheckpoint,
  isWithinQuietHours,
  resolveDueCheckpointAction,
  shouldSupersede,
} = require("../src/core/supervision-policy");
const { SupervisionDispatcher } = require("../src/desktop/supervision-dispatcher");

function makeStore() {
  return new SupervisionPlanStore({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-")),
  });
}

test("quiet archives deterministic checkpoints and discards random ones", () => {
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "quiet",
    checkpoint: { state: "pending", source: "conversation" },
  }), { action: "archive", outcome: "suppressed_quiet" });
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "quiet",
    checkpoint: { state: "pending", source: "random" },
  }), { action: "discard", outcome: "suppressed_quiet" });
});

test("stopped checkpoints are held without replay policy changes", () => {
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "stopped",
    checkpoint: { state: "pending", source: "conversation" },
  }), { action: "hold", outcome: "service_stopped" });
});

test("time-sensitive planning is suppressed at night and is stale after quiet hours", () => {
  const dueAt = "2026-09-02T19:30:00.000Z"; // 2026-09-03 03:30 Asia/Shanghai
  const checkpoint = {
    state: "pending",
    source: "zhijiantime",
    canonicalTaskId: "zhijiantime:daily-planning:2026-09-03",
    dueAt,
    timezone: "Asia/Shanghai",
  };

  assert.equal(isWithinQuietHours(new Date("2026-09-02T19:30:00.000Z")), true);
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint,
    now: new Date("2026-09-02T19:30:00.000Z"),
  }), { action: "archive", outcome: "suppressed_quiet_hours" });
  assert.equal(isStaleTimeSensitiveCheckpoint(checkpoint, new Date("2026-09-03T03:00:00.000Z")), true);
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint,
    now: new Date("2026-09-03T03:00:00.000Z"),
  }), { action: "archive", outcome: "stale_quiet_hours" });
});

test("scheduler does not create or replay quiet-hours supervision backlog", async () => {
  const checkpoints = [
    {
      id: "planning-night",
      state: "pending",
      source: "zhijiantime",
      canonicalTaskId: "zhijiantime:daily-planning:2026-09-03",
      dueAt: "2026-09-02T19:30:00.000Z",
      timezone: "Asia/Shanghai",
    },
    {
      id: "random-night",
      state: "pending",
      source: "random",
      canonicalTaskId: "random:current",
      dueAt: "2026-09-02T19:30:00.000Z",
      timezone: "Asia/Shanghai",
    },
  ];
  const updates = [];
  const added = [];
  const planStore = {
    due(now) {
      return checkpoints.filter((item) => item.state === "pending" && Date.parse(item.dueAt) <= now.getTime());
    },
    list({ state } = {}) {
      return checkpoints.concat(added).filter((item) => !state || item.state === state);
    },
    update(id, patch) {
      const item = checkpoints.find((candidate) => candidate.id === id);
      if (item) Object.assign(item, patch);
      updates.push({ id, ...patch });
      return item;
    },
    add(item) {
      const addedItem = { id: item.id || "new", state: "pending", ...item };
      added.push(addedItem);
      return addedItem;
    },
  };
  const stateStore = { get: () => ({ desiredState: "running", randomCheckinsEnabled: true }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-dispatcher-"));
  const dispatcher = new SupervisionDispatcher({
    config: {
      systemMessageQueueFile: path.join(dir, "queue.json"),
      checkinConfigFile: path.join(dir, "checkin.json"),
    },
    desktopStateStore: stateStore,
    planStore,
  });

  await dispatcher.tick(new Date("2026-09-02T19:30:00.000Z"));
  await dispatcher.tick(new Date("2026-09-03T03:00:00.000Z")); // 11:00 local

  assert.deepEqual(updates.map(({ id, state, outcome }) => ({ id, state, outcome })), [
    { id: "planning-night", state: "skipped", outcome: "suppressed_quiet_hours" },
    { id: "random-night", state: "skipped", outcome: "suppressed_quiet_hours" },
  ]);
  assert.equal(dispatcher.queue.state.messages.length, 0);
  assert.equal(added.length, 1);
  assert.ok(Date.parse(added[0].dueAt) > Date.parse("2026-09-03T03:00:00.000Z"));
});

test("context inference schedules meal and shower follow-ups and announces them", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const meal = inferContextualCheckpoint("我去吃饭了", { now, durations: { meal: 30, shower: 30 } });
  assert.equal(meal.source, "context");
  assert.equal(meal.dueAt, "2026-08-23T12:30:00.000Z");
  assert.match(meal.announcement, /半小时后/);
  assert.equal(inferContextualCheckpoint("我去洗澡，45分钟后叫我", { now }), null);
});

test("explicit conversation delays create deterministic checkpoints", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const checkpoint = extractExplicitCheckpoint("20分钟后提醒我继续写简历", { now });
  assert.equal(checkpoint.source, "conversation");
  assert.equal(checkpoint.dueAt, "2026-08-23T12:20:00.000Z");
  assert.match(checkpoint.title, /继续写简历/);
  assert.match(checkpoint.announcement, /我来找你/);
});

test("absolute conversation times roll forward when already past", () => {
  const now = new Date(2026, 7, 23, 22, 0, 0);
  const checkpoint = extractExplicitCheckpoint("21:30问我做完没有", { now });
  assert.equal(new Date(checkpoint.dueAt).getDate(), 24);
});

test("Chinese half-hour input persists and becomes due at 08:30 Asia/Shanghai", () => {
  const now = new Date(2026, 7, 29, 0, 10, 0);
  const checkpoint = extractExplicitCheckpoint("[敲打]上午8点半做计划，待会马上睡觉了", { now });
  const saved = makeStore().add(checkpoint);
  const dueAt = new Date(saved.dueAt);
  assert.equal(dueAt.getHours(), 8);
  assert.equal(dueAt.getMinutes(), 30);
  const store = makeStore();
  const persisted = store.add(checkpoint);
  assert.equal(store.due(new Date(2026, 7, 29, 8, 29, 59)).length, 0);
  assert.deepEqual(store.due(new Date(2026, 7, 29, 8, 30, 0)).map((item) => item.id), [persisted.id]);
  assert.match(checkpoint.announcement, /08:30/);
});

test("latest explicit and external arrangements supersede inferred context", () => {
  const existing = {
    state: "pending",
    canonicalTaskId: "task:resume",
    source: "context",
    updatedAt: "2026-08-23T10:00:00.000Z",
  };
  assert.equal(shouldSupersede(existing, {
    canonicalTaskId: "task:resume",
    source: "conversation",
    updatedAt: "2026-08-23T10:01:00.000Z",
  }), true);
  assert.equal(shouldSupersede({ ...existing, source: "conversation" }, {
    canonicalTaskId: "task:resume",
    source: "context",
    updatedAt: "2026-08-23T10:02:00.000Z",
  }), false);
});

test("plan hides random checkpoints from deterministic UI list", () => {
  const store = makeStore();
  store.add({ source: "random", dueAt: "2026-08-23T12:10:00.000Z" });
  const deterministic = store.add({
    source: "conversation",
    title: "继续写简历",
    dueAt: "2026-08-23T12:20:00.000Z",
  });
  assert.deepEqual(store.list({ includeRandom: false }).map((item) => item.id), [deterministic.id]);
});
