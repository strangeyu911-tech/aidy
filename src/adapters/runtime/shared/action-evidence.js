"use strict";

const MUTATION_TOOL_RE = /(?:write|update|create|delete|append|complete|check|mark|clear|remove|finish|toggle|set|save|patch|todo)/iu;
const MUTATION_INTENT_RE = /(?:清掉|清除|修改|更新|删除|勾选|打勾|完成|标记|写入|创建|添加|改好|修好|处理好|清理|完成了|clear(?:ed)?|updat(?:e|ed)|delet(?:e|ed)|mark(?:ed)?|complet(?:e|ed)|creat(?:e|ed)|writ(?:e|ten)|finish(?:ed)?)/iu;
const SUCCESS_CLAIM_RE = /(?:已(?:经)?|成功(?:地)?|全部|都|均)?\s*(?:清掉|清除|修改(?:完成|了)?|更新(?:完成|了)?|删除(?:完成|了)?|勾选|打勾|勾上|完成(?:了)?|做完(?:了)?|标记(?:为完成)?|写入(?:完成|了)?|创建(?:完成|了)?|添加(?:完成|了)?|处理(?:完成|了|好)?|修复(?:完成|了|好)?|修好|搞定(?:了)?|弄好(?:了)?|清理(?:完成|了)?|done|completed|updated|deleted|created|marked|cleared|finished|successfully\s+(?:updated|deleted|created|completed|cleared|marked))/iu;
const CONTRADICTORY_CLAIM_RE = /(?:没法|无法|不能|没有(?:权限|能力|调用|执行)|未(?:调用|执行|修改)|尚未(?:修改|完成)|无法确认|不确定|can't|cannot|couldn't|unable|no\s+(?:write|tool)|unconfirmed)/iu;
const TARGET_VALUE_KEYS = new Set([
  "id", "itemid", "todoid", "taskid", "canonicaltaskid", "title", "name", "label", "task", "target", "targetid",
]);

function buildActionRequest(text) {
  const source = normalizeText(text);
  const requestedTargets = extractActionTargets(source);
  const requiresEvidence = Boolean(source && MUTATION_INTENT_RE.test(source));
  return {
    requiresEvidence,
    requestedTargets,
  };
}

function normalizeActionRequest(value) {
  if (typeof value === "string") return buildActionRequest(value);
  const source = value && typeof value === "object" ? value : {};
  return {
    requiresEvidence: source.requiresEvidence === true,
    requestedTargets: uniqueStrings(source.requestedTargets),
  };
}

function extractActionTargets(text) {
  const source = normalizeText(text);
  if (!source) return [];
  const targets = [];
  const bracketed = /【[^】\r\n]{1,120}】[^\s，。！？；;、]{0,80}/gu;
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const numbered = line.match(/^\s*(?:\d+[.)、:]|[-*])\s*(.+?)\s*$/u);
    if (numbered) {
      const embedded = numbered[1].match(bracketed);
      if (embedded?.[0]) addTarget(targets, embedded[0]);
      else addTarget(targets, numbered[1]);
    }
  }
  const inlineNumbered = /(?:^|[\s：:])\d+[.)、:][\s]*([^\n，。！？；;]+)/gu;
  for (const match of source.matchAll(inlineNumbered)) {
    const embedded = match[1].match(bracketed);
    addTarget(targets, embedded?.[0] || match[1]);
  }
  for (const match of source.matchAll(bracketed)) addTarget(targets, match[0]);
  return uniqueStrings(targets);
}

function createActionEvidenceLedger(actionRequest = {}) {
  return {
    actionRequest: normalizeActionRequest(actionRequest),
    tools: new Map(),
  };
}

function recordCodeBuddyNotification(ledger, notification) {
  if (!ledger || !notification || notification.method !== "session/update") return;
  const update = notification.params?.update;
  if (!update || typeof update !== "object") return;
  const kind = normalizeText(update.sessionUpdate).toLowerCase();
  if (kind === "tool_call") {
    const toolCallId = normalizeText(update.toolCallId);
    if (!toolCallId) return;
    ledger.tools.set(toolCallId, {
      toolCallId,
      toolName: normalizeText(update.title || update.name),
      targets: extractToolTargets(update.rawInput || update.input || update.arguments),
      outcome: "pending",
    });
    return;
  }
  if (kind !== "tool_call_update") return;
  const toolCallId = normalizeText(update.toolCallId);
  if (!toolCallId) return;
  const prior = ledger.tools.get(toolCallId) || {
    toolCallId,
    toolName: normalizeText(update.title || update.name),
    targets: [],
  };
  const status = normalizeText(update.status).toLowerCase();
  const resultPresent = hasResultEvidence(update);
  const outcome = status === "completed" && update.isError !== true && resultPresent
    ? "success"
    : new Set(["failed", "error", "cancelled"]).has(status) || update.isError === true
      ? "failed"
      : "unknown";
  const inputTargets = extractToolTargets(update.rawInput || update.input || update.arguments);
  const resultTargets = extractToolTargets(update.rawOutput || update.output || update.result);
  ledger.tools.set(toolCallId, {
    ...prior,
    toolName: normalizeText(update.title || update.name) || prior.toolName,
    targets: uniqueStrings([...prior.targets, ...inputTargets, ...resultTargets]),
    outcome,
    status,
    resultPresent,
  });
}

function recordRuntimeToolEvent(ledger, event) {
  if (!ledger || !event || typeof event !== "object") return;
  const payload = event.payload || {};
  const toolCallId = normalizeText(payload.toolCallId);
  if (!toolCallId) return;
  const prior = ledger.tools.get(toolCallId) || {
    toolCallId,
    toolName: normalizeText(payload.toolName),
    targets: uniqueStrings(payload.targets),
  };
  if (event.type === "runtime.tool.started") {
    ledger.tools.set(toolCallId, {
      ...prior,
      toolName: normalizeText(payload.toolName) || prior.toolName,
      targets: uniqueStrings([...prior.targets, ...extractToolTargets(payload.input)]),
      outcome: "pending",
    });
    return;
  }
  if (event.type !== "runtime.tool.completed") return;
  const status = normalizeText(payload.status).toLowerCase();
  const outcome = payload.isError === true || new Set(["failed", "error", "cancelled"]).has(status)
    ? "failed"
    : (status === "completed" && payload.resultPresent === true) || payload.outcome === "success"
      ? "success"
      : "unknown";
  ledger.tools.set(toolCallId, {
    ...prior,
    toolName: normalizeText(payload.toolName) || prior.toolName,
    targets: uniqueStrings([...prior.targets, ...extractToolTargets(payload.input), ...extractToolTargets(payload.result)]),
    outcome,
    status,
  });
}

function finalizeActionEvidence(ledger, actionRequest = ledger?.actionRequest) {
  const request = normalizeActionRequest(actionRequest);
  const tools = [...(ledger?.tools?.values?.() || [])].filter((tool) => isMutationTool(tool.toolName));
  const successful = tools.filter((tool) => tool.outcome === "success");
  const failed = tools.filter((tool) => tool.outcome === "failed");
  const unknown = tools.filter((tool) => !new Set(["success", "failed"]).has(tool.outcome));
  const requestedTargets = request.requestedTargets;
  const targetResults = requestedTargets.map((target) => {
    const matches = tools.filter((tool) => tool.targets.some((candidate) => targetsMatch(candidate, target)));
    const successfulMatch = matches.find((tool) => tool.outcome === "success");
    const failedMatch = matches.find((tool) => tool.outcome === "failed");
    const unknownMatch = matches.find((tool) => tool.outcome === "unknown" || tool.outcome === "pending");
    return {
      target,
      status: successfulMatch ? "success" : failedMatch ? "failed" : unknownMatch ? "unknown" : "unconfirmed",
    };
  });
  const status = !request.requiresEvidence
    ? "not_required"
    : !tools.length
      ? "not_called"
      : ((!targetResults.length && successful.length && !failed.length && !unknown.length)
        || (targetResults.length && targetResults.every((item) => item.status === "success") && !failed.length && !unknown.length))
        ? "all_success"
        : successful.length && (failed.length || unknown.length || targetResults.some((item) => item.status !== "success"))
          ? "partial"
          : failed.length && !successful.length && !unknown.length
            ? "failed"
            : "unknown";
  return {
    status,
    requestedTargets,
    targetResults,
    tools: tools.map((tool) => ({
      toolCallId: normalizeText(tool.toolCallId),
      toolName: normalizeText(tool.toolName),
      targets: uniqueStrings(tool.targets),
      outcome: normalizeText(tool.outcome) || "unknown",
    })),
  };
}

function authorizeActionClaim(actionEvidence, { text = "" } = {}) {
  const evidence = actionEvidence && typeof actionEvidence === "object" ? actionEvidence : {};
  if (!containsSuccessClaim(text)) return { allowed: true, reason: "no_success_claim", status: evidence.status || "unknown" };
  if (evidence.status === "all_success" && !CONTRADICTORY_CLAIM_RE.test(text)) {
    return { allowed: true, reason: "verified_success", status: "all_success" };
  }
  return {
    allowed: false,
    reason: evidence.status === "partial" ? "partial_success" : evidence.status || "unknown",
    status: evidence.status || "unknown",
  };
}

function enforceActionClaimReply(text, { actionRequest = {}, actionEvidence = {} } = {}) {
  const source = String(text || "");
  const request = normalizeActionRequest(actionRequest);
  if (!request.requiresEvidence || !containsSuccessClaim(source)) return source;
  const authorization = authorizeActionClaim(actionEvidence, { text: source });
  if (authorization.allowed) return source;
  return formatEvidenceBoundReply(actionEvidence);
}

function formatEvidenceBoundReply(evidence = {}) {
  const results = Array.isArray(evidence.targetResults) ? evidence.targetResults : [];
  const successful = results.filter((item) => item.status === "success").map((item) => item.target);
  const unresolved = results.filter((item) => item.status !== "success").map((item) => item.target);
  if (evidence.status === "all_success" && successful.length) return `已确认完成：${successful.join("、")}。`;
  if (evidence.status === "partial") {
    const successText = successful.length ? `已确认完成：${successful.join("、")}` : "已有部分写入结果";
    const unresolvedText = unresolved.length ? `未确认或未修改：${unresolved.join("、")}` : "仍有项目未确认";
    return `${successText}；${unresolvedText}。`;
  }
  if (evidence.status === "failed") return "写入操作失败，未能确认这些项目已修改。";
  if (evidence.status === "not_called") return "我没有执行可验证的写入操作，不能声称这些项目已修改或已清掉。";
  return "写入结果目前无法确认，不能声称这些项目已修改或已清掉。";
}

function containsSuccessClaim(text) {
  return SUCCESS_CLAIM_RE.test(normalizeText(text));
}

function isMutationTool(toolName) {
  return MUTATION_TOOL_RE.test(normalizeText(toolName));
}

function extractToolTargets(value, key = "", output = []) {
  if (value == null) return output;
  if (typeof value === "string" || typeof value === "number") {
    if (TARGET_VALUE_KEYS.has(normalizeKey(key)) && normalizeText(value)) addTarget(output, value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractToolTargets(item, key, output);
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (TARGET_VALUE_KEYS.has(normalizeKey(entryKey))) extractToolTargets(entryValue, entryKey, output);
    else if (["items", "input", "arguments", "rawInput", "result", "data"].includes(normalizeKey(entryKey))) extractToolTargets(entryValue, entryKey, output);
  }
  return uniqueStrings(output);
}

function hasResultEvidence(update) {
  return Object.prototype.hasOwnProperty.call(update || {}, "result")
    || Object.prototype.hasOwnProperty.call(update || {}, "output")
    || Object.prototype.hasOwnProperty.call(update || {}, "rawOutput")
    || Object.prototype.hasOwnProperty.call(update || {}, "content")
    || update?.isError === true;
}

function targetsMatch(left, right) {
  const a = normalizeTarget(left);
  const b = normalizeTarget(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function addTarget(targets, value) {
  const target = normalizeText(value).replace(/[。！？；;]+$/u, "").trim();
  if (target && target.length <= 180) targets.push(target);
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function normalizeTarget(value) {
  return normalizeText(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

module.exports = {
  authorizeActionClaim,
  buildActionRequest,
  containsSuccessClaim,
  createActionEvidenceLedger,
  enforceActionClaimReply,
  extractActionTargets,
  finalizeActionEvidence,
  normalizeActionRequest,
  recordCodeBuddyNotification,
  recordRuntimeToolEvent,
};
