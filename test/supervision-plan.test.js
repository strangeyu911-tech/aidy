const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { inferContextualCheckpoint } = require("../src/core/contextual-checkpoint");
const { extractExplicitCheckpoint } = require("../src/core/explicit-checkpoint");
const { SupervisionPlanStore } = require("../src/core/supervision-plan-store");
const { resolveDueCheckpointAction, shouldSupersede } = require("../src/core/supervision-policy");

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
