const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesktopStateStore } = require("../src/core/desktop-state-store");
const { SupervisionPlanStore } = require("../src/core/supervision-plan-store");
const { ZhijiantimeSyncService, matchExternalItems } = require("../src/integrations/zhijiantime/sync-service");

function createFixture(items = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-zhijian-"));
  const desktopStateStore = new DesktopStateStore({ stateDir });
  desktopStateStore.setDesiredState("running");
  const planStore = new SupervisionPlanStore({ stateDir });
  const updates = [];
  const notices = [];
  const client = {
    isConfigured: () => true,
    listSchedules: async () => ({ items: items.filter((item) => item.kind === "schedule") }),
    listTodos: async () => ({ items: items.filter((item) => item.kind === "todo") }),
    updateItem: async (kind, payload) => { updates.push({ kind, payload }); return {}; },
    close: async () => {},
  };
  const service = new ZhijiantimeSyncService({ stateDir, client, desktopStateStore, planStore, notify: async (text) => notices.push(text), now: () => new Date("2026-08-23T12:00:00.000Z") });
  return { service, planStore, updates, notices };
}

test("today external items create one linked checkpoint without duplicates", async () => {
  const item = { id: "1", kind: "schedule", title: "写简历", date: "2026-08-23", start: "2026-08-23T21:00:00+08:00", end: null, allDay: false, completed: false };
  const { service, planStore } = createFixture([item]);
  await service.sync();
  await service.sync();
  const checkpoints = planStore.list({ includeRandom: false });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].sourceRef, "schedule:1");
});

test("later external time wins and emits a non-blocking notice", async () => {
  const item = { id: "1", kind: "schedule", title: "写简历", date: "2026-08-23", start: "2026-08-23T21:00:00+08:00", end: null, allDay: false, completed: false };
  const { service, planStore, notices } = createFixture([item]);
  await service.sync();
  item.start = "2026-08-23T22:00:00+08:00";
  await service.sync();
  assert.equal(planStore.list()[0].dueAt, "2026-08-23T14:00:00.000Z");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /先按这个新时间/);
});

test("explicit WeChat time writes back only on one unambiguous title match", async () => {
  const item = { id: "todo-1", kind: "todo", title: "写简历", date: "2026-08-23", start: "2026-08-23T20:00:00+08:00", end: null, allDay: false, completed: false };
  const { service, planStore, updates } = createFixture([item]);
  planStore.add({ canonicalTaskId: "conversation:写简历", title: "写简历", source: "conversation", dueAt: "2026-08-23T13:30:00.000Z" });
  await service.sync();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { kind: "todo", payload: { id: "todo-1", date: "2026-08-23", start_time: "21:30" } });
  assert.equal(planStore.list().find((item) => item.source === "conversation").sourceRef, "todo:todo-1");
});

test("ambiguous matching never writes external items", () => {
  const checkpoint = { title: "写简历", dueAt: "2026-08-23T13:30:00.000Z" };
  const items = [
    { id: "1", title: "写简历", date: "2026-08-23" },
    { id: "2", title: "写简历", date: "2026-08-23" },
  ];
  assert.equal(matchExternalItems(checkpoint, items).length, 2);
});
