const path = require("path");

const { AtomicJsonStore } = require("./atomic-json-store");

const DESIRED_STATES = new Set(["running", "quiet", "stopped"]);
const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: true,
  start: "23:00",
  end: "07:00",
});
const DEFAULT_DESKTOP_STATE = Object.freeze({
  schemaVersion: 1,
  desiredState: "running",
  lastStableState: "stopped",
  startWithWindows: true,
  randomCheckinsEnabled: true,
  reportEnabled: true,
  reportTime: "00:30",
  timezone: "Asia/Shanghai",
  // Sleep window. Machine-initiated check-ins never fire inside it; a reminder
  // the user asked for at that exact time is explicitly exempt.
  quietHours: DEFAULT_QUIET_HOURS,
  contextDurations: { meal: 30, shower: 30 },
  backfillPaused: false,
  updatedAt: "",
});

class DesktopStateStore {
  constructor({ stateDir, filePath, onCorrupt } = {}) {
    this.store = new AtomicJsonStore({
      filePath: filePath || path.join(stateDir, "desktop-state.json"),
      defaultValue: DEFAULT_DESKTOP_STATE,
      normalize: normalizeDesktopState,
      onCorrupt,
    });
  }

  get() {
    return this.store.read();
  }

  setDesiredState(desiredState) {
    const normalizedState = normalizeDesiredState(desiredState);
    return this.store.update((state) => ({
      ...state,
      desiredState: normalizedState,
      updatedAt: new Date().toISOString(),
    }));
  }

  markStable(stableState) {
    const normalizedState = normalizeDesiredState(stableState);
    return this.store.update((state) => ({
      ...state,
      lastStableState: normalizedState,
      updatedAt: new Date().toISOString(),
    }));
  }

  patch(patch) {
    return this.store.update((state) => ({
      ...state,
      ...(patch && typeof patch === "object" ? patch : {}),
      updatedAt: new Date().toISOString(),
    }));
  }
}

function normalizeDesktopState(value) {
  const input = value && typeof value === "object" ? value : {};
  const contextDurations = input.contextDurations && typeof input.contextDurations === "object"
    ? input.contextDurations
    : {};
  return {
    ...DEFAULT_DESKTOP_STATE,
    desiredState: normalizeDesiredState(input.desiredState, DEFAULT_DESKTOP_STATE.desiredState),
    lastStableState: normalizeDesiredState(input.lastStableState, DEFAULT_DESKTOP_STATE.lastStableState),
    startWithWindows: normalizeBoolean(input.startWithWindows, DEFAULT_DESKTOP_STATE.startWithWindows),
    randomCheckinsEnabled: normalizeBoolean(input.randomCheckinsEnabled, DEFAULT_DESKTOP_STATE.randomCheckinsEnabled),
    reportEnabled: normalizeBoolean(input.reportEnabled, DEFAULT_DESKTOP_STATE.reportEnabled),
    reportTime: normalizeClockTime(input.reportTime),
    timezone: normalizeText(input.timezone) || DEFAULT_DESKTOP_STATE.timezone,
    quietHours: normalizeQuietHours(input.quietHours),
    contextDurations: {
      meal: normalizeMinutes(contextDurations.meal, DEFAULT_DESKTOP_STATE.contextDurations.meal),
      shower: normalizeMinutes(contextDurations.shower, DEFAULT_DESKTOP_STATE.contextDurations.shower),
    },
    backfillPaused: normalizeBoolean(input.backfillPaused, false),
    updatedAt: normalizeIsoTime(input.updatedAt),
  };
}

/**
 * Quiet hours must describe a real window. `start === end` is not "all day" or
 * "never" — it is degenerate, and supervision-policy silently falls back to
 * 23:00-07:00 when it sees it, so the user's saved value has no effect while
 * looking perfectly valid in the UI. Collapse it to the real default here so
 * what is on disk is always what actually runs.
 */
function normalizeQuietHours(value) {
  const input = value && typeof value === "object" ? value : {};
  const start = normalizeClockTime(input.start, DEFAULT_QUIET_HOURS.start);
  const end = normalizeClockTime(input.end, DEFAULT_QUIET_HOURS.end);
  const degenerate = start === end;
  return {
    enabled: normalizeBoolean(input.enabled, DEFAULT_QUIET_HOURS.enabled),
    start: degenerate ? DEFAULT_QUIET_HOURS.start : start,
    end: degenerate ? DEFAULT_QUIET_HOURS.end : end,
  };
}

function normalizeDesiredState(value, fallback = "stopped") {
  const normalized = normalizeText(value).toLowerCase();
  return DESIRED_STATES.has(normalized) ? normalized : fallback;
}

function normalizeClockTime(value, fallback = DEFAULT_DESKTOP_STATE.reportTime) {
  const normalized = normalizeText(value);
  const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? normalized : fallback;
}

function normalizeMinutes(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 24 * 60 ? parsed : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeIsoTime(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_DESKTOP_STATE,
  DEFAULT_QUIET_HOURS,
  DESIRED_STATES,
  DesktopStateStore,
  normalizeDesktopState,
  normalizeQuietHours,
};
