const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SupervisionPlanStore } = require("../src/core/supervision-plan-store");
const {
  ZhijiantimeDailySupervisor,
  buildDailySnapshot,
  classifySystemMessage,
} = require("../src/integrations/zhijiantime/daily-supervisor");
const { decideZhijiantimeFreshness } = require("../src/integrations/zhijiantime/freshness");

function createFixture(initialItems = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-zhijian-daily-"));
  const planStore = new SupervisionPlanStore({ stateDir });
  const state = {
    now: new Date("2026-08-23T12:00:00.000Z"),
    items: initialItems,
    error: null,
    readCount: 0,
  };
  const client = {
    isConfigured: () => true,
    listSchedules: async () => {
      state.readCount += 1;
      if (state.error) throw state.error;
      return { items: state.items.filter((item) => item.kind === "schedule") };
    },
    listTodos: async () => {
      state.readCount += 1;
      if (state.error) throw state.error;
      return { items: state.items.filter((item) => item.kind === "todo") };
    },
    close: async () => {},
  };
  const service = new ZhijiantimeDailySupervisor({
    stateDir,
    client,
    planStore,
    now: () => state.now,
  });
  return { service, planStore, state, stateDir };
}

test("daily snapshot prioritizes overdue, due, upcoming, flexible, future, and completed items", () => {
  const now = new Date("2026-08-23T12:00:00.000Z");
  const daily = buildDailySnapshot({
    date: "2026-08-23",
    readAt: now.toISOString(),
    now,
    schedules: [
      { id: "overdue", title: "逾期", end: "2026-08-23T11:00:00.000Z" },
      { id: "overdue-all-day", title: "逾期全天事项", allDay: true, overdue: true },
      { id: "due", title: "进行中", start: "2026-08-23T11:30:00.000Z", end: "2026-08-23T13:00:00.000Z" },
      { id: "upcoming", title: "快开始", start: "2026-08-23T12:30:00.000Z" },
      { id: "flexible", title: "全天", allDay: true, start: "2026-08-23T00:00:00.000Z" },
      { id: "future", title: "稍后", start: "2026-08-23T14:00:00.000Z" },
      { id: "done", title: "完成", completed: true },
    ],
  });

  assert.deepEqual(daily.items.map((item) => item.priority), [
    "overdue",
    "overdue",
    "due",
    "upcoming",
    "flexible",
    "future",
    "completed",
  ]);
  assert.equal(daily.incompleteCount, 6);
  assert.equal(daily.completedCount, 1);
});

test("random check-in receives verified unfinished items and marks the day planned", async () => {
  const { service } = createFixture([
    { id: "todo-1", kind: "todo", title: "投简历", allDay: true, completed: false },
    { id: "todo-2", kind: "todo", title: "已完成", allDay: true, completed: true },
  ]);

  const result = await service.enrichSystemMessage({ id: "supervision:random:one", text: "random" });
  assert.equal(result.skip, false);
  assert.equal(result.daily.incompleteCount, 1);
  assert.equal(result.record.state, "planned");
  assert.match(result.message.text, /投简历/);
  assert.match(result.message.text, /never nag completed items/);
});

test("empty day requires an exact commitment and creates one planning checkpoint", async () => {
  const { service, planStore, state } = createFixture([]);
  const first = await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  assert.equal(first.skip, false);
  assert.equal(service.snapshot().state, "awaiting_commitment");
  assert.match(first.message.text, /exact follow-up time/);
  assert.match(first.message.text, /指尖时光/);

  const captured = service.capturePlanningCommitment("20分钟后检查我有没有做计划", { sourceRef: "message-1" });
  assert.ok(captured);
  assert.equal(captured.checkpoint.dueAt, "2026-08-23T12:20:00.000Z");
  assert.equal(service.snapshot().state, "followup_scheduled");
  assert.equal(planStore.list({ state: "pending", includeRandom: false }).length, 1);

  state.now = new Date("2026-08-23T12:10:00.000Z");
  const beforeDue = await service.enrichSystemMessage({ id: "supervision:random:two", text: "random" });
  assert.equal(beforeDue.skip, true);
});

test("planning commitment saves 上午8点半 as 08:30 and triggers at that instant", async () => {
  const { service, planStore, state } = createFixture([]);
  state.now = new Date(2026, 7, 29, 0, 10, 0);
  await service.enrichSystemMessage({ id: "checkin:half-hour", text: "random" });
  const captured = service.capturePlanningCommitment("[敲打]上午8点半做计划，待会马上睡觉了", {
    sourceRef: "message-half-hour",
  });
  const persisted = planStore.list({ state: "pending", includeRandom: false })[0];
  assert.equal(new Date(captured.checkpoint.dueAt).getHours(), 8);
  assert.equal(new Date(captured.checkpoint.dueAt).getMinutes(), 30);
  assert.equal(persisted.dueAt, captured.checkpoint.dueAt);
  assert.equal(planStore.due(new Date(2026, 7, 29, 8, 29, 59)).length, 0);
  assert.equal(planStore.due(new Date(2026, 7, 29, 8, 30, 0)).length, 1);
  assert.match(captured.announcement, /08:30/);
});

test("planning follow-up rechecks data and loops until a plan exists", async () => {
  const { service, state } = createFixture([]);
  await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  const captured = service.capturePlanningCommitment("20分钟后再查", { sourceRef: "message-1" });
  state.now = new Date(captured.checkpoint.dueAt);

  const empty = await service.enrichSystemMessage({
    id: `supervision:${captured.checkpoint.id}`,
    text: captured.checkpoint.prompt,
  });
  assert.equal(empty.skip, false);
  assert.equal(service.snapshot().state, "awaiting_commitment");
  assert.match(empty.message.text, /still empty/);
  assert.match(empty.message.text, /another exact follow-up time/);

  state.items = [{ id: "schedule-1", kind: "schedule", title: "写简历", allDay: true, completed: false }];
  const planned = await service.enrichSystemMessage({ id: "supervision:random:three", text: "random" });
  assert.equal(planned.record.state, "planned");
  assert.match(planned.message.text, /写简历/);
});

test("creating a real plan cancels the still-pending planning checkpoint", async () => {
  const { service, planStore, state } = createFixture([]);
  await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  const captured = service.capturePlanningCommitment("30分钟后检查", { sourceRef: "message-1" });
  state.items = [{ id: "todo-1", kind: "todo", title: "今日计划", allDay: true, completed: false }];
  await service.enrichSystemMessage({ id: "supervision:random:two", text: "random" });

  const checkpoint = planStore.list({ includeRandom: false }).find((item) => item.id === captured.checkpoint.id);
  assert.equal(checkpoint.state, "skipped");
  assert.equal(checkpoint.outcome, "planning_created");
  assert.equal(service.snapshot().state, "planned");
});

test("read failures do not claim an empty day or mutate planning state", async () => {
  const { service, state } = createFixture([]);
  state.error = new Error("temporary API error");
  const result = await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  assert.equal(result.skip, false);
  assert.equal(service.snapshot().state, "unseen");
  assert.match(result.message.text, /read failed/);
  assert.match(result.message.text, /Do not infer that today's plan is empty/);
});

test("ordinary user turns do not trigger a Zhijiantime read", async () => {
  const { service, state } = createFixture([{ id: "todo-1", kind: "todo", title: "旧数据", allDay: true }]);
  const result = await service.readFreshForUserTurn("今天心情不错");
  assert.equal(result.required, false);
  assert.equal(state.readCount, 0);
});

test("mutation and explicit refresh language trigger a fresh read", () => {
  for (const text of [
    "我刚刚新建了一个待办",
    "我把日常修改了",
    "我刚刚打卡了",
    "刷新一下指尖时光",
  ]) {
    assert.equal(decideZhijiantimeFreshness(text).required, true, text);
  }
  assert.equal(decideZhijiantimeFreshness("我刚刚喝了水").required, false);
});

test("fresh read uses the current external data instead of a prior snapshot", async () => {
  const { service, state } = createFixture([{ id: "todo-old", kind: "todo", title: "旧缓存", allDay: true }]);
  state.items = [{ id: "todo-new", kind: "todo", title: "刚刚新建", allDay: true }];
  const result = await service.readFreshForUserTurn("我刚刚新建了一个待办");
  assert.equal(result.ok, true);
  assert.match(result.context, /刚刚新建/);
  assert.doesNotMatch(result.context, /旧缓存/);
  assert.equal(state.readCount, 2);
});

test("failed fresh read cannot be represented as an empty or latest cached result", async () => {
  const { service, state } = createFixture([{ id: "todo-old", kind: "todo", title: "旧缓存", allDay: true }]);
  state.error = Object.assign(new Error("temporary DPAPI read failure"), { code: "ZHIJIANTIME_TOOL_FAILED" });
  const result = await service.readFreshForUserTurn("刷新一下指尖时光");
  assert.equal(result.ok, false);
  assert.match(result.context, /fresh 指尖时光 read failed/);
  assert.doesNotMatch(result.context, /旧缓存/);
  assert.match(result.context, /Do not use cached data as the latest result/);
});

test("same-day reschedule supersedes the old planning checkpoint", async () => {
  const { service, planStore } = createFixture([]);
  await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  const first = service.capturePlanningCommitment("20分钟后检查", { sourceRef: "message-1" });
  const second = service.capturePlanningCommitment("改成40分钟后", { sourceRef: "message-2" });
  assert.ok(second);
  const checkpoints = planStore.list({ includeRandom: false });
  assert.equal(checkpoints.find((item) => item.id === first.checkpoint.id).state, "superseded");
  assert.equal(checkpoints.find((item) => item.id === second.checkpoint.id).state, "pending");
  assert.equal(service.snapshot().checkpointId, second.checkpoint.id);
});

test("an overdue follow-up accepts a new exact time without special reschedule wording", async () => {
  const { service, planStore, state } = createFixture([]);
  await service.enrichSystemMessage({ id: "checkin:one", text: "random" });
  service.capturePlanningCommitment("20分钟后检查", { sourceRef: "message-1" });
  state.now = new Date("2026-08-23T12:30:00.000Z");

  const captured = service.capturePlanningCommitment("10分钟后", { sourceRef: "message-2" });
  assert.ok(captured);
  assert.equal(captured.checkpoint.dueAt, "2026-08-23T12:40:00.000Z");
  assert.equal(planStore.list({ state: "pending", includeRandom: false }).length, 1);
});

test("system message classification covers both random schedulers and planning follow-ups", () => {
  assert.equal(classifySystemMessage("checkin:one"), "random");
  assert.equal(classifySystemMessage("supervision:random:one"), "random");
  assert.equal(classifySystemMessage("supervision:zhijiantime-planning:2026-08-23:id"), "planning_followup");
  assert.equal(classifySystemMessage("reminder:one"), "");
});
