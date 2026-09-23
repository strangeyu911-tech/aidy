const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesktopStateStore } = require("../src/core/desktop-state-store");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desktop-state-"));
}

test("desktop state persists all three desired states", () => {
  const stateDir = makeStateDir();
  const store = new DesktopStateStore({ stateDir });
  assert.equal(store.get().desiredState, "running");
  store.setDesiredState("quiet");
  assert.equal(new DesktopStateStore({ stateDir }).get().desiredState, "quiet");
  store.setDesiredState("stopped");
  assert.equal(new DesktopStateStore({ stateDir }).get().desiredState, "stopped");
});

test("desktop state preserves a corrupt file and recovers defaults", () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "desktop-state.json");
  fs.writeFileSync(filePath, "{broken", "utf8");
  const store = new DesktopStateStore({ stateDir });
  assert.equal(store.get().desiredState, "running");
  assert.ok(fs.readdirSync(stateDir).some((name) => name.startsWith("desktop-state.json.corrupt-")));
});

test("desktop settings normalize report time and context durations", () => {
  const store = new DesktopStateStore({ stateDir: makeStateDir() });
  const state = store.patch({ reportTime: "25:99", contextDurations: { meal: 45, shower: -1 } });
  assert.equal(state.reportTime, "00:30");
  assert.deepEqual(state.contextDurations, { meal: 45, shower: 30 });
});

test("degenerate quiet hours collapse to the window that actually runs", () => {
  // supervision-policy falls back to 23:00-07:00 when start === end, so a store
  // that persisted "00:30..00:30" showed a valid-looking setting that did
  // nothing. Normalizing at write time keeps disk and behaviour in agreement.
  const store = new DesktopStateStore({ stateDir: makeStateDir() });
  const state = store.patch({ quietHours: { enabled: true, start: "00:30", end: "00:30" } });
  assert.deepEqual(state.quietHours, { enabled: true, start: "23:00", end: "07:00" });
});

test("a real quiet-hours window is preserved verbatim", () => {
  const store = new DesktopStateStore({ stateDir: makeStateDir() });
  const state = store.patch({ quietHours: { enabled: true, start: "22:15", end: "06:45" } });
  assert.deepEqual(state.quietHours, { enabled: true, start: "22:15", end: "06:45" });
});

test("an unparseable quiet-hours bound falls back to the quiet default, not the report time", () => {
  // normalizeClockTime used to default to DEFAULT_DESKTOP_STATE.reportTime, so a
  // malformed start silently became the report time instead of the policy default.
  const store = new DesktopStateStore({ stateDir: makeStateDir() });
  const state = store.patch({ quietHours: { enabled: true, start: "nonsense", end: "07:00" } });
  assert.deepEqual(state.quietHours, { enabled: true, start: "23:00", end: "07:00" });
});
