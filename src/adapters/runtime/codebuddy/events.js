"use strict";

const {
  extractApprovalCommandTokens,
  extractApprovalFilePath,
  extractApprovalFilePaths,
  buildApprovalMatchTokens,
  buildApprovalCommandPreview,
} = require("../shared/approval-command");

const MAX_VENDOR_USAGE_BYTES = 16 * 1024;
const MAX_APPROVAL_TEXT = 500;

function mapCodeBuddyNotification(notification, context = {}) {
  const threadId = normalizeText(context.threadId || notification?.params?.sessionId);
  const turnId = normalizeText(context.turnId);
  const method = normalizeText(notification?.method);

  if (method === "session/request_permission") {
    return mapPermissionRequest(notification, { ...context, threadId, turnId });
  }
  if (method !== "session/update") return [];

  const update = isRecord(notification.params?.update) ? notification.params.update : {};
  const sessionId = normalizeText(notification.params?.sessionId);
  if (threadId && sessionId && sessionId !== threadId) return [];

  switch (normalizeText(update.sessionUpdate)) {
    case "agent_message_chunk": {
      const text = textContent(update);
      return text ? [{
        type: "runtime.reply.delta",
        payload: {
          threadId,
          turnId,
          itemId: normalizeText(update.messageId) || "assistant-message",
          text,
        },
      }] : [];
    }
    case "tool_call": {
      const toolCallId = normalizeText(update.toolCallId);
      if (!toolCallId) return [];
      return [{
        type: "runtime.tool.started",
        payload: {
          threadId,
          turnId,
          toolCallId,
          toolName: normalizeText(update.title || update.name),
        },
      }];
    }
    case "tool_call_update": {
      const toolCallId = normalizeText(update.toolCallId);
      const status = normalizeText(update.status).toLowerCase();
      if (!toolCallId || !new Set(["completed", "failed", "error", "cancelled"]).has(status)) return [];
      return [{
        type: "runtime.tool.completed",
        payload: {
          threadId,
          turnId,
          toolCallId,
          toolName: normalizeText(update.title || update.name),
          isError: new Set(["failed", "error", "cancelled"]).has(status),
        },
      }];
    }
    case "usage_update": {
      const used = nonNegativeInteger(update.used);
      const size = nonNegativeInteger(update.size);
      if (!used || !size) return [];
      return [{
        type: "runtime.context.updated",
        payload: {
          runtimeId: "codebuddy",
          threadId,
          currentTokens: used,
          contextWindow: size,
          ...(sanitizeVendorUsage(update) ? { vendorUsage: sanitizeVendorUsage(update) } : {}),
        },
      }];
    }
    default:
      return [];
  }
}

function mapCodeBuddyFailure(error, context = {}) {
  const code = mapFailureCode(error);
  const diagnostic = sanitizeFailureDiagnostic(error?.diagnostic);
  return {
    type: "runtime.turn.failed",
    payload: {
      runtimeId: "codebuddy",
      threadId: normalizeText(context.threadId),
      turnId: normalizeText(context.turnId),
      ...(normalizeText(context.turnCorrelation) ? { turnCorrelation: normalizeText(context.turnCorrelation) } : {}),
      code,
      text: failureText(code),
      ...(diagnostic ? { diagnostic } : {}),
    },
  };
}

function normalizeCodeBuddyUsage(value) {
  const source = isRecord(value) ? value : {};
  const usage = {
    inputTokens: nonNegativeInteger(source.inputTokens),
    outputTokens: nonNegativeInteger(source.outputTokens),
  };
  const vendorUsage = sanitizeVendorUsage(source);
  return {
    usage,
    ...(vendorUsage ? { vendorUsage } : {}),
  };
}

function mapPermissionRequest(notification, context) {
  const params = isRecord(notification?.params) ? notification.params : {};
  const requestId = normalizeRpcId(notification?.id);
  const toolCall = isRecord(params.toolCall) ? params.toolCall : null;
  const options = Array.isArray(params.options) ? params.options : [];
  const normalizedOptions = options.map(normalizePermissionOption).filter(Boolean);
  if (!requestId || !context.threadId || !toolCall || !normalizedOptions.length) {
    return [denialInstruction(context, requestId)];
  }

  const toolName = normalizeText(toolCall.title || toolCall.name || toolCall.kind);
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const commandTokens = extractApprovalCommandTokens(rawInput);
  const matchedTokens = buildApprovalMatchTokens({
    toolName,
    commandTokens,
    input: rawInput,
  });
  const command = buildApprovalCommandPreview(matchedTokens) || truncateText(toolName);
  const responseTemplate = {
    kind: "codebuddy_permission",
    supportedCommands: ["yes", "always", "no"],
    optionByCommand: {
      yes: findOption(normalizedOptions, ["allow_once", "allow_always"]),
      always: findOption(normalizedOptions, ["allow_always", "allow_once"]),
      no: findOption(normalizedOptions, ["reject_once", "reject_always", "deny"]),
    },
  };
  if (!responseTemplate.optionByCommand.yes || !responseTemplate.optionByCommand.no) {
    return [denialInstruction(context, requestId)];
  }
  responseTemplate.responseByCommand = {
    yes: { action: "accept", outcome: responseTemplate.optionByCommand.yes },
    always: { action: "accept", outcome: responseTemplate.optionByCommand.always },
    no: { action: "cancel", outcome: responseTemplate.optionByCommand.no },
  };

  return [{
    type: "runtime.approval.requested",
    payload: {
      kind: "command",
      threadId: context.threadId,
      ...(context.turnId ? { turnId: context.turnId } : {}),
      requestId,
      reason: truncateText(toolCall.title || toolCall.kind || "CodeBuddy permission"),
      command,
      filePath: extractApprovalFilePath(rawInput),
      filePaths: extractApprovalFilePaths(rawInput),
      commandTokens: matchedTokens,
      responseTemplate,
    },
  }];
}

function denialInstruction(context, requestId) {
  return {
    type: "runtime.approval.denied",
    payload: {
      runtimeId: "codebuddy",
      threadId: normalizeText(context.threadId),
      turnId: normalizeText(context.turnId),
      requestId,
      code: "CODEBUDDY_APPROVAL_DENIED",
      response: { outcome: "cancelled" },
    },
  };
}

function normalizePermissionOption(option) {
  if (!isRecord(option)) return null;
  const optionId = normalizeText(option.optionId || option.id);
  const kind = normalizeText(option.kind).toLowerCase();
  if (!optionId || !new Set(["allow_once", "allow_always", "reject_once", "reject_always", "deny"]).has(kind)) {
    return null;
  }
  return { optionId, kind };
}

function findOption(options, kinds) {
  return kinds.map((kind) => options.find((option) => option.kind === kind)?.optionId || "").find(Boolean) || "";
}

function textContent(update) {
  if (update?.content?.type === "text" && typeof update.content.text === "string") return update.content.text;
  return typeof update?.text === "string" ? update.text : "";
}

function mapFailureCode(error) {
  const raw = normalizeText(error?.code || error?.error?.code).toUpperCase();
  if (new Set([
    "CODEBUDDY_SESSION_FAILED", "CODEBUDDY_MODEL_UNAVAILABLE", "CODEBUDDY_APPROVAL_EXPIRED",
    "CODEBUDDY_CANCEL_TIMEOUT", "CODEBUDDY_TURN_FAILED", "CANCELLED",
  ]).has(raw)) return raw;
  if (raw.includes("MODEL")) return "CODEBUDDY_MODEL_UNAVAILABLE";
  if (raw.includes("SESSION") || raw.includes("NOT_FOUND")) return "CODEBUDDY_SESSION_FAILED";
  if (raw.includes("RATE") || raw.includes("QUOTA") || raw.includes("LIMIT")) return "CODEBUDDY_TURN_FAILED";
  return "CODEBUDDY_TURN_FAILED";
}

function failureText(code) {
  if (code === "CANCELLED") return "The CodeBuddy turn was cancelled.";
  if (code === "CODEBUDDY_SESSION_FAILED") return "CodeBuddy could not restore the session.";
  if (code === "CODEBUDDY_MODEL_UNAVAILABLE") return "The selected CodeBuddy model is unavailable.";
  if (code === "CODEBUDDY_APPROVAL_EXPIRED") return "请求已过期，模型服务已退出";
  return `CodeBuddy turn failed. [${code}]`;
}

function sanitizeVendorUsage(value) {
  if (!isRecord(value)) return null;
  const sanitized = sanitizeRecord(value, 0, new Set());
  if (!sanitized || !Object.keys(sanitized).length) return null;
  let serialized;
  try { serialized = JSON.stringify(sanitized); } catch { return null; }
  if (Buffer.byteLength(serialized, "utf8") > MAX_VENDOR_USAGE_BYTES) return null;
  return sanitized;
}

function sanitizeRecord(value, depth, seen) {
  if (depth > 4 || value == null) return value;
  if (typeof value !== "object") return typeof value === "string" ? value.slice(0, 1000) : value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeRecord(entry, depth + 1, seen)).filter((entry) => entry !== undefined);
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (/(?:password|secret|token|authorization|credential|identity|session)/iu.test(key)) continue;
    const sanitized = sanitizeRecord(entry, depth + 1, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function normalizeRpcId(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
function sanitizeFailureDiagnostic(value) {
  if (!isRecord(value)) return null;
  const method = normalizeText(value.method);
  const upstreamMessage = truncateText(value.upstreamMessage);
  const upstreamCode = typeof value.upstreamCode === "string" || typeof value.upstreamCode === "number"
    ? value.upstreamCode
    : null;
  const timeoutKind = normalizeText(value.timeoutKind);
  const stage = normalizeText(value.stage);
  const abortSource = normalizeText(value.abortSource);
  const lastEventType = normalizeText(value.lastEventType);
  const hasSseEventCount = Number.isSafeInteger(value.sseEventCount);
  const sseEventCount = nonNegativeInteger(value.sseEventCount);
  const terminalEventSeen = typeof value.terminalEventSeen === "boolean" ? value.terminalEventSeen : null;
  if (!method && !upstreamMessage && upstreamCode == null && !timeoutKind && !stage && !abortSource
    && !lastEventType && !hasSseEventCount && terminalEventSeen == null) return null;
  return {
    ...(method ? { method } : {}),
    ...(upstreamCode == null ? {} : { upstreamCode }),
    ...(upstreamMessage ? { upstreamMessage } : {}),
    ...(timeoutKind ? { timeoutKind } : {}),
    ...(stage ? { stage } : {}),
    ...(abortSource ? { abortSource } : {}),
    ...(hasSseEventCount ? { sseEventCount } : {}),
    ...(terminalEventSeen == null ? {} : { terminalEventSeen }),
    ...(lastEventType ? { lastEventType } : {}),
  };
}
function truncateText(value) { return normalizeText(value).slice(0, MAX_APPROVAL_TEXT); }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

module.exports = { mapCodeBuddyNotification, mapCodeBuddyFailure, normalizeCodeBuddyUsage };
