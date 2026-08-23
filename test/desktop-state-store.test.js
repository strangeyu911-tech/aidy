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
