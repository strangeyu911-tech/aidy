"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { AtomicJsonStore } = require("../../../core/atomic-json-store");

const CONVERSATION_SCHEMA_VERSION = 1;
const EMPTY_STATE = Object.freeze({
  schemaVersion: CONVERSATION_SCHEMA_VERSION,
  conversations: [],
});
const TRANSIENT_KEYS = new Set([
  "approvalqueue",
  "approvalrequests",
  "pendingapproval",
  "pendingapprovals",
  "supervision",
  "supervisionstate",
]);

class ConversationStore {
  constructor({ filePath, stateDir, onCorrupt, randomUUID = crypto.randomUUID } = {}) {
    const resolvedFilePath = normalizeText(filePath)
      || (normalizeText(stateDir) ? path.join(stateDir, "conversations.json") : "");
    if (!resolvedFilePath) {
      throw new TypeError("ConversationStore requires filePath or stateDir.");
    }
    this.randomUUID = randomUUID;
    this.store = new AtomicJsonStore({
      filePath: resolvedFilePath,
      defaultValue: EMPTY_STATE,
      normalize: normalizeConversationState,
      onCorrupt,
    });
    this.state = this.store.read();
    if (abortInflightTurns(this.state)) {
      this.save();
    }
  }

  beginTurn(scope, input) {
    const normalizedScope = normalizeRuntimeScope(scope);
    const conversation = this.getOrCreateConversation(normalizedScope);
    if (conversation.archived) {
      throw makeError("Archived profile history cannot accept new turns.", "PROFILE_ARCHIVED");
    }
    const turn = {
      id: requireTurnId(this.randomUUID()),
      status: "inflight",
      input: normalizeMessage(input, "user"),
      assistant: null,
      toolResults: [],
      pendingToolCallIds: [],
    };
    conversation.turns.push(turn);
    this.save();
    return clone(turn);
  }

  commitAssistant(turnId, message) {
    const { conversation, turn } = this.requireInflightTurn(turnId);
    if (conversation.archived) {
      throw makeError("Archived profile history cannot be modified.", "PROFILE_ARCHIVED");
    }
    if (turn.assistant) {
      throw makeError("Assistant message is already committed for this turn.", "ASSISTANT_ALREADY_COMMITTED");
    }
    turn.assistant = normalizeMessage(message, "assistant");
    turn.pendingToolCallIds = extractToolCallIds(turn.assistant);
    if (!turn.pendingToolCallIds.length) {
      turn.status = "committed";
    }
    this.save();
    return clone(turn);
  }

  commitToolResult(turnId, result) {
    const { conversation, turn } = this.requireInflightTurn(turnId);
    if (conversation.archived) {
      throw makeError("Archived profile history cannot be modified.", "PROFILE_ARCHIVED");
    }
    if (!turn.assistant) {
      throw makeError("Tool results require a committed assistant tool call.", "ASSISTANT_NOT_COMMITTED");
    }
    const normalizedResult = normalizeMessage(result, "tool");
    const toolCallId = extractToolResultCallId(normalizedResult);
    if (!toolCallId || !turn.pendingToolCallIds.includes(toolCallId)) {
      throw makeError("Tool result does not match a pending tool call.", "TOOL_CALL_NOT_PENDING");
    }
    turn.toolResults.push(normalizedResult);
    turn.pendingToolCallIds = turn.pendingToolCallIds.filter((candidate) => candidate !== toolCallId);
    if (!turn.pendingToolCallIds.length) {
      turn.status = "committed";
    }
    this.save();
    return clone(turn);
  }

  abortTurn(turnId) {
    const located = findTurn(this.state, turnId);
    if (!located) return null;
    if (located.turn.status === "inflight") {
      located.turn.status = "aborted";
      located.turn.pendingToolCallIds = [];
      this.save();
    }
    return clone(located.turn);
  }

  resume(scope) {
    const normalizedScope = normalizeRuntimeScope(scope);
    const scopeKey = buildRuntimeScopeKey(normalizedScope);
    const conversation = this.state.conversations.find((candidate) => (
      candidate.scopeKey === scopeKey && sameRuntimeScope(candidate.scope, normalizedScope)
    ));
    if (!conversation) {
      return emptyResume(normalizedScope, scopeKey);
    }
    const committed = conversation.turns.filter((turn) => turn.status === "committed");
    return {
      scopeKey,
      scope: clone(conversation.scope),
      messages: committed.flatMap(committedTurnMessages).map(clone),
      turns: committed.map(clone),
      abortedTurns: conversation.turns.filter((turn) => turn.status === "aborted").map(clone),
      readOnly: Boolean(conversation.archived),
      resumable: !conversation.archived,
      reason: conversation.archived ? "profile_deleted" : "",
      pendingApprovals: [],
      supervisionState: null,
    };
  }

  archiveProfile(profileId) {
    const normalizedProfileId = normalizeText(profileId);
    if (!normalizedProfileId) return 0;
    let archived = 0;
    for (const conversation of this.state.conversations) {
      if (conversation.scope.profileId !== normalizedProfileId || conversation.archived) continue;
      conversation.archived = true;
      for (const turn of conversation.turns) {
        if (turn.status === "inflight") {
          turn.status = "aborted";
          turn.pendingToolCallIds = [];
        }
      }
      archived += 1;
    }
    if (archived) this.save();
    return archived;
  }

  getOrCreateConversation(scope) {
    const scopeKey = buildRuntimeScopeKey(scope);
    let conversation = this.state.conversations.find((candidate) => (
      candidate.scopeKey === scopeKey && sameRuntimeScope(candidate.scope, scope)
    ));
    if (!conversation) {
      conversation = {
        scopeKey,
        scope: clone(scope),
        archived: false,
        turns: [],
      };
      this.state.conversations.push(conversation);
    }
    return conversation;
  }

  requireInflightTurn(turnId) {
    const located = findTurn(this.state, turnId);
    if (!located) {
      throw makeError("Conversation turn was not found.", "TURN_NOT_FOUND");
    }
    if (located.turn.status !== "inflight") {
      throw makeError("Conversation turn is not inflight.", "TURN_NOT_INFLIGHT");
    }
    return located;
  }

  save() {
    this.state = this.store.write(this.state);
  }
}

function buildRuntimeScopeKey(scope) {
  const normalized = normalizeRuntimeScope(scope);
  const readable = JSON.stringify([
    normalized.runtimeId,
    normalized.profileId,
    normalized.modelId,
    normalized.secretGeneration,
  ]);
  return crypto.createHash("sha256").update(readable).digest("hex");
}

function normalizeRuntimeScope(value) {
  const source = isRecord(value) ? value : {};
  const runtimeId = normalizeText(source.runtimeId);
  const profileId = normalizeText(source.profileId);
  const modelId = normalizeText(source.modelId);
  const secretGeneration = Number(source.secretGeneration);
  if (!runtimeId || !profileId || !modelId || !Number.isSafeInteger(secretGeneration) || secretGeneration < 0) {
    throw makeError(
      "Runtime scope requires runtimeId, profileId, modelId, and a non-negative integer secretGeneration.",
      "INVALID_RUNTIME_SCOPE",
    );
  }
  return { runtimeId, profileId, modelId, secretGeneration };
}

function normalizeConversationState(value) {
  const source = isRecord(value) ? value : {};
  const conversations = [];
  for (const candidate of Array.isArray(source.conversations) ? source.conversations : []) {
    if (!isRecord(candidate)) continue;
    let scope;
    try {
      scope = normalizeRuntimeScope(candidate.scope);
    } catch {
      continue;
    }
    const turns = (Array.isArray(candidate.turns) ? candidate.turns : [])
      .map(normalizeTurn)
      .filter(Boolean);
    conversations.push({
      scopeKey: buildRuntimeScopeKey(scope),
      scope,
      archived: Boolean(candidate.archived),
      turns,
    });
  }
  return { schemaVersion: CONVERSATION_SCHEMA_VERSION, conversations };
}

function normalizeTurn(value) {
  if (!isRecord(value)) return null;
  const id = normalizeText(value.id);
  if (!id) return null;
  const status = ["inflight", "committed", "aborted"].includes(value.status) ? value.status : "aborted";
  const assistant = isRecord(value.assistant) ? normalizeMessage(value.assistant, "assistant") : null;
  const toolResults = (Array.isArray(value.toolResults) ? value.toolResults : [])
    .filter(isRecord)
    .map((result) => normalizeMessage(result, "tool"));
  const declaredToolCallIds = assistant ? extractToolCallIds(assistant) : [];
  const completedToolCallIds = new Set(toolResults.map(extractToolResultCallId).filter(Boolean));
  const pendingToolCallIds = declaredToolCallIds.filter((toolCallId) => !completedToolCallIds.has(toolCallId));
  const structurallyCommitted = Boolean(assistant) && pendingToolCallIds.length === 0;
  return {
    id,
    status: status === "committed" && !structurallyCommitted ? "aborted" : status,
    input: normalizeMessage(value.input, "user"),
    assistant,
    toolResults,
    pendingToolCallIds: status === "inflight" ? pendingToolCallIds : [],
  };
}

function normalizeMessage(value, fallbackRole) {
  const source = isRecord(value) ? value : {};
  const normalized = sanitizeConversationValue(source);
  if (!normalizeText(normalized.role)) normalized.role = fallbackRole;
  return normalized;
}

function sanitizeConversationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeConversationValue);
  if (!isRecord(value)) return value === undefined ? null : value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !TRANSIENT_KEYS.has(key.replace(/[-_\s]/g, "").toLowerCase()))
      .map(([key, item]) => [key, sanitizeConversationValue(item)]),
  );
}

function extractToolCallIds(message) {
  const candidates = [
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
    ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
    ...(Array.isArray(message.content) ? message.content.filter((item) => item?.type === "tool_use") : []),
  ];
  return [...new Set(candidates.map((call) => normalizeText(call?.id || call?.callId)).filter(Boolean))];
}

function extractToolResultCallId(result) {
  return normalizeText(result?.toolCallId || result?.tool_call_id || result?.callId || result?.tool_use_id);
}

function abortInflightTurns(state) {
  let changed = false;
  for (const conversation of state.conversations) {
    for (const turn of conversation.turns) {
      if (turn.status !== "inflight") continue;
      turn.status = "aborted";
      turn.pendingToolCallIds = [];
      changed = true;
    }
  }
  return changed;
}

function findTurn(state, turnId) {
  const normalizedTurnId = normalizeText(turnId);
  if (!normalizedTurnId) return null;
  for (const conversation of state.conversations) {
    const turn = conversation.turns.find((candidate) => candidate.id === normalizedTurnId);
    if (turn) return { conversation, turn };
  }
  return null;
}

function committedTurnMessages(turn) {
  return [turn.input, turn.assistant, ...turn.toolResults].filter(Boolean);
}

function emptyResume(scope, scopeKey) {
  return {
    scopeKey,
    scope: clone(scope),
    messages: [],
    turns: [],
    abortedTurns: [],
    readOnly: false,
    resumable: true,
    reason: "",
    pendingApprovals: [],
    supervisionState: null,
  };
}

function sameRuntimeScope(left, right) {
  return left.runtimeId === right.runtimeId
    && left.profileId === right.profileId
    && left.modelId === right.modelId
    && left.secretGeneration === right.secretGeneration;
}

function requireTurnId(value) {
  const id = normalizeText(value);
  if (!id) throw makeError("Turn ID is required.", "TURN_ID_REQUIRED");
  return id;
}

function makeError(message, code) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = {
  CONVERSATION_SCHEMA_VERSION,
  ConversationStore,
  buildRuntimeScopeKey,
  normalizeRuntimeScope,
};
