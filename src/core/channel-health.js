// Channel health state machine.
//
// This is the piece that fixes Aidy's fatal "silent but healthy" failure mode:
// the WeChat long-poll can return a synthetic `{ ret: 0, msgs: [] }` on its own
// client timeout, which used to look identical to a real empty idle poll. A real
// empty poll (HTTP 200, zero messages) is the *normal* idle state and proves the
// channel is alive; a timeout proves the opposite and must NOT be treated as
// liveness.
//
// "unverified" closes the other half of that failure mode. The machine used to
// start at "healthy", so a bridge that never completed a single round trip
// still wrote `state: "healthy"` to the heartbeat file -- and anything that read
// that field without separately re-checking `lastSuccessAt` told the user the
// channel was fine while nothing was being delivered. Liveness must be earned by
// an observed success; until then the channel is merely unverified.
//
// The machine is deliberately pure and free of I/O so it can be unit-tested
// without booting the app. The poll loop in app.js is the only caller that
// feeds it observations and reads its snapshot.

const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 5;

const UNVERIFIED_STATE = "unverified";
const HEALTHY_STATE = "healthy";
const DEGRADED_STATE = "degraded";

const CHANNEL_STATES = Object.freeze([UNVERIFIED_STATE, HEALTHY_STATE, DEGRADED_STATE]);

function createChannelHealth({ maxConsecutiveTimeouts = DEFAULT_MAX_CONSECUTIVE_TIMEOUTS, now = () => new Date() } = {}) {
  let state = UNVERIFIED_STATE;
  let reason = null;
  let consecutiveTimeouts = 0;
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastSuccessLatencyMs = null;
  let degradedSince = null;

  function markDegraded(nextReason) {
    // `degradedSince` is set exactly once, on the transition into degraded, and
    // is never rewritten on subsequent observations of the same degraded spell.
    if (state !== DEGRADED_STATE) {
      state = DEGRADED_STATE;
      degradedSince = now().toISOString();
    }
    reason = nextReason;
  }

  function observe({ outcome, latencyMs, error } = {}) {
    if (outcome === "success") {
      // A successful round trip — including one that returned zero messages —
      // is the liveness signal. It resets BOTH counters, records liveness, and
      // instantly clears any degraded state. Recovery outranks the entry rule.
      // This is also the only transition into "healthy": before the first
      // success the channel is unverified, never healthy.
      consecutiveTimeouts = 0;
      consecutiveFailures = 0;
      lastSuccessAt = now().toISOString();
      lastSuccessLatencyMs = Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null;
      degradedSince = null;
      reason = null;
      state = HEALTHY_STATE;
      return "success";
    }

    if (outcome === "timeout") {
      // A timeout is genuinely abnormal (~0.4% in production). It must NOT reset
      // the failure counter or the last-known liveness timestamp — it is simply
      // "not a success".
      consecutiveTimeouts += 1;
      if (consecutiveTimeouts >= maxConsecutiveTimeouts) {
        markDegraded("timeout");
      }
      return "timeout";
    }

    // outcome === "failure": a thrown error (network / http / parse / rpc).
    // A single transient failure is normal (hundreds happen per session) and
    // must NOT flap the state into degraded. Only a sustained run does. We do
    // reset the timeout streak because a fresh failure means the channel is at
    // least attempting a request.
    consecutiveFailures += 1;
    consecutiveTimeouts = 0;
    if (consecutiveFailures >= maxConsecutiveTimeouts) {
      markDegraded("failure");
    }
    return "failure";
  }

  function snapshot() {
    return {
      state,
      reason,
      consecutiveTimeouts,
      consecutiveFailures,
      lastSuccessAt,
      lastSuccessLatencyMs,
      degradedSince,
      // Explicit and redundant with `lastSuccessAt === null` on purpose: this is
      // the field consumers should branch on, so nobody has to remember the
      // null-check to avoid claiming a channel works when it never has.
      everSucceeded: lastSuccessAt !== null,
    };
  }

  return { observe, snapshot };
}

module.exports = {
  createChannelHealth,
  DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
  CHANNEL_STATES,
  UNVERIFIED_STATE,
  HEALTHY_STATE,
  DEGRADED_STATE,
};
