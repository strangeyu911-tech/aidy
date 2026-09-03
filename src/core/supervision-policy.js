const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const QUIET_HOURS_START = 0;
const QUIET_HOURS_END = 6;

function resolveDueCheckpointAction({
  desiredState,
  checkpoint,
  now = new Date(),
  timeZone = checkpoint?.timezone || DEFAULT_TIME_ZONE,
}) {
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
  if (isTimeSensitiveCheckpoint(checkpoint)) {
    if (isStaleTimeSensitiveCheckpoint(checkpoint, now, timeZone)) {
      return checkpoint.source === "random"
        ? { action: "discard", outcome: "stale_quiet_hours" }
        : { action: "archive", outcome: "stale_quiet_hours" };
    }
    if (isWithinQuietHours(now, timeZone)) {
      return checkpoint.source === "random"
        ? { action: "discard", outcome: "suppressed_quiet_hours" }
        : { action: "archive", outcome: "suppressed_quiet_hours" };
    }
  }
  return { action: "dispatch", outcome: "queued" };
}

function isWithinQuietHours(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) && hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

function isTimeSensitiveCheckpoint(checkpoint) {
  const source = normalizeText(checkpoint?.source).toLowerCase();
  if (source === "random") return true;
  return source === "zhijiantime"
    && normalizeText(checkpoint?.canonicalTaskId).startsWith("zhijiantime:daily-planning:");
}

function isStaleTimeSensitiveCheckpoint(checkpoint, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  if (!isTimeSensitiveCheckpoint(checkpoint)) return false;
  const dueAtMs = Date.parse(normalizeText(checkpoint?.dueAt));
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(dueAtMs)
    && Number.isFinite(nowMs)
    && dueAtMs < nowMs
    && isWithinQuietHours(new Date(dueAtMs), timeZone);
}

function isStaleTimeSensitiveSystemMessage(message, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const source = normalizeText(message?.source).toLowerCase();
  const id = normalizeText(message?.id).toLowerCase();
  const supervisionKey = normalizeText(message?.supervisionKey).toLowerCase();
  const isLegacyDailyPlanning = supervisionKey.startsWith("daily_plan:")
    && (source === "random"
      || source === "zhijiantime"
      || id.startsWith("checkin:")
      || id.startsWith("supervision:random:")
      || id.startsWith("supervision:zhijiantime-planning:"));
  if (message?.taskType !== "supervision" || (!isLegacyDailyPlanning && source !== "random")) {
    return false;
  }
  return isStaleTimeSensitiveCheckpoint({
    source: source || (isLegacyDailyPlanning ? "random" : ""),
    canonicalTaskId: source === "zhijiantime"
      ? `zhijiantime:daily-planning:${supervisionKey.slice("daily_plan:".length)}`
      : "random:current",
    dueAt: message?.dueAt,
  }, now, timeZone);
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_TIME_ZONE,
  QUIET_HOURS_START,
  QUIET_HOURS_END,
  resolveDueCheckpointAction,
  shouldSupersede,
  sourcePriority,
  resolveSupervisionKey,
  buildDailySupervisionKey,
  isWithinQuietHours,
  isTimeSensitiveCheckpoint,
  isStaleTimeSensitiveCheckpoint,
  isStaleTimeSensitiveSystemMessage,
};
