"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveChannelHealth, CHANNEL_STALE_AFTER_MS } = require("../src/desktop/channel-health-view");

const NOW = Date.parse("2026-09-19T02:00:00.000Z");

function activityMinutesAgo(minutes, extra = {}) {
  return {
    recordedAt: new Date(NOW - 1_000).toISOString(),
    lastSuccessAt: new Date(NOW - minutes * 60_000).toISOString(),
    state: "healthy",
    reason: null,
    consecutiveTimeouts: 0,
    consecutiveFailures: 0,
    ...extra,
  };
}

test("a recent successful round trip reads as healthy and not stale", () => {
  const health = resolveChannelHealth({ activity: activityMinutesAgo(1), runtimePhase: "running", nowMs: NOW });
  assert.equal(health.state, "healthy");
  assert.equal(health.hasHeartbeat, true);
  assert.equal(health.lastSuccessMinutes, 1);
  assert.equal(health.stale, false);
});

test("staleness trips exactly at the threshold, not before", () => {
  const almost = resolveChannelHealth({ activity: activityMinutesAgo(29), runtimePhase: "running", nowMs: NOW });
  assert.equal(almost.stale, false);

  const exactly = resolveChannelHealth({
    activity: activityMinutesAgo(CHANNEL_STALE_AFTER_MS / 60_000),
    runtimePhase: "running",
    nowMs: NOW,
  });
  assert.equal(exactly.stale, true);
});

test("a silent channel is only reported while Aidy claims to be running", () => {
  const staleActivity = activityMinutesAgo(120);
  for (const phase of ["running", "quiet"]) {
    assert.equal(resolveChannelHealth({ activity: staleActivity, runtimePhase: phase, nowMs: NOW }).stale, true, phase);
  }
  // Being stopped or already broken is explained by other cards; warning here
  // would just be noise.
  for (const phase of ["stopped", "error", "configuration_required", ""]) {
    assert.equal(resolveChannelHealth({ activity: staleActivity, runtimePhase: phase, nowMs: NOW }).stale, false, phase);
  }
});

test("a running bridge that has never produced a heartbeat gets a grace period", () => {
  const first = resolveChannelHealth({ activity: null, runtimePhase: "running", nowMs: NOW });
  assert.equal(first.state, "unknown");
  assert.equal(first.hasHeartbeat, false);
  assert.equal(first.lastSuccessMinutes, null);
  // Freshly started, so not silent yet -- but the clock has started.
  assert.equal(first.stale, false);
  assert.equal(first.silenceSinceMs, NOW);

  // Same snapshot a minute later: still inside the grace period.
  const minuteLater = resolveChannelHealth({
    activity: null,
    runtimePhase: "running",
    nowMs: NOW + 60_000,
    silenceSinceMs: first.silenceSinceMs,
  });
  assert.equal(minuteLater.stale, false);
  assert.equal(minuteLater.silenceSinceMs, NOW, "the clock must not restart on every snapshot");

  // Past the threshold it finally reports silence.
  const tooLate = resolveChannelHealth({
    activity: null,
    runtimePhase: "running",
    nowMs: NOW + CHANNEL_STALE_AFTER_MS,
    silenceSinceMs: first.silenceSinceMs,
  });
  assert.equal(tooLate.stale, true);
});

test("the grace clock resets when the bridge stops or finally reports in", () => {
  const stopped = resolveChannelHealth({ activity: null, runtimePhase: "stopped", nowMs: NOW, silenceSinceMs: NOW - 60 * 60_000 });
  assert.equal(stopped.silenceSinceMs, null);
  assert.equal(stopped.stale, false);

  const recovered = resolveChannelHealth({
    activity: activityMinutesAgo(0),
    runtimePhase: "running",
    nowMs: NOW,
    silenceSinceMs: NOW - 60 * 60_000,
  });
  assert.equal(recovered.silenceSinceMs, null);
  assert.equal(recovered.stale, false);
});

test("a degraded heartbeat is surfaced with its reason", () => {
  const health = resolveChannelHealth({
    activity: activityMinutesAgo(2, { state: "degraded", reason: "timeout", consecutiveTimeouts: 7 }),
    runtimePhase: "running",
    nowMs: NOW,
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.reason, "timeout");
  assert.equal(health.consecutiveTimeouts, 7);
});

test("an unknown activity payload degrades to unknown instead of throwing", () => {
  for (const activity of [undefined, null, "nonsense", 42, {}, { recordedAt: "not-a-date" }, { recordedAt: new Date(NOW).toISOString() }]) {
    const health = resolveChannelHealth({ activity, runtimePhase: "running", nowMs: NOW });
    assert.equal(health.state, "unknown");
    assert.equal(health.hasHeartbeat, false);
    assert.equal(health.reason, null);
    assert.equal(health.lastSuccessAt, null);
  }
});

test("counts are normalized and pending messages are passed through", () => {
  const health = resolveChannelHealth({
    activity: activityMinutesAgo(1, { consecutiveTimeouts: -3, consecutiveFailures: "abc" }),
    runtimePhase: "running",
    nowMs: NOW,
    pendingMessages: 4,
  });
  assert.equal(health.consecutiveTimeouts, 0);
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.pendingMessages, 4);

  const junk = resolveChannelHealth({ activity: activityMinutesAgo(1), runtimePhase: "running", nowMs: NOW, pendingMessages: -2 });
  assert.equal(junk.pendingMessages, 0);
});

test("a clock that moves backwards does not produce a negative duration", () => {
  const health = resolveChannelHealth({
    activity: activityMinutesAgo(-30), // last success "in the future"
    runtimePhase: "running",
    nowMs: NOW,
  });
  assert.equal(health.lastSuccessMinutes, 0);
  assert.equal(health.stale, false);
});
