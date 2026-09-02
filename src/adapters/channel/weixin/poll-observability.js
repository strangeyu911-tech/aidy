const crypto = require("crypto");

const POLL_META = Symbol("cyberboss.weixin.getUpdates.pollMeta");

function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function fingerprint(value) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!normalized) {
    return "empty";
  }
  return `sha256:${crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

function safeUpdateMetadata(update) {
  if (!update || typeof update !== "object") {
    return { updateType: "invalid" };
  }
  const result = {
    updateType: Number.isFinite(Number(update.message_type)) ? Number(update.message_type) : "unknown",
  };
  const messageId = update.message_id;
  if (messageId !== undefined && messageId !== null && String(messageId).trim()) {
    result.messageId = fingerprint(messageId);
  }
  const timestampMs = Number(update.create_time_ms);
  const timestampSeconds = Number(update.create_time);
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    result.timestamp = new Date(timestampMs).toISOString();
  } else if (Number.isFinite(timestampSeconds) && timestampSeconds > 0) {
    result.timestamp = new Date(timestampSeconds * 1000).toISOString();
  }
  const senderId = typeof update.from_user_id === "string" ? update.from_user_id.trim() : "";
  if (senderId) {
    result.senderFingerprint = fingerprint(senderId);
  }
  return result;
}

function classifyPollError(error = {}, meta = {}) {
  const explicit = typeof meta.errorClass === "string" ? meta.errorClass : error.pollErrorClass;
  if (["timeout", "network", "http", "parse", "rpc"].includes(explicit)) {
    return explicit;
  }
  if (meta.rpcSuccess === false) {
    return "rpc";
  }
  if (error?.name === "AbortError" || /\baborted?\b/i.test(String(error?.message || ""))) {
    return "timeout";
  }
  if (Number.isFinite(Number(meta.httpStatus ?? error?.httpStatus))) {
    return "http";
  }
  if (/invalid JSON|returned invalid JSON|parse/i.test(String(error?.message || ""))) {
    return "parse";
  }
  return "network";
}

function safeErrorCode(error = {}, meta = {}) {
  const raw = meta.errorCode ?? error?.code ?? "";
  const normalized = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(normalized) ? normalized : null;
}

function attachPollMeta(target, meta) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) {
    return target;
  }
  Object.defineProperty(target, POLL_META, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ ...meta }),
    writable: false,
  });
  return target;
}

function readPollMeta(value) {
  return value && typeof value === "object" ? value[POLL_META] || null : null;
}

function buildPollResult({
  pollSequenceId,
  startedAt,
  startedMonotonicMs,
  cursorBefore,
  cursorAfter,
  responseMeta = {},
  updates = [],
  parserAcceptedCount = 0,
  parserRejectedCount = 0,
} = {}) {
  const endedMonotonicMs = monotonicNowMs();
  const updateList = Array.isArray(updates) ? updates : [];
  return {
    pollSequenceId,
    startedAt,
    endedAt: new Date().toISOString(),
    startedMonotonicMs,
    endedMonotonicMs,
    latencyMs: Math.max(0, Math.round(endedMonotonicMs - Number(startedMonotonicMs || endedMonotonicMs))),
    outcome: responseMeta.outcome || "success",
    httpStatus: Number.isFinite(Number(responseMeta.httpStatus)) ? Number(responseMeta.httpStatus) : null,
    rpcSuccess: responseMeta.rpcSuccess ?? null,
    rpcCode: responseMeta.rpcCode ?? null,
    responseEmpty: responseMeta.responseEmpty ?? false,
    updateCount: updateList.length,
    parserCandidateCount: updateList.length,
    cursorBefore: fingerprint(cursorBefore),
    cursorAfter: fingerprint(cursorAfter),
    cursorAdvanced: Boolean(cursorAfter && cursorAfter !== cursorBefore),
    parserAcceptedCount,
    parserRejectedCount,
    filteredUpdateCount: parserRejectedCount,
    updateMetadata: updateList.map(safeUpdateMetadata),
  };
}

function buildPollError({
  pollSequenceId,
  startedAt,
  startedMonotonicMs,
  cursorBefore,
  error,
  responseMeta = {},
} = {}) {
  const endedMonotonicMs = monotonicNowMs();
  const errorClass = classifyPollError(error, responseMeta);
  return {
    pollSequenceId,
    startedAt,
    endedAt: new Date().toISOString(),
    startedMonotonicMs,
    endedMonotonicMs,
    latencyMs: Math.max(0, Math.round(endedMonotonicMs - Number(startedMonotonicMs || endedMonotonicMs))),
    errorClass,
    errorCode: safeErrorCode(error, responseMeta),
    httpStatus: Number.isFinite(Number(responseMeta.httpStatus ?? error?.httpStatus))
      ? Number(responseMeta.httpStatus ?? error.httpStatus)
      : null,
    rpcCode: responseMeta.rpcCode ?? null,
    timeout: errorClass === "timeout",
    cursorBefore: fingerprint(cursorBefore),
  };
}

module.exports = {
  POLL_META,
  attachPollMeta,
  buildPollError,
  buildPollResult,
  classifyPollError,
  fingerprint,
  monotonicNowMs,
  readPollMeta,
  safeUpdateMetadata,
  safeErrorCode,
};
