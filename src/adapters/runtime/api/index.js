"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { SessionStore } = require("../codex/session-store");
const { ConversationStore, normalizeRuntimeScope } = require("./conversation-store");
const { createProtocolClient } = require("./protocol-client");
const { RuntimeToolBridge } = require("./tool-bridge");
const { runAgentTurn } = require("./agent-loop");

function createApiRuntimeAdapter({ config = {}, profile, secrets = {}, projectToolHost, profileStore } = {}) {
  const normalizedProfile = requireProfile(profile);
  const stateDir = normalizeText(config.stateDir) || process.cwd();
  const sessionStore = new SessionStore({
    filePath: normalizeText(config.sessionsFile) || path.join(stateDir, "api-sessions.json"),
    runtimeId: "builtin-api",
  });
  const conversationStore = new ConversationStore({
    filePath: normalizeText(config.apiConversationsFile) || path.join(stateDir, "api-conversations.json"),
  });
  const emitter = new EventEmitter();
  const randomUUID = typeof config.randomUUID === "function" ? config.randomUUID : crypto.randomUUID;
  const pendingTurns = new Map();
  const pendingApprovals = new Map();
  let client = null;
  let initialized = false;
  let closed = false;

  const toolBridge = new RuntimeToolBridge({
    projectToolHost,
    requestApproval({ call, context, signal }) {
      return waitForApproval({ call, context, signal });
    },
  });

  function runtimeScope() {
    return normalizeRuntimeScope({
      runtimeId: "builtin-api",
      profileId: normalizedProfile.id,
      modelId: normalizedProfile.modelId,
      secretGeneration: normalizedProfile.secretGeneration,
    });
  }

  function ensureClient() {
    if (!client) {
      client = config.protocolClient || createProtocolClient({
        profile: normalizedProfile,
        secrets,
        fetchImpl: config.fetchImpl || globalThis.fetch,
        capture: config.capture || null,
      });
    }
    return client;
  }

  function emit(event) {
    emitter.emit("event", event);
  }

  function waitForApproval({ call, context, signal }) {
    if (signal?.aborted) return Promise.reject(runtimeError("CANCELLED", "The approval request was cancelled."));
    const requestId = uniqueRequestId(randomUUID, pendingApprovals);
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
      const onAbort = () => {
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        pendingApprovals.delete(requestId);
        cleanup();
        reject(runtimeError("CANCELLED", "The approval request was cancelled."));
      };
      pendingApprovals.set(requestId, {
        turnId: normalizeText(context.turnId),
        resolve(value) { cleanup(); resolve(value); },
        reject(error) { cleanup(); reject(error); },
      });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      emit({
        type: "runtime.approval.requested",
        payload: {
          kind: "tool",
          threadId: normalizeText(context.threadId),
          turnId: normalizeText(context.turnId),
          requestId,
          reason: call.name,
          command: call.name,
          commandTokens: [call.name],
        },
      });
    });
  }

  function rejectApprovalsForTurn(turnId, error) {
    for (const [requestId, pending] of pendingApprovals.entries()) {
      if (pending.turnId !== turnId) continue;
      pendingApprovals.delete(requestId);
      pending.reject(error);
    }
  }

  function scheduleTurn({ conversation, context }) {
    const controller = new AbortController();
    const entry = { controller, conversation, promise: null };
    const promise = new Promise((resolve, reject) => {
      setImmediate(() => {
        Promise.resolve().then(() => runAgentTurn({
          client: ensureClient(),
          conversation,
          toolBridge,
          signal: controller.signal,
          emit,
          context,
          limits: {
            maxToolSteps: 8,
            timeoutMs: 10 * 60_000,
          },
          async beforeFailure(error) {
            if (!isDefinitiveAuthenticationFailure(error)) return;
            await Promise.resolve(
              profileStore?.markUnverified?.(normalizedProfile.id, "invalid_credentials"),
            ).catch(() => {});
          },
        })).then(resolve, reject);
      });
    });
    entry.promise = promise;
    pendingTurns.set(conversation.turnId, entry);
    promise.catch(() => {}).finally(() => {
      rejectApprovalsForTurn(
        conversation.turnId,
        runtimeError("CANCELLED", "The model turn is no longer active."),
      );
      pendingTurns.delete(conversation.turnId);
    });
  }

  const adapter = {
    describe() {
      return {
        id: "builtin-api",
        profileId: normalizedProfile.id,
        model: normalizedProfile.modelId,
        provider: normalizedProfile.providerId,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities() {
      const verified = isRecord(normalizedProfile.capabilities) ? normalizedProfile.capabilities : {};
      return {
        nativeImageInput: Boolean(verified.imageInput || verified.nativeImageInput),
        toolImageRead: false,
      };
    },
    async initialize() {
      if (normalizedProfile.status !== "verified") {
        throw runtimeError("PROFILE_NOT_VERIFIED", "The built-in API profile must be verified before use.");
      }
      if (closed) throw runtimeError("RUNTIME_CLOSED", "The built-in API runtime is closed.");
      ensureClient();
      initialized = true;
      return {
        profileId: normalizedProfile.id,
        model: normalizedProfile.modelId,
        provider: normalizedProfile.providerId,
        tools: toolBridge.listTools(),
      };
    },
    async close() {
      closed = true;
      const cancellation = runtimeError("CANCELLED", "The built-in API runtime was closed.");
      for (const [turnId, entry] of pendingTurns.entries()) {
        entry.controller.abort();
        conversationStore.abortTurn(turnId);
        rejectApprovalsForTurn(turnId, cancellation);
      }
      await Promise.allSettled([...pendingTurns.values()].map((entry) => entry.promise));
      pendingTurns.clear();
      for (const [requestId, pending] of pendingApprovals.entries()) {
        pendingApprovals.delete(requestId);
        pending.reject(cancellation);
      }
      initialized = false;
      client = null;
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {} } = {}) {
      if (!initialized) await this.initialize();
      const normalizedBindingKey = normalizeText(bindingKey);
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
      if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
        throw runtimeError("INVALID_TURN", "A binding key and workspace root are required.");
      }
      const scope = runtimeScope();
      let threadId = sessionStore.getThreadIdForScope(
        normalizedBindingKey,
        normalizedWorkspaceRoot,
        scope,
      );
      if (!threadId) threadId = requireId(randomUUID(), "THREAD_ID_REQUIRED");
      sessionStore.setThreadIdForScope(
        normalizedBindingKey,
        normalizedWorkspaceRoot,
        scope,
        threadId,
        metadata,
      );
      sessionStore.setThreadIdForWorkspace(
        normalizedBindingKey,
        normalizedWorkspaceRoot,
        threadId,
        metadata,
        "builtin-api",
      );
      sessionStore.setRuntimeParamsForWorkspace(normalizedBindingKey, normalizedWorkspaceRoot, {
        model: normalizedProfile.modelId,
        modelProvider: normalizedProfile.providerId,
      });

      const previous = conversationStore.resume(scope, { conversationId: threadId });
      if (!previous.resumable) {
        throw runtimeError("CONVERSATION_NOT_RESUMABLE", "The selected conversation is read-only.");
      }
      const userMessage = {
        role: "user",
        content: normalizeText(text),
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      };
      const turn = conversationStore.beginTurn(scope, userMessage, { conversationId: threadId });
      const conversation = {
        threadId,
        turnId: turn.id,
        messages: [...previous.messages, userMessage],
        appendAssistant(message) {
          return conversationStore.commitAssistant(turn.id, message);
        },
        appendToolResult(message) {
          return conversationStore.commitToolResult(turn.id, message, { continueTurn: true });
        },
        abort() {
          return conversationStore.abortTurn(turn.id);
        },
      };
      scheduleTurn({
        conversation,
        context: {
          bindingKey: normalizedBindingKey,
          workspaceRoot: normalizedWorkspaceRoot,
          ...metadata,
        },
      });
      return { threadId, turnId: turn.id };
    },
    async cancelTurn({ threadId = "", turnId = "" } = {}) {
      const candidates = [...pendingTurns.entries()].filter(([candidateTurnId, entry]) => (
        (turnId && candidateTurnId === turnId)
        || (!turnId && threadId && entry.conversation.threadId === threadId)
      ));
      const cancellation = runtimeError("CANCELLED", "The model turn was cancelled.");
      for (const [candidateTurnId, entry] of candidates) {
        entry.controller.abort();
        conversationStore.abortTurn(candidateTurnId);
        rejectApprovalsForTurn(candidateTurnId, cancellation);
      }
      await Promise.allSettled(candidates.map(([, entry]) => entry.promise));
      return { threadId, turnId };
    },
    async respondApproval({ requestId, decision, result = null } = {}) {
      const normalizedRequestId = normalizeText(requestId);
      const pending = pendingApprovals.get(normalizedRequestId);
      if (!pending) throw runtimeError("APPROVAL_NOT_FOUND", "No pending approval matches that requestId.");
      pendingApprovals.delete(normalizedRequestId);
      const normalizedDecision = decision === "accept" ? "accept" : "decline";
      const response = result && typeof result === "object"
        ? { requestId: normalizedRequestId, result }
        : { requestId: normalizedRequestId, decision: normalizedDecision };
      pending.resolve(response);
      return response;
    },
    async resumeThread({ threadId } = {}) {
      const normalizedThreadId = normalizeText(threadId);
      if (!normalizedThreadId) throw runtimeError("THREAD_ID_REQUIRED", "A threadId is required.");
      const resumed = conversationStore.resume(runtimeScope(), { conversationId: normalizedThreadId });
      if (!resumed.resumable) {
        throw runtimeError("CONVERSATION_NOT_RESUMABLE", "The selected conversation is read-only.");
      }
      return { threadId: normalizedThreadId, messages: resumed.messages };
    },
    async compactThread({ threadId } = {}) {
      const normalizedThreadId = normalizeText(threadId);
      if (!normalizedThreadId) throw runtimeError("THREAD_ID_REQUIRED", "A threadId is required.");
      return { threadId: normalizedThreadId, compacted: false };
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot } = {}) {
      const normalizedBindingKey = normalizeText(bindingKey);
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
      if (normalizedBindingKey && normalizedWorkspaceRoot) {
        sessionStore.clearThreadIdForScope(normalizedBindingKey, normalizedWorkspaceRoot, runtimeScope());
        sessionStore.clearThreadIdForWorkspace(
          normalizedBindingKey,
          normalizedWorkspaceRoot,
          "builtin-api",
        );
      }
      return { workspaceRoot: normalizedWorkspaceRoot };
    },
  };

  return adapter;
}

function requireProfile(value) {
  if (!isRecord(value)) throw runtimeError("INVALID_PROFILE", "A built-in API profile is required.");
  const profile = {
    ...value,
    id: normalizeText(value.id),
    runtimeId: normalizeText(value.runtimeId),
    providerId: normalizeText(value.providerId),
    modelId: normalizeText(value.modelId),
    secretGeneration: Number(value.secretGeneration),
  };
  if (profile.runtimeId && profile.runtimeId !== "builtin-api") {
    throw runtimeError("INVALID_PROFILE", "The profile runtime must be builtin-api.");
  }
  if (!profile.id || !profile.providerId || !profile.modelId
    || !Number.isSafeInteger(profile.secretGeneration) || profile.secretGeneration < 0) {
    throw runtimeError("INVALID_PROFILE", "The built-in API profile is incomplete.");
  }
  return profile;
}

function isDefinitiveAuthenticationFailure(error) {
  return error?.code === "INVALID_CREDENTIALS" || error?.status === 401 || error?.status === 403;
}

function uniqueRequestId(randomUUID, pendingApprovals) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = requireId(randomUUID(), "APPROVAL_ID_REQUIRED");
    if (!pendingApprovals.has(candidate)) return candidate;
  }
  throw runtimeError("APPROVAL_ID_COLLISION", "Could not allocate a unique approval requestId.");
}

function requireId(value, code) {
  const id = normalizeText(value);
  if (!id) throw runtimeError(code, "A non-empty identifier is required.");
  return id;
}

function runtimeError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = { createApiRuntimeAdapter };
