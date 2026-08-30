function resolveDueCheckpointAction({ desiredState, checkpoint }) {
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
  return { action: "dispatch", outcome: "queued" };
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
  resolveDueCheckpointAction,
  shouldSupersede,
  sourcePriority,
  resolveSupervisionKey,
  buildDailySupervisionKey,
};
