// WeChat activity store.
//
// Persists the channel-health snapshot to disk so the desktop parent process can
// read it *while the bridge child process is the writer*. That cross-process
// file IS the heartbeat the audit asked for: it proves liveness even when the
// bridge is still alive but wedged (e.g. only ever timing out).
//
// It reuses AtomicJsonStore for tmp+rename atomicity and its mtime/size read
// cache. Disk writes are throttled to at most once per 30s while healthy, but a
// state transition into or out of `degraded` is always written immediately so
// the user never waits 30s to learn the channel died or recovered.
//
// The `state` field is persisted verbatim across all three channel states. It
// used to be collapsed to a boolean (degraded vs everything-else-is-healthy),
// which meant "never completed a single round trip" was written to disk as
// `state: "healthy"`. Every reader that trusted the field reported a dead
// channel as connected. `unverified` now survives the round trip.
//
// No raw error text is ever persisted. If a textual error detail is stored it is
// passed through the WeChat adapter's redaction helper first.

const path = require("path");
const { AtomicJsonStore } = require("./atomic-json-store");
const { CHANNEL_STATES, UNVERIFIED_STATE } = require("./channel-health");

const ACTIVITY_WRITE_THROTTLE_MS = 30_000;

const DEFAULT_ACTIVITY = Object.freeze({
  schemaVersion: 1,
  state: UNVERIFIED_STATE,
  reason: null,
  consecutiveTimeouts: 0,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastSuccessLatencyMs: null,
  degradedSince: null,
  recordedAt: null,
  lastOutcome: null,
  lastErrorClass: null,
});

class WechatActivityStore {
  constructor({ stateDir, filePath, now = () => new Date() } = {}) {
    if (!filePath && !stateDir) {
      throw new Error("WechatActivityStore requires stateDir or filePath");
    }
    this.filePath = filePath || path.join(stateDir, "wechat-activity.json");
    this.store = new AtomicJsonStore({
      filePath: this.filePath,
      defaultValue: DEFAULT_ACTIVITY,
      normalize: normalizeActivity,
    });
    this._now = now;
    // Seed the in-memory transition tracker from whatever is already on disk so
    // a process restart that immediately recovers (first poll is a success)
    // still writes the recovery promptly instead of thinking it was always
    // healthy.
    const initial = this.store.read();
    this._lastState = normalizeActivityState(initial.state);
    this._lastWriteAt = null;
  }

  read() {
    return this.store.read();
  }

  // `snapshot` is the output of channelHealth.snapshot(); the store persists it
  // verbatim (after normalization) and layers on bookkeeping fields.
  record({ snapshot = {}, outcome = null, latencyMs = null, error = null, at = null } = {}) {
    const atMs = at != null ? Date.parse(at) : null;
    const refMs = Number.isFinite(atMs) ? atMs : this._now().getTime();
    const recordedAt = Number.isFinite(atMs) ? new Date(atMs).toISOString() : this._now().toISOString();

    const persisted = normalizeActivity({
      ...snapshot,
      schemaVersion: 1,
      recordedAt,
      lastOutcome: typeof outcome === "string" ? outcome : null,
      lastErrorClass: safeErrorClass(error),
    });

    const isTransition = this._lastState !== persisted.state;
    const sinceLastWrite = this._lastWriteAt == null ? Infinity : refMs - this._lastWriteAt;
    // Always write on a state transition; otherwise throttle healthy polls to
    // at most once per ACTIVITY_WRITE_THROTTLE_MS.
    const shouldWrite = isTransition || sinceLastWrite >= ACTIVITY_WRITE_THROTTLE_MS || this._lastWriteAt == null;

    if (shouldWrite) {
      this.store.write(persisted);
      this._lastWriteAt = refMs;
      this._lastState = persisted.state;
    }
    return persisted;
  }
}

function safeErrorClass(error) {
  if (!error) return null;
  if (typeof error.pollErrorClass === "string" && error.pollErrorClass) {
    return error.pollErrorClass;
  }
  if (error.name === "AbortError") return "timeout";
  return "unknown";
}

// An unrecognised or missing state normalizes to `unverified`, never `healthy`:
// the safe default for "we do not know that this channel works" is to admit it.
function normalizeActivityState(value) {
  return CHANNEL_STATES.includes(value) ? value : UNVERIFIED_STATE;
}

function normalizeActivity(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: 1,
    state: normalizeActivityState(input.state),
    reason: input.reason === "timeout" || input.reason === "failure" ? input.reason : null,
    consecutiveTimeouts: normalizeNonNegativeInt(input.consecutiveTimeouts),
    consecutiveFailures: normalizeNonNegativeInt(input.consecutiveFailures),
    lastSuccessAt: normalizeIso(input.lastSuccessAt),
    lastSuccessLatencyMs: normalizeNullableNumber(input.lastSuccessLatencyMs),
    degradedSince: normalizeIso(input.degradedSince),
    recordedAt: normalizeIso(input.recordedAt),
    lastOutcome: typeof input.lastOutcome === "string" ? input.lastOutcome : null,
    lastErrorClass: typeof input.lastErrorClass === "string" ? input.lastErrorClass : null,
  };
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

module.exports = { WechatActivityStore, ACTIVITY_WRITE_THROTTLE_MS, DEFAULT_ACTIVITY };
