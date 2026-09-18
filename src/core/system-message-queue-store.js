const fs = require("fs");
const path = require("path");

const { isStaleTimeSensitiveSystemMessage } = require("./supervision-policy");

class SystemMessageQueueStore {
  constructor({ filePath, resolveSupervisionKey = null } = {}) {
    this.filePath = filePath;
    this.resolveSupervisionKey = typeof resolveSupervisionKey === "function" ? resolveSupervisionKey : null;
    this.state = { messages: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const normalizedMessages = messages
        .map((message) => normalizeSystemMessage(message, this.resolveSupervisionKey))
        .filter(Boolean)
        .filter((message) => !isStaleTimeSensitiveSystemMessage(message));
      const coalescedMessages = coalesceSystemMessages(normalizedMessages);
      this.state = {
        messages: coalescedMessages.sort(compareSystemMessages),
      };
      if (JSON.stringify(messages) !== JSON.stringify(this.state.messages)) {
        this.save();
      }
    } catch {
      this.state = { messages: [] };
    }
  }

  setSupervisionKeyResolver(resolveSupervisionKey) {
    this.resolveSupervisionKey = typeof resolveSupervisionKey === "function" ? resolveSupervisionKey : null;
    this.load();
    return this.state.messages.slice();
  }

  save() {
    // Atomic write: serialize to a sibling temp file, then rename into place.
    // `rename` is atomic on the target path, so a concurrent reader (e.g. the
    // bridge subprocess draining the queue) never observes a half-written file,
    // and a crash mid-write leaves the previous complete file intact.
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), "utf8");
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Ignore cleanup failure and preserve the original error.
      }
      throw error;
    }
  }

  enqueue(message) {
    this.load();
    const normalized = normalizeSystemMessage(message, this.resolveSupervisionKey);
    if (!normalized) {
      throw new Error("invalid system message");
    }
    const existingIndex = this.state.messages.findIndex((item) => item.id === normalized.id);
    if (existingIndex >= 0) {
      this.state.messages[existingIndex] = normalized;
    } else {
      this.state.messages.push(normalized);
    }
    this.state.messages = coalesceSystemMessages(this.state.messages).sort(compareSystemMessages);
    this.save();
    return normalized;
  }

  drainForAccount(accountId, nowMs = Date.now()) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const drained = [];
    const pending = [];

    for (const message of this.state.messages) {
      const nextAttemptMs = Date.parse(message.nextAttemptAt || "") || 0;
      if (message.accountId === normalizedAccountId && nextAttemptMs <= nowMs) {
        drained.push(message);
      } else {
        pending.push(message);
      }
    }

    if (drained.length) {
      this.state.messages = pending;
      this.save();
    }

    return drained;
  }

  hasPendingForAccount(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) => message.accountId === normalizedAccountId);
  }
}

function normalizeSystemMessage(message, resolveSupervisionKey = null) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const id = normalizeText(message.id);
  const accountId = normalizeText(message.accountId);
  const senderId = normalizeText(message.senderId);
  const workspaceRoot = normalizeText(message.workspaceRoot);
  const text = normalizeText(message.text);
  const createdAt = normalizeIsoTime(message.createdAt);
  const nextAttemptAt = normalizeIsoTime(message.nextAttemptAt);
  const dueAt = normalizeIsoTime(message.dueAt);
  const updatedAt = normalizeIsoTime(message.updatedAt);
  const attempt = normalizeAttempt(message.attempt);
  const lastErrorCode = normalizeText(message.lastErrorCode);
  const taskType = normalizeText(message.taskType) || inferTaskType(id);
  const source = normalizeText(message.source);
  const sendTrigger = normalizeText(message.sendTrigger) || inferSendTrigger(id, taskType);
  const priority = message.priority === undefined
    ? inferPriority(source, taskType)
    : normalizePriority(message.priority);
  const resolvedSupervisionKey = normalizeText(message.supervisionKey)
    || normalizeText(resolveSupervisionKey?.({ ...message, id, accountId, senderId, workspaceRoot, text, createdAt, dueAt, taskType, source, sendTrigger }))
    || inferLegacySupervisionKey(id, dueAt || createdAt, taskType);

  if (!id || !accountId || !senderId || !workspaceRoot || !text) {
    return null;
  }

  return {
    id,
    accountId,
    senderId,
    workspaceRoot,
    text,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || createdAt || new Date().toISOString(),
    dueAt,
    taskType,
    source,
    priority,
    supervisionKey: resolvedSupervisionKey,
    sendTrigger,
    attempt,
    nextAttemptAt,
    lastErrorCode,
  };
}

function coalesceSystemMessages(messages) {
  const result = [];
  const indexByIdentity = new Map();
  const indexById = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    const id = message.id;
    if (indexById.has(id)) {
      const index = indexById.get(id);
      result[index] = message;
      continue;
    }

    const identity = buildSystemMessageIdentity(message);
    if (!identity || !indexByIdentity.has(identity)) {
      const index = result.length;
      result.push(message);
      indexById.set(id, index);
      if (identity) indexByIdentity.set(identity, index);
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    const existing = result[existingIndex];
    const winner = isNewerSystemMessage(message, existing) ? message : existing;
    const merged = mergeCoalescedSystemMessage(existing, winner);
    result[existingIndex] = merged;
    indexById.delete(existing.id);
    indexById.set(merged.id, existingIndex);
  }

  return result.filter(Boolean);
}

function buildSystemMessageIdentity(message) {
  const supervisionKey = normalizeText(message?.supervisionKey);
  if (!supervisionKey) return "";
  return [
    normalizeText(message?.accountId),
    normalizeText(message?.senderId),
    normalizeText(message?.workspaceRoot).toLowerCase(),
    normalizeText(message?.taskType).toLowerCase(),
    supervisionKey,
  ].join("\u0000");
}

function isNewerSystemMessage(left, right) {
  const leftCreated = Date.parse(left?.createdAt || "") || 0;
  const rightCreated = Date.parse(right?.createdAt || "") || 0;
  if (leftCreated !== rightCreated) return leftCreated > rightCreated;
  const leftUpdated = Date.parse(left?.updatedAt || "") || 0;
  const rightUpdated = Date.parse(right?.updatedAt || "") || 0;
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated;
  return String(left?.id || "").localeCompare(String(right?.id || "")) > 0;
}

function mergeCoalescedSystemMessage(existing, winner) {
  const existingPriority = Number.isSafeInteger(Number(existing?.priority)) ? Number(existing.priority) : 0;
  const winnerPriority = Number.isSafeInteger(Number(winner?.priority)) ? Number(winner.priority) : 0;
  return {
    ...winner,
    priority: Math.max(existingPriority, winnerPriority),
  };
}

function inferTaskType(id) {
  const normalized = normalizeText(id).toLowerCase();
  if (normalized.startsWith("supervision:") || normalized.startsWith("checkin:")) return "supervision";
  if (normalized.startsWith("reminder:")) return "reminder";
  if (normalized.startsWith("location:")) return "location";
  if (normalized.startsWith("integration-notice:")) return "integration_notice";
  return "system";
}

function inferSendTrigger(id, taskType) {
  const normalized = normalizeText(id).toLowerCase();
  if (normalized.startsWith("checkin:")) return "checkin_poller";
  if (normalized.startsWith("supervision:")) return "scheduler";
  if (normalized.startsWith("reminder:")) return "reminder_poller";
  if (taskType === "location") return "location_trigger";
  return "system_queue";
}

function inferLegacySupervisionKey(id, dateValue, taskType) {
  if (taskType !== "supervision") return "";
  const normalized = normalizeText(id);
  const planningMatch = normalized.match(/^supervision:zhijiantime-planning:(\d{4}-\d{2}-\d{2}):/);
  if (planningMatch) return `daily_plan:${planningMatch[1]}`;
  if (normalized.startsWith("checkin:") || normalized.startsWith("supervision:random:")) {
    const parsed = Date.parse(normalizeText(dateValue));
    if (!Number.isFinite(parsed)) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(parsed));
    const get = (type) => parts.find((part) => part.type === type)?.value || "";
    return `daily_plan:${get("year")}-${get("month")}-${get("day")}`;
  }
  return "";
}

function normalizeAttempt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizePriority(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function inferPriority(source, taskType) {
  const normalized = normalizeText(source).toLowerCase();
  if (normalized === "conversation") return 40;
  if (normalized === "zhijiantime") return 30;
  if (normalized === "context") return 20;
  if (normalized === "system_report") return 10;
  return taskType === "supervision" ? 0 : 0;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function compareSystemMessages(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  SystemMessageQueueStore,
  normalizeSystemMessage,
  coalesceSystemMessages,
  buildSystemMessageIdentity,
};
