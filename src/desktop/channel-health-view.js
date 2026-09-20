"use strict";

// Derived from the bridge's heartbeat file (`wechat-activity.json`).
//
// Kept pure and free of Electron so the awkward cases can be tested directly:
// "the bridge has never completed a single round trip" behaves differently from
// "the bridge used to be fine and then went quiet", and only the second one has a
// timestamp to compare against.

const MS_PER_MINUTE = 60_000;

// A long poll normally completes every ~20s and the bridge writes the heartbeat
// at most 30s apart, so half an hour of silence means the bridge is wedged or the
// network is gone -- not that the user simply had nothing to say.
const CHANNEL_STALE_AFTER_MS = 30 * MS_PER_MINUTE;

// The never-succeeded case gets a much shorter grace than the went-quiet case.
// Half an hour was borrowed from the "used to work" threshold, but a channel
// that has never worked has no good state to fall back to: a healthy first poll
// lands in ~20s, so a few minutes of nothing is already abnormal. Waiting the
// full 30 minutes just left the user staring at "connecting" while every
// message went nowhere.
const CHANNEL_NEVER_HEARTBEAT_STALE_AFTER_MS = 3 * MS_PER_MINUTE;

/**
 * @param {object}   options
 * @param {object}   options.activity       Parsed `wechat-activity.json`.
 * @param {string}   options.runtimePhase   The supervisor phase.
 * @param {number}   options.pendingMessages Queued messages the user has not received.
 * @param {number}   options.nowMs          Injectable clock.
 * @param {number?}  options.silenceSinceMs Carried over from the previous call so
 *   a bridge that has never produced a heartbeat still gets a grace period that
 *   survives across snapshots. Pass the returned `silenceSinceMs` back in.
 */
function resolveChannelHealth({
  activity = null,
  runtimePhase = "",
  pendingMessages = 0,
  nowMs = Date.now(),
  silenceSinceMs = null,
} = {}) {
  const source = activity && typeof activity === "object" ? activity : {};
  const lastSuccessAt = normalizeIso(source.lastSuccessAt);
  // A heartbeat requires a recorded liveness timestamp, NOT just a `recordedAt`.
  // A bridge that has only ever failed still writes `recordedAt` on every
  // failure, and treating that as a heartbeat is how "never worked" used to be
  // rendered as a healthy channel.
  const hasHeartbeat = Boolean(normalizeIso(source.recordedAt)) && lastSuccessAt !== null;
  const silentMs = hasHeartbeat ? Math.max(0, nowMs - Date.parse(lastSuccessAt)) : null;
  // Stopped or broken states are already explained by the hero card and the error
  // card, so "silent channel" only applies while Aidy claims to be running.
  const claimsRunning = runtimePhase === "running" || runtimePhase === "quiet";

  let nextSilenceSince = Number.isFinite(silenceSinceMs) ? silenceSinceMs : null;
  if (!claimsRunning || hasHeartbeat) {
    nextSilenceSince = null;
  } else if (nextSilenceSince === null) {
    // First time we see a running-but-heartbeat-less bridge: start the clock, so
    // a freshly started bridge is not reported as silent immediately.
    nextSilenceSince = nowMs;
  }

  const neverHeartbeat = claimsRunning && !hasHeartbeat && nextSilenceSince !== null
    && nowMs - nextSilenceSince >= CHANNEL_NEVER_HEARTBEAT_STALE_AFTER_MS;
  const stale = claimsRunning && (hasHeartbeat ? silentMs >= CHANNEL_STALE_AFTER_MS : neverHeartbeat);

  return {
    // `healthy` requires a heartbeat; the persisted `state` alone is not enough,
    // because a bridge that has never succeeded reports `unverified` and must not
    // be shown as connected.
    state: hasHeartbeat ? (source.state === "degraded" ? "degraded" : "healthy") : "unknown",
    reason: hasHeartbeat && (source.reason === "timeout" || source.reason === "failure") ? source.reason : null,
    lastSuccessAt: hasHeartbeat ? lastSuccessAt : null,
    lastSuccessMinutes: silentMs === null ? null : Math.floor(silentMs / MS_PER_MINUTE),
    consecutiveTimeouts: toNonNegativeInt(source.consecutiveTimeouts),
    consecutiveFailures: toNonNegativeInt(source.consecutiveFailures),
    pendingMessages: toNonNegativeInt(pendingMessages),
    hasHeartbeat,
    stale,
    silenceSinceMs: nextSilenceSince,
  };
}

function normalizeIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function toNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

module.exports = {
  resolveChannelHealth,
  CHANNEL_STALE_AFTER_MS,
  CHANNEL_NEVER_HEARTBEAT_STALE_AFTER_MS,
};
