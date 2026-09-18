const test = require("node:test");
const assert = require("node:assert/strict");

const { createChannelHealth } = require("../src/core/channel-health");

// A controllable clock so we can assert degradedSince is stamped exactly once.
function makeClock(start = 1_000) {
  let value = start;
  return {
    now: () => new Date(value),
    advance: (ms) => { value += ms; },
    get value() { return value; },
  };
}

test("a zero-message success counts as liveness and clears degraded", () => {
  const clock = makeClock();
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5, now: clock.now });

  // Drive it degraded via timeouts first.
  for (let i = 0; i < 5; i += 1) health.observe({ outcome: "timeout" });
  assert.equal(health.snapshot().state, "degraded");

  // A subsequent success — even with zero messages — must recover instantly.
  health.observe({ outcome: "success", latencyMs: 123 });
  const snap = health.snapshot();
  assert.equal(snap.state, "healthy");
  assert.equal(snap.reason, null);
  assert.equal(snap.consecutiveTimeouts, 0);
  assert.equal(snap.consecutiveFailures, 0);
  assert.equal(snap.degradedSince, null);
  assert.equal(snap.lastSuccessLatencyMs, 123);
  assert.ok(typeof snap.lastSuccessAt === "string" && snap.lastSuccessAt.length > 0);
});

test("N consecutive timeouts flip to degraded exactly at the threshold", () => {
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5 });

  // N-1 timeouts stay healthy.
  for (let i = 0; i < 4; i += 1) {
    health.observe({ outcome: "timeout" });
    assert.equal(health.snapshot().state, "healthy", `timeout #${i + 1} should stay healthy`);
  }
  assert.equal(health.snapshot().consecutiveTimeouts, 4);

  // The Nth timeout crosses the threshold.
  health.observe({ outcome: "timeout" });
  const snap = health.snapshot();
  assert.equal(snap.state, "degraded");
  assert.equal(snap.reason, "timeout");
  assert.equal(snap.consecutiveTimeouts, 5);
});

test("a single transient failure does not degrade", () => {
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5 });
  health.observe({ outcome: "failure", error: new Error("socket reset") });
  const snap = health.snapshot();
  assert.equal(snap.state, "healthy");
  assert.equal(snap.reason, null);
  assert.equal(snap.consecutiveFailures, 1);
});

test("a failure resets the timeout streak but a timeout does not reset failures", () => {
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5 });

  health.observe({ outcome: "success" });
  health.observe({ outcome: "failure" });
  // Timeout must not clear the failure counter or liveness timestamp.
  health.observe({ outcome: "timeout" });
  let snap = health.snapshot();
  assert.equal(snap.consecutiveFailures, 1);
  assert.equal(snap.consecutiveTimeouts, 1);
  assert.ok(snap.lastSuccessAt !== null);

  // A later failure resets the consecutive timeout streak.
  health.observe({ outcome: "failure" });
  snap = health.snapshot();
  assert.equal(snap.consecutiveFailures, 2);
  assert.equal(snap.consecutiveTimeouts, 0);
});

test("degraded is sticky and only a success clears it", () => {
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5 });
  for (let i = 0; i < 5; i += 1) health.observe({ outcome: "timeout" });
  assert.equal(health.snapshot().state, "degraded");

  // More timeouts while already degraded keep it degraded.
  health.observe({ outcome: "timeout" });
  health.observe({ outcome: "timeout" });
  assert.equal(health.snapshot().state, "degraded");

  // A success clears it.
  health.observe({ outcome: "success" });
  assert.equal(health.snapshot().state, "healthy");
});

test("degradedSince is set once on transition and not rewritten on later observations", () => {
  const clock = makeClock(1_000);
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5, now: clock.now });

  for (let i = 0; i < 5; i += 1) {
    clock.advance(1000);
    health.observe({ outcome: "timeout" });
  }
  const transitionSnap = health.snapshot();
  assert.equal(transitionSnap.state, "degraded");
  const transitionTime = transitionSnap.degradedSince;
  assert.ok(transitionTime !== null);

  // Additional observations advance the clock but must NOT rewrite degradedSince.
  for (let i = 0; i < 3; i += 1) {
    clock.advance(5000);
    health.observe({ outcome: "timeout" });
    assert.equal(health.snapshot().degradedSince, transitionTime, "degradedSince must be stable");
  }
});

test("failures only degrade at the threshold, with reason 'failure'", () => {
  const health = createChannelHealth({ maxConsecutiveTimeouts: 5 });
  for (let i = 0; i < 4; i += 1) {
    health.observe({ outcome: "failure" });
    assert.equal(health.snapshot().state, "healthy");
  }
  health.observe({ outcome: "failure" });
  const snap = health.snapshot();
  assert.equal(snap.state, "degraded");
  assert.equal(snap.reason, "failure");
  assert.equal(snap.consecutiveFailures, 5);
});
