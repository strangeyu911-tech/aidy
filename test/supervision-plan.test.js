const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { inferContextualCheckpoint } = require("../src/core/contextual-checkpoint");
const { extractExplicitCheckpoint, resolveArrangementIntent } = require("../src/core/explicit-checkpoint");
const { SupervisionPlanStore } = require("../src/core/supervision-plan-store");
const {
  isStaleTimeSensitiveCheckpoint,
  isWithinQuietHours,
  resolveDueCheckpointAction,
  shouldSupersede,
} = require("../src/core/supervision-policy");
const { SupervisionDispatcher, resolveRandomBackoff } = require("../src/desktop/supervision-dispatcher");

function makeStore() {
  return new SupervisionPlanStore({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-")),
  });
}

function rawCheckpoint(overrides = {}) {
  return {
    id: overrides.id || "c1",
    canonicalTaskId: overrides.canonicalTaskId || overrides.id || "c1",
    title: "t",
    source: overrides.source || "conversation",
    sourceRef: "",
    dueAt: overrides.dueAt || "2026-08-23T12:20:00.000Z",
    timezone: "Asia/Shanghai",
    state: overrides.state || "pending",
    outcome: "",
    announcedAt: "",
    link: "",
    mutationFingerprint: "",
    prompt: "",
    createdAt: overrides.createdAt || "2026-08-23T12:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-08-23T12:00:00.000Z",
  };
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

test("time-sensitive planning defers to the end of quiet hours and goes stale after the grace period", () => {
  const dueAt = "2026-09-02T19:30:00.000Z"; // 2026-09-03 03:30 Asia/Shanghai
  const checkpoint = {
    state: "pending",
    source: "zhijiantime",
    canonicalTaskId: "zhijiantime:daily-planning:2026-09-03",
    dueAt,
    timezone: "Asia/Shanghai",
  };

  assert.equal(isWithinQuietHours(new Date("2026-09-02T19:30:00.000Z")), true);
  // Deterministic checkpoints are pushed to 07:00 local rather than dropped,
  // otherwise a reminder the user asked for silently disappears overnight.
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint,
    now: new Date("2026-09-02T19:30:00.000Z"),
  }), {
    action: "defer",
    outcome: "deferred_quiet_hours",
    deferTo: "2026-09-02T23:00:00.000Z", // 2026-09-03 07:00 Asia/Shanghai
  });
  // Explicit requests and random check-ins keep their old semantics.
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint: { ...checkpoint, exemptQuietHours: true },
    now: new Date("2026-09-02T19:30:00.000Z"),
  }), { action: "dispatch", outcome: "queued" });
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint: { ...checkpoint, source: "random", canonicalTaskId: "random:current" },
    now: new Date("2026-09-02T19:30:00.000Z"),
  }), { action: "discard", outcome: "suppressed_quiet_hours" });
  assert.equal(isStaleTimeSensitiveCheckpoint(checkpoint, new Date("2026-09-03T03:00:00.000Z")), true);
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint,
    now: new Date("2026-09-03T03:00:00.000Z"),
  }), { action: "archive", outcome: "stale_quiet_hours" });
});

test("explicit requests survive persistence and still bypass quiet hours", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-exempt-"));
  const first = new SupervisionPlanStore({ stateDir: dir });
  const saved = first.add({
    source: "conversation",
    title: "写简历",
    canonicalTaskId: "conversation:写简历",
    dueAt: "2026-09-02T15:30:00.000Z", // 2026-09-02 23:30 Asia/Shanghai
    timezone: "Asia/Shanghai",
    exemptQuietHours: true,
  });

  // Re-open the store so the flag has to survive a real disk round-trip; the
  // dispatcher reads it back long after the in-memory arrangement is gone.
  const reopened = new SupervisionPlanStore({ stateDir: dir });
  const persisted = reopened.list().find((item) => item.id === saved.id);
  assert.equal(persisted.exemptQuietHours, true);

  // It fires at 23:30 local exactly as the user asked.
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint: persisted,
    now: new Date("2026-09-02T15:30:00.000Z"),
  }), { action: "dispatch", outcome: "queued" });

  // A week-old explicit request is still stale rather than replayed as backlog.
  assert.deepEqual(resolveDueCheckpointAction({
    desiredState: "running",
    checkpoint: persisted,
    now: new Date("2026-09-09T09:00:00.000Z"),
  }), { action: "archive", outcome: "stale_quiet_hours" });
});

test("scheduler defers quiet-hours checkpoints instead of replaying a backlog", async () => {
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

  // 03:30 local: the deterministic checkpoint is pushed to the end of the
  // window (it stays pending, only its dueAt moves) while the opportunistic
  // random one is dropped outright. Nothing is queued and no random checkpoint
  // is spawned while quiet hours are active.
  assert.deepEqual(updates, [
    { id: "planning-night", dueAt: "2026-09-02T23:00:00.000Z", outcome: "deferred_quiet_hours" },
    { id: "random-night", state: "skipped", outcome: "suppressed_quiet_hours" },
  ]);
  assert.equal(checkpoints.find((item) => item.id === "planning-night").state, "pending");
  assert.equal(dispatcher.queue.state.messages.length, 0);
  assert.equal(added.length, 0);

  // 11:00 local, quiet hours are over. The deferred checkpoint is eligible
  // again instead of being replayed as a burst of stale check-ins, and exactly
  // one fresh random checkpoint is scheduled.
  await dispatcher.tick(new Date("2026-09-03T03:00:00.000Z"));

  const planning = updates.filter((item) => item.id === "planning-night");
  assert.equal(planning[planning.length - 1].outcome, "target_unavailable"); // this fixture has no account configured
  assert.equal(dispatcher.queue.state.messages.length, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].source, "random");
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

test("denial and quotation shapes never create checkpoints", () => {
  const now = new Date("2026-09-22T09:46:00.000Z");
  // Every line below is either a real user message from the 2026-09-22
  // "phantom checkpoint" incident or a close paraphrase. All of them used to
  // schedule a follow-up, which the user could not withdraw.
  const blocked = [
    "我没让你明天17:45来找我，你有带脑子吗",
    "现在下午5:45了，怎么还刚醒啊？是你刚醒脑子不清醒吧",
    "今天下午开会开到5点，累死了",
    "我8点起的",
    "我又没让你来找我",
    "谁让你半夜给我发消息的",
    "别再来找我了",
    "取消掉刚才那个提醒",
    "我没说过要你7点催我",
    "我没让你催我吃饭",
    "都十点多了，计划还没影",
  ];
  for (const text of blocked) {
    assert.equal(extractExplicitCheckpoint(text, { now }), null, `should not schedule: ${text}`);
    assert.equal(inferContextualCheckpoint(text, { now }), null, `should not infer: ${text}`);
  }
});

test("genuine arrangements still schedule after the intent gate", () => {
  const now = new Date("2026-09-22T09:46:00.000Z");
  const cases = [
    ["20分钟后提醒我继续写简历", "2026-09-22T10:06:00.000Z"],
    ["21:30问我做完没有", "2026-09-22T13:30:00.000Z"],
    ["[敲打]上午8点半做计划，待会马上睡觉了", "2026-09-23T00:30:00.000Z"],
    ["一小时后叫我", "2026-09-22T10:46:00.000Z"],
    ["我8点起的，十点提醒我一下", "2026-09-23T00:00:00.000Z"],
    ["明天下午3点叫我", "2026-09-22T19:00:00.000Z"],
  ];
  for (const [text, dueAt] of cases) {
    const checkpoint = extractExplicitCheckpoint(text, { now });
    assert.ok(checkpoint, `should schedule: ${text}`);
    assert.equal(checkpoint.dueAt, dueAt, `wrong due time for: ${text}`);
  }
  // Inferred activity follow-ups must survive the gate too, otherwise the
  // meal/shower feature silently dies.
  assert.equal(inferContextualCheckpoint("我去吃饭了", { now })?.dueAt, "2026-09-22T10:16:00.000Z");
  assert.equal(inferContextualCheckpoint("我去洗澡了", { now })?.dueAt, "2026-09-22T10:16:00.000Z");
});

test("intent gate reports why a message was rejected", () => {
  assert.equal(resolveArrangementIntent("我没让你明天来找我").reason, "denied");
  assert.equal(resolveArrangementIntent("今天下午开会开到5点").reason, "retrospective");
  assert.equal(resolveArrangementIntent("现在下午5:45了").reason, "clock_announcement");
  assert.equal(resolveArrangementIntent("20分钟后提醒我").ok, true);
  assert.equal(resolveArrangementIntent("").ok, false);
});

test("opted-out callers can still parse a raw time expression", () => {
  const now = new Date("2026-09-22T09:46:00.000Z");
  assert.equal(extractExplicitCheckpoint("我没让你明天17:45来找我", { now }), null);
  assert.ok(extractExplicitCheckpoint("我没让你明天17:45来找我", { now, requireIntent: false }));
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

test("prune keeps pending and deletes expired finished checkpoints", () => {
  const store = makeStore();
  store.store.write({ schemaVersion: 1, checkpoints: [
    rawCheckpoint({ id: "old", state: "completed", dueAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
    rawCheckpoint({ id: "pending", state: "pending", dueAt: "2026-08-23T12:20:00.000Z", createdAt: "2026-08-23T12:00:00.000Z", updatedAt: "2026-08-23T12:00:00.000Z" }),
  ] });
  const removed = store.prune({ keepDays: 30, keepPending: true, now: new Date("2026-08-23T12:00:00.000Z") });
  assert.equal(removed, 1);
  assert.deepEqual(store.list().map((item) => item.id), ["pending"]);
});

test("prune never removes pending even when keepPending is false but not expired", () => {
  const store = makeStore();
  store.store.write({ schemaVersion: 1, checkpoints: [
    rawCheckpoint({ id: "p", state: "pending", dueAt: "2026-08-23T12:20:00.000Z", createdAt: "2026-08-23T12:00:00.000Z", updatedAt: "2026-08-23T12:00:00.000Z" }),
  ] });
  const removed = store.prune({ keepDays: 30, keepPending: false, now: new Date("2026-08-23T12:00:00.000Z") });
  assert.equal(removed, 0);
  assert.equal(store.list().some((item) => item.id === "p"), true);
});

test("prune removes expired pending when keepPending is false", () => {
  const store = makeStore();
  store.store.write({ schemaVersion: 1, checkpoints: [
    rawCheckpoint({ id: "sp", state: "pending", dueAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
  ] });
  const removed = store.prune({ keepDays: 30, keepPending: false, now: new Date("2026-08-23T12:00:00.000Z") });
  assert.equal(removed, 1);
  assert.equal(store.list().some((item) => item.id === "sp"), false);
});

// ---------------------------------------------------------------------------
// Random check-in backoff. A night of unanswered check-ins used to be
// re-scheduled at the same 15-45 min cadence forever, because every random
// checkpoint is replaced the instant the previous one leaves "pending".
// ---------------------------------------------------------------------------

function randomHistory(entries, now = new Date("2026-09-23T08:00:00.000Z")) {
  return entries.map((entry, index) => ({
    source: "random",
    state: entry.state,
    outcome: entry.outcome,
    updatedAt: new Date(now.getTime() - (index + 1) * 30 * 60_000).toISOString(),
    createdAt: new Date(now.getTime() - (index + 1) * 30 * 60_000).toISOString(),
  }));
}

test("random backoff leaves the interval alone for a single missed window", () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  assert.deepEqual(resolveRandomBackoff([], now), { multiplier: 1, streak: 0, capped: false });
  assert.deepEqual(
    resolveRandomBackoff(randomHistory([{ state: "completed", outcome: "queued" }], now), now),
    { multiplier: 1, streak: 1, capped: false },
  );
  // The free streak is 2, so the second one still must not stretch anything.
  assert.deepEqual(
    resolveRandomBackoff(randomHistory([
      { state: "completed", outcome: "queued" },
      { state: "completed", outcome: "queued" },
    ], now), now),
    { multiplier: 1, streak: 2, capped: false },
  );
});

test("random backoff stretches exponentially once check-ins go unanswered", () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  const run = (count) => resolveRandomBackoff(
    randomHistory(Array.from({ length: count }, () => ({ state: "completed", outcome: "queued" })), now),
    now,
  );
  assert.equal(run(3).multiplier, 2);
  assert.equal(run(4).multiplier, 4);
  assert.equal(run(8).multiplier, 8);
  assert.deepEqual(run(20), { multiplier: 8, streak: 20, capped: true });
});

test("dispatcher-dropped checkpoints neither extend nor reset the streak", () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  // A pending arrival means real user activity, so the streak is over.
  assert.equal(resolveRandomBackoff(randomHistory([
    { state: "skipped", outcome: "pending_activity" },
    { state: "completed", outcome: "queued" },
    { state: "completed", outcome: "queued" },
    { state: "completed", outcome: "queued" },
  ], now), now).multiplier, 1);
  // Quiet hours are the dispatcher's own decision, not the user ignoring us.
  assert.equal(resolveRandomBackoff(randomHistory([
    { state: "skipped", outcome: "suppressed_quiet_hours" },
    { state: "completed", outcome: "queued" },
    { state: "completed", outcome: "queued" },
    { state: "completed", outcome: "queued" },
  ], now), now).multiplier, 1);
});

test("an unreachable target is not treated as an unanswered check-in", () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  // No account configured is an infrastructure problem; backing off on it
  // would silently slow the cadence down for a reason the user never caused.
  assert.equal(resolveRandomBackoff(randomHistory([
    { state: "failed", outcome: "target_unavailable" },
    { state: "failed", outcome: "target_unavailable" },
    { state: "failed", outcome: "target_unavailable" },
  ], now), now).multiplier, 1);
  // A generic failure is a real unanswered knock.
  assert.equal(resolveRandomBackoff(randomHistory([
    { state: "failed", outcome: "" },
    { state: "failed", outcome: "" },
    { state: "failed", outcome: "" },
  ], now), now).multiplier, 2);
});

test("the scheduler applies the backoff multiplier to the configured interval", async () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  const finished = randomHistory(Array.from({ length: 6 }, () => ({ state: "completed", outcome: "queued" })), now);
  const added = [];
  const planStore = {
    due: () => [],
    list({ state } = {}) {
      const all = finished.concat(added);
      return state ? all.filter((item) => item.state === state) : all;
    },
    add(item) {
      const created = { id: item.id, state: "pending", ...item };
      added.push(created);
      return created;
    },
    update: () => null,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-backoff-"));
  const dispatcher = new SupervisionDispatcher({
    config: {
      systemMessageQueueFile: path.join(dir, "queue.json"),
      checkinConfigFile: path.join(dir, "checkin.json"),
    },
    desktopStateStore: { get: () => ({ desiredState: "running", randomCheckinsEnabled: true }) },
    planStore,
  });

  dispatcher.ensureRandomCheckpoint(now);

  // "standard" runs 15-45 min, so six unanswered check-ins must land far
  // outside that band -- this is the assertion the old code failed.
  assert.equal(added.length, 1);
  const delayMinutes = (Date.parse(added[0].dueAt) - now.getTime()) / 60_000;
  assert.ok(delayMinutes >= 15 * 8, `expected >= 120 min, got ${delayMinutes}`);
  assert.ok(delayMinutes <= 45 * 8, `expected <= 360 min, got ${delayMinutes}`);
});

test("a fresh streak keeps the plain configured interval", async () => {
  const now = new Date("2026-09-23T08:00:00.000Z");
  const added = [];
  const planStore = {
    due: () => [],
    list: () => added,
    add(item) {
      const created = { id: item.id, state: "pending", ...item };
      added.push(created);
      return created;
    },
    update: () => null,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-supervision-nobackoff-"));
  const dispatcher = new SupervisionDispatcher({
    config: {
      systemMessageQueueFile: path.join(dir, "queue.json"),
      checkinConfigFile: path.join(dir, "checkin.json"),
    },
    desktopStateStore: { get: () => ({ desiredState: "running", randomCheckinsEnabled: true }) },
    planStore,
  });

  dispatcher.ensureRandomCheckpoint(now);

  assert.equal(added.length, 1);
  const delayMinutes = (Date.parse(added[0].dueAt) - now.getTime()) / 60_000;
  assert.ok(delayMinutes >= 15 && delayMinutes <= 45, `expected 15-45 min, got ${delayMinutes}`);
});

