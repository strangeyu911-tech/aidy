const DEFAULT_TIME_ZONE = "Asia/Shanghai";

// Quiet hours used to be hard-coded 00:00-06:00 and only protected two kinds of
// checkpoint, so a user who asked for a 09:00 reminder could still be woken up
// by a late redelivery. They are now a configurable window (see
// `desktop-state-store.js`) and, by default, protect every checkpoint source.
const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: true,
  start: "23:00",
  end: "07:00",
});

const MINUTES_PER_DAY = 24 * 60;

// A checkpoint whose due time fell inside quiet hours is delivered late rather
// than dropped, but only while it is still meaningful. Beyond this grace period
// it is stale and gets archived, so waking the app after a week cannot produce
// a burst of week-old check-ins.
const QUIET_LATE_GRACE_MS = 6 * 60 * 60_000;

function resolveDueCheckpointAction({
  desiredState,
  checkpoint,
  now = new Date(),
  timeZone = checkpoint?.timezone || DEFAULT_TIME_ZONE,
  quietHours = DEFAULT_QUIET_HOURS,
} = {}) {
  if (!checkpoint || checkpoint.state !== "pending") {
    return { action: "ignore", outcome: "not_pending" };
  }
  if (desiredState === "stopped") {
    return { action: "hold", outcome: "service_stopped" };
  }
  if (desiredState === "quiet") {
    return checkpoint.source === "random"
      ? { action: "discard", outcome: "suppressed_quiet" }
      : { action: "archive", outcome: "suppressed_quiet" };
  }
  const nowDate = toDate(now) || new Date();
  const dueAtMs = Date.parse(normalizeText(checkpoint.dueAt));
  const dueInsideQuietHours = Number.isFinite(dueAtMs)
    && isWithinQuietHours(new Date(dueAtMs), timeZone, quietHours);

  // Staleness is checked before the exempt shortcut on purpose: an explicit
  // request made days ago must not survive a laptop that was asleep for a week,
  // otherwise waking the app replays a burst of dead reminders.
  if (dueInsideQuietHours && Number.isFinite(dueAtMs) && nowDate.getTime() - dueAtMs > QUIET_LATE_GRACE_MS) {
    return checkpoint.source === "random"
      ? { action: "discard", outcome: "stale_quiet_hours" }
      : { action: "archive", outcome: "stale_quiet_hours" };
  }

  // The user explicitly asked for this one at a time inside quiet hours, or it
  // is a direct request made while they are clearly awake. Honour it as asked.
  if (isQuietHoursExempt(checkpoint)) {
    return { action: "dispatch", outcome: "queued" };
  }

  if (isWithinQuietHours(nowDate, timeZone, quietHours)) {
    // Random check-ins are opportunistic: dropping one costs nothing because a
    // fresh one is scheduled anyway. Everything else is deferred to the end of
    // the window instead of being silently thrown away.
    if (checkpoint.source === "random") {
      return { action: "discard", outcome: "suppressed_quiet_hours" };
    }
    const deferTo = resolveQuietHoursEnd(nowDate, timeZone, quietHours);
    if (!deferTo) {
      return { action: "archive", outcome: "suppressed_quiet_hours" };
    }
    return {
      action: "defer",
      outcome: "deferred_quiet_hours",
      deferTo: deferTo.toISOString(),
    };
  }

  return { action: "dispatch", outcome: "queued" };
}

function isQuietHoursExempt(checkpoint) {
  return checkpoint?.exemptQuietHours === true;
}

function isWithinQuietHours(value, timeZone = DEFAULT_TIME_ZONE, quietHours = DEFAULT_QUIET_HOURS) {
  const date = toDate(value);
  if (!date) return false;
  const window = resolveQuietHoursWindow(quietHours);
  if (!window) return false;
  const minutes = resolveLocalMinutes(date, timeZone);
  if (minutes === null) return false;
  if (window.startMinutes < window.endMinutes) {
    return minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  // Wraps midnight, e.g. 23:00 -> 07:00.
  return minutes >= window.startMinutes || minutes < window.endMinutes;
}

/**
 * Normalises the configured quiet-hours window into minutes-of-day.
 * Returns null when quiet hours are disabled or the window is degenerate.
 */
function resolveQuietHoursWindow(quietHours = DEFAULT_QUIET_HOURS) {
  if (quietHours && quietHours.enabled === false) {
    return null;
  }
  const start = parseClockMinutes(quietHours?.start);
  const end = parseClockMinutes(quietHours?.end);
  if (start === null || end === null || start === end) {
    const fallbackStart = parseClockMinutes(DEFAULT_QUIET_HOURS.start);
    const fallbackEnd = parseClockMinutes(DEFAULT_QUIET_HOURS.end);
    return { startMinutes: fallbackStart, endMinutes: fallbackEnd };
  }
  return { startMinutes: start, endMinutes: end };
}

/**
 * The next instant at which `date` leaves the quiet-hours window, in `timeZone`.
 * Returns null when quiet hours are disabled.
 */
function resolveQuietHoursEnd(date, timeZone = DEFAULT_TIME_ZONE, quietHours = DEFAULT_QUIET_HOURS) {
  const window = resolveQuietHoursWindow(quietHours);
  if (!window) return null;
  const local = resolveLocalDateTimeParts(date, timeZone);
  if (!local) return null;
  const minutes = local.hour * 60 + local.minute;
  const wrapsMidnight = window.startMinutes >= window.endMinutes;
  const crossesDayBoundary = wrapsMidnight && minutes >= window.startMinutes;
  return zonedWallTimeToDate({
    year: local.year,
    month: local.month,
    day: local.day + (crossesDayBoundary ? 1 : 0),
    hour: Math.floor(window.endMinutes / 60),
    minute: window.endMinutes % 60,
  }, timeZone);
}

/** Legacy helper: true when the checkpoint was scheduled inside quiet hours. */
function isTimeSensitiveCheckpoint(checkpoint, quietHours = DEFAULT_QUIET_HOURS, timeZone = DEFAULT_TIME_ZONE) {
  const dueAtMs = Date.parse(normalizeText(checkpoint?.dueAt));
  if (!Number.isFinite(dueAtMs)) return false;
  return isWithinQuietHours(new Date(dueAtMs), checkpoint?.timezone || timeZone, quietHours);
}

function isStaleTimeSensitiveCheckpoint(checkpoint, now = new Date(), timeZone = DEFAULT_TIME_ZONE, quietHours = DEFAULT_QUIET_HOURS) {
  if (!isTimeSensitiveCheckpoint(checkpoint, quietHours, timeZone)) return false;
  const dueAtMs = Date.parse(normalizeText(checkpoint?.dueAt));
  const nowMs = toDate(now)?.getTime();
  if (!Number.isFinite(dueAtMs) || !Number.isFinite(nowMs)) return false;
  return dueAtMs < nowMs && nowMs - dueAtMs > QUIET_LATE_GRACE_MS;
}

function isStaleTimeSensitiveSystemMessage(message, now = new Date(), timeZone = DEFAULT_TIME_ZONE, quietHours = DEFAULT_QUIET_HOURS) {
  if (message?.taskType !== "supervision") {
    return false;
  }
  const source = normalizeText(message?.source).toLowerCase();
  const id = normalizeText(message?.id).toLowerCase();
  const supervisionKey = normalizeText(message?.supervisionKey).toLowerCase();
  const isLegacyDailyPlanning = supervisionKey.startsWith("daily_plan:")
    && (source === "random"
      || source === "zhijiantime"
      || id.startsWith("checkin:")
      || id.startsWith("supervision:random:")
      || id.startsWith("supervision:zhijiantime-planning:"));
  if (!isLegacyDailyPlanning && source !== "random") {
    return false;
  }
  return isStaleTimeSensitiveCheckpoint({
    source: source || (isLegacyDailyPlanning ? "random" : ""),
    canonicalTaskId: source === "zhijiantime"
      ? `zhijiantime:daily-planning:${supervisionKey.slice("daily_plan:".length)}`
      : "random:current",
    dueAt: message?.dueAt,
  }, now, timeZone, quietHours);
}

function sourcePriority(source) {
  if (source === "conversation") return 40;
  if (source === "zhijiantime") return 30;
  if (source === "context") return 20;
  if (source === "system_report") return 10;
  return 0;
}

function shouldSupersede(existing, incoming) {
  if (!existing || existing.state !== "pending" || !incoming) return false;
  if (existing.canonicalTaskId !== incoming.canonicalTaskId) return false;
  const existingTime = Date.parse(existing.updatedAt || existing.createdAt || "") || 0;
  const incomingTime = Date.parse(incoming.updatedAt || incoming.createdAt || "") || Date.now();
  if (incomingTime < existingTime) return false;
  if (incoming.source === "context" && sourcePriority(existing.source) > sourcePriority("context")) return false;
  return true;
}

function resolveSupervisionKey(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") {
    return "";
  }

  const source = normalizeText(checkpoint.source).toLowerCase();
  const canonicalTaskId = normalizeText(checkpoint.canonicalTaskId);
  if (source === "random") {
    return buildDailySupervisionKey(checkpoint.dueAt || checkpoint.createdAt) || canonicalTaskId;
  }

  if (source === "zhijiantime" && canonicalTaskId.startsWith("zhijiantime:daily-planning:")) {
    const date = canonicalTaskId.slice("zhijiantime:daily-planning:".length).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return `daily_plan:${date}`;
    }
  }

  return canonicalTaskId;
}

function buildDailySupervisionKey(value) {
  const parsed = Date.parse(normalizeText(value));
  if (!Number.isFinite(parsed)) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(parsed));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `daily_plan:${date}` : "";
}

function parseClockMinutes(value) {
  const match = normalizeText(value).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

function resolveLocalMinutes(date, timeZone) {
  const parts = resolveLocalDateTimeParts(date, timeZone);
  if (!parts) return null;
  return parts.hour * 60 + parts.minute;
}

function resolveLocalDateTimeParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const resolved = { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
    return Object.values(resolved).every((value) => Number.isInteger(value)) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Converts wall-clock parts in `timeZone` to an absolute Date. China has no DST
 * so a single offset correction is exact, but the loop keeps this honest for
 * zones that do.
 */
function zonedWallTimeToDate(parts, timeZone) {
  const naiveMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let candidate = naiveMs;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const local = resolveLocalDateTimeParts(new Date(candidate), timeZone);
    if (!local) break;
    const localMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
    const offset = localMs - candidate;
    const next = naiveMs - offset;
    if (next === candidate) break;
    candidate = next;
  }
  const result = new Date(candidate);
  return Number.isFinite(result.getTime()) ? result : null;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_TIME_ZONE,
  DEFAULT_QUIET_HOURS,
  QUIET_LATE_GRACE_MS,
  MINUTES_PER_DAY,
  resolveDueCheckpointAction,
  isQuietHoursExempt,
  shouldSupersede,
  sourcePriority,
  resolveSupervisionKey,
  buildDailySupervisionKey,
  isWithinQuietHours,
  resolveQuietHoursWindow,
  resolveQuietHoursEnd,
  isTimeSensitiveCheckpoint,
  isStaleTimeSensitiveCheckpoint,
  isStaleTimeSensitiveSystemMessage,
};
