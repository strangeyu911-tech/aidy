const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { WechatActivityStore, ACTIVITY_WRITE_THROTTLE_MS } = require("../src/core/wechat-activity-store");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-activity-"));
}

// A controllable clock (returns a Date) so the 30s throttle is deterministic.
function makeClock(startMs = 1_000_000) {
  let value = startMs;
  return {
    now: () => new Date(value),
    advance: (ms) => { value += ms; },
  };
}

const HEALTHY_SNAPSHOT = {
  state: "healthy",
  reason: null,
  consecutiveTimeouts: 0,
  consecutiveFailures: 0,
  lastSuccessAt: "2026-09-02T09:00:00.000Z",
  lastSuccessLatencyMs: 19000,
  degradedSince: null,
};

const DEGRADED_SNAPSHOT = {
  state: "degraded",
  reason: "timeout",
  consecutiveTimeouts: 5,
  consecutiveFailures: 0,
  lastSuccessAt: "2026-09-02T08:00:00.000Z",
  lastSuccessLatencyMs: 19000,
  degradedSince: "2026-09-02T09:00:05.000Z",
};

test("real disk round-trip: a second store instance reads back the persisted snapshot", () => {
  const dir = makeTempDir();
  const writer = new WechatActivityStore({ stateDir: dir });
  const recorded = writer.record({ snapshot: HEALTHY_SNAPSHOT, outcome: "success", latencyMs: 19000 });

  // A completely independent instance (simulating the desktop parent process)
  // reads the file the bridge child wrote.
  const reader = new WechatActivityStore({ stateDir: dir });
  const readBack = reader.read();

  assert.equal(readBack.state, "healthy");
  assert.equal(readBack.consecutiveTimeouts, 0);
  assert.equal(readBack.lastSuccessAt, HEALTHY_SNAPSHOT.lastSuccessAt);
  assert.equal(readBack.lastSuccessLatencyMs, 19000);
  assert.equal(readBack.schemaVersion, 1);
  assert.equal(readBack.recordedAt, recorded.recordedAt);
});

test("30s throttle suppresses intermediate healthy writes", () => {
  const clock = makeClock();
  const store = new WechatActivityStore({ stateDir: makeTempDir(), now: clock.now });

  const first = store.record({ snapshot: HEALTHY_SNAPSHOT, outcome: "success" });

  // 10s later, still healthy, with a *different* liveness timestamp. Because of
  // the throttle this must NOT hit disk.
  clock.advance(10_000);
  store.record({
    snapshot: { ...HEALTHY_SNAPSHOT, lastSuccessAt: "2026-09-02T09:00:10.000Z" },
    outcome: "success",
  });

  // The second instance must still see the FIRST write, proving the intermediate
  // write was suppressed.
  const reader = new WechatActivityStore({ stateDir: path.dirname(store.filePath), now: clock.now });
  assert.equal(reader.read().lastSuccessAt, HEALTHY_SNAPSHOT.lastSuccessAt);
});

test("state transition into degraded bypasses the throttle", () => {
  const clock = makeClock();
  const store = new WechatActivityStore({ stateDir: makeTempDir(), now: clock.now });

  store.record({ snapshot: HEALTHY_SNAPSHOT, outcome: "success" });
  clock.advance(5_000); // < throttle window
  const degraded = store.record({ snapshot: DEGRADED_SNAPSHOT, outcome: "timeout" });
  assert.equal(degraded.state, "degraded");

  const reader = new WechatActivityStore({ stateDir: path.dirname(store.filePath), now: clock.now });
  assert.equal(reader.read().state, "degraded");
  assert.equal(reader.read().reason, "timeout");
  assert.equal(reader.read().consecutiveTimeouts, 5);
});

test("recovery out of degraded bypasses the throttle", () => {
  const clock = makeClock();
  const store = new WechatActivityStore({ stateDir: makeTempDir(), now: clock.now });

  store.record({ snapshot: DEGRADED_SNAPSHOT, outcome: "timeout" });
  clock.advance(5_000);
  store.record({ snapshot: HEALTHY_SNAPSHOT, outcome: "success" });

  const reader = new WechatActivityStore({ stateDir: path.dirname(store.filePath), now: clock.now });
  assert.equal(reader.read().state, "healthy");
  assert.equal(reader.read().degradedSince, null);
});

test("a periodic healthy write still occurs once the throttle window elapses", () => {
  const clock = makeClock();
  const store = new WechatActivityStore({ stateDir: makeTempDir(), now: clock.now });

  store.record({ snapshot: HEALTHY_SNAPSHOT, outcome: "success" });
  clock.advance(ACTIVITY_WRITE_THROTTLE_MS + 1);
  const later = store.record({
    snapshot: { ...HEALTHY_SNAPSHOT, lastSuccessAt: "2026-09-02T09:01:00.000Z" },
    outcome: "success",
  });

  const reader = new WechatActivityStore({ stateDir: path.dirname(store.filePath), now: clock.now });
  assert.equal(reader.read().lastSuccessAt, "2026-09-02T09:01:00.000Z");
  assert.equal(later.recordedAt, reader.read().recordedAt);
});

test("a corrupt / truncated file is tolerated without throwing", () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, "wechat-activity.json");
  fs.writeFileSync(filePath, '{ "state": "degraded", "reason": "timeout", "lastSuc'); // truncated JSON

  const reader = new WechatActivityStore({ filePath });
  // Must not throw; must return a normalized default-shaped snapshot. The default
  // is "unverified", not "healthy": an unreadable heartbeat file is no evidence
  // that the channel ever worked.
  const snap = reader.read();
  assert.equal(snap.state, "unverified");
  assert.equal(snap.reason, null);
  assert.equal(snap.consecutiveTimeouts, 0);
  assert.equal(snap.schemaVersion, 1);
});

test("no raw error text is persisted; only a bounded error class category", () => {
  const store = new WechatActivityStore({ stateDir: makeTempDir() });
  const error = Object.assign(new Error("socket reset with secret-token-xyz"), { pollErrorClass: "network" });
  const recorded = store.record({
    snapshot: DEGRADED_SNAPSHOT,
    outcome: "failure",
    error,
  });
  // Only the safe, short category is stored — never the raw message text, which
  // could contain a token.
  assert.equal(recorded.lastErrorClass, "network");
  assert.equal(recorded.lastOutcome, "failure");
});

test("an unverified state survives the disk round trip instead of being flattened to healthy", () => {
  const dir = makeTempDir();
  const writer = new WechatActivityStore({ stateDir: dir });
  // The exact shape a bridge that has only ever failed writes: `recordedAt` is
  // refreshed on every failed poll while `lastSuccessAt` stays null forever.
  // Collapsing this to `healthy` on disk is what let the desktop tell the user
  // WeChat was connected while nothing was being delivered.
  const recorded = writer.record({
    snapshot: { state: "unverified", reason: null, consecutiveTimeouts: 0, consecutiveFailures: 1, lastSuccessAt: null },
    outcome: "failure",
  });
  assert.equal(recorded.state, "unverified");

  const reader = new WechatActivityStore({ stateDir: dir });
  const readBack = reader.read();
  assert.equal(readBack.state, "unverified");
  assert.equal(readBack.lastSuccessAt, null);
  assert.ok(readBack.recordedAt, "recordedAt is still written on failure");
});
