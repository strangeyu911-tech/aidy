"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { SessionStore } = require("../codex/session-store");
const { CodeBuddyClient } = require("./client");
const { locateCodeBuddyDistribution } = require("./distribution-locator");
const { CodeBuddyProcessHost } = require("./process-host");
const {
  mapCodeBuddyFailure,
  mapCodeBuddyNotification,
  normalizeCodeBuddyUsage,
} = require("./events");

function createCodeBuddyRuntimeAdapter({
  config = {},
  profile,
  secrets = {},
  profileStore,
  locateDistribution = locateCodeBuddyDistribution,
  processHostFactory = (options) => new CodeBuddyProcessHost(options),
  clientFactory = (options) => new CodeBuddyClient(options),
} = {}) {
  const normalizedProfile = requireCodeBuddyProfile(profile);
  const stateDir = path.resolve(requireText(config.stateDir, "INVALID_PROFILE", "CodeBuddy requires a state directory."));
  const defaultWorkspaceRoot = path.resolve(normalizeText(config.workspaceRoot) || process.cwd());
  const servicePassword = requireText(secrets.servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy gateway password is unavailable.");
  const expectedIdentity = normalizeIdentity(normalizedProfile.capabilities.accountIdentityFingerprint);
  if (!expectedIdentity) throw runtimeError("CODEBUDDY_LOGIN_REQUIRED", "CodeBuddy profile identity has not been verified.");
  const sessionStore = new SessionStore({
    filePath: normalizeText(config.sessionsFile) || path.join(stateDir, "sessions.json"),
    runtimeId: "codebuddy",
  });
  const emitter = new EventEmitter();
  const randomUUID = typeof config.randomUUID === "function" ? config.randomUUID : crypto.randomUUID;
  const activeTurns = new Map();
  const attachedSessions = new Set();
  const pendingApprovals = new Map();

  let distribution = null;
  let host = null;
  let client = null;
  let ready = null;
  let readyPromise = null;
  let closed = false;
  let liveIdentity = "";
  let agentCapabilities = {};

  function runtimeScope() {
    return {
      runtimeId: "codebuddy",
      profileId: normalizedProfile.id,
      modelId: normalizedProfile.modelId,
      secretGeneration: normalizedProfile.secretGeneration,
      runtimeIdentityFingerprint: liveIdentity || expectedIdentity,
    };
  }

  function emit(event, raw = null) {
    emitter.emit("event", event, raw);
  }

  async function verifyLiveIdentity(signal) {
    const fingerprint = normalizeIdentity(await client.getIdentityFingerprint({ signal }));
    if (!fingerprint || fingerprint !== expectedIdentity) {
      try { await Promise.resolve(profileStore?.markRuntimeProfilesUnverified?.("codebuddy", "account_identity_changed")); } catch {}
      throw runtimeError("CODEBUDDY_LOGIN_REQUIRED", "The active CodeBuddy login no longer matches this profile.");
    }
    liveIdentity = fingerprint;
    return fingerprint;
  }

  async function initialize({ signal } = {}) {
    if (closed) throw runtimeError("RUNTIME_CLOSED", "The CodeBuddy runtime is closed.");
    if (ready) return ready;
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      distribution = await locateDistribution({
        explicitExecutablePath: normalizeText(normalizedProfile.options.executablePath),
      });
      host = processHostFactory({ stateDir });
      const started = await host.start({
        distribution,
        workspaceRoot: defaultWorkspaceRoot,
        servicePassword,
        mcpServers: isRecord(config.codebuddyMcpServers) ? config.codebuddyMcpServers : {},
        allowedTools: Array.isArray(config.codebuddyAllowedTools) ? config.codebuddyAllowedTools : [],
      });
      client = clientFactory({
        endpoint: started.endpoint,
        servicePassword,
        cliVersion: distribution.version,
        timeoutMs: positiveInteger(config.codebuddyRequestTimeoutMs, 120_000),
      });
      await client.connect({ signal });
      const initialized = await client.initialize({ signal });
      agentCapabilities = isRecord(initialized?.agentCapabilities) ? { ...initialized.agentCapabilities } : {};
      await verifyLiveIdentity(signal);
      ready = Object.freeze({
        endpoint: started.endpoint,
        health: sanitizeHealth(started.health),
        cliVersion: normalizeText(distribution.version),
        serverVersion: normalizeText(initialized?.serverInfo?.version),
        identityVerified: true,
        compactionSupported: hasCompactionCapability(agentCapabilities, client),
      });
      return ready;
    })();
    try {
      return await readyPromise;
    } catch (error) {
      await Promise.resolve(client?.disconnect?.()).catch(() => {});
      await Promise.resolve(host?.stop?.()).catch(() => {});
      client = null;
      host = null;
      throw error;
    } finally {
      readyPromise = null;
    }
  }

  async function attachSession({ bindingKey, workspaceRoot, metadata, signal }) {
    let sessionId = sessionStore.getThreadIdForScope(bindingKey, workspaceRoot, runtimeScope());
    if (sessionId && !attachedSessions.has(sessionId)) {
      try {
        await client.resumeSession({ sessionId, workingDirectory: workspaceRoot, signal });
        attachedSessions.add(sessionId);
      } catch {
        sessionStore.clearThreadIdForScope(bindingKey, workspaceRoot, runtimeScope());
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        sessionId = "";
      }
    }
    if (!sessionId) {
      const created = await client.newSession({ workingDirectory: workspaceRoot, signal });
      sessionId = requireText(created.sessionId, "CODEBUDDY_SESSION_FAILED", "CodeBuddy did not create a session.");
      if (created.modelId && created.modelId !== normalizedProfile.modelId) {
        throw runtimeError("CODEBUDDY_MODEL_UNAVAILABLE", "CodeBuddy did not select the configured model.");
      }
      attachedSessions.add(sessionId);
      sessionStore.setThreadIdForScope(bindingKey, workspaceRoot, runtimeScope(), sessionId, metadata);
      sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, sessionId, metadata);
    }
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: normalizedProfile.modelId,
      modelProvider: "",
    });
    return sessionId;
  }

  function forwardNotification(message, { threadId, turnId, workspaceRoot }) {
    return forwardMappedEvents(message, { threadId, turnId, workspaceRoot });
  }

  function forwardProtocolRequest(message, { threadId, turnId, workspaceRoot }) {
    return forwardMappedEvents(message, { threadId, turnId, workspaceRoot });
  }

  function forwardMappedEvents(message, { threadId, turnId, workspaceRoot }) {
    const events = mapCodeBuddyNotification(message, { threadId, turnId, workspaceRoot });
    for (const event of events) {
      if (event?.type === "runtime.approval.requested") {
        pendingApprovals.set(normalizeRpcId(event.payload.requestId), {
          threadId,
          rpcId: message?.id,
          responseTemplate: event.payload.responseTemplate,
        });
      }
      emit({
        ...event,
        payload: runtimePayload({ ...event.payload, workspaceRoot }),
      }, message);
      if (event?.type === "runtime.approval.denied" && event.payload.response?.outcome) {
        Promise.resolve(client?.respondPermission?.({
          requestId: message?.id ?? event.payload.requestId,
          outcome: event.payload.response.outcome,
          sessionId: threadId,
        })).catch(() => {});
      }
    }
    return events;
  }

  async function runTurn({ threadId, turnId, workspaceRoot, text, controller }) {
    try {
      let streamedReply = false;
      const reply = await client.prompt({
        sessionId: threadId,
        text,
        signal: controller.signal,
        onNotification: (message) => {
          const events = forwardNotification(message, { threadId, turnId, workspaceRoot });
          if (events.some((event) => event?.type === "runtime.reply.delta")) {
            streamedReply = true;
          }
        },
        onRequest: (message) => forwardProtocolRequest(message, { threadId, turnId, workspaceRoot }),
      });
      const normalizedUsage = hasUsageFields(reply.usage) ? normalizeCodeBuddyUsage(reply.usage) : {};
      const completionPayload = {
        threadId,
        turnId,
        workspaceRoot,
        text: reply.text,
        ...(normalizedUsage.usage ? { usage: normalizedUsage.usage } : {}),
        ...(normalizedUsage.vendorUsage ? { vendorUsage: normalizedUsage.vendorUsage } : {}),
      };
      if (reply.stopReason === "cancelled") {
        emit({
          type: "runtime.turn.failed",
          payload: runtimePayload({ ...completionPayload, code: "CANCELLED", text: "The CodeBuddy turn was cancelled." }),
        });
        return;
      }
      if (!streamedReply) {
        emit({
          type: "runtime.reply.completed",
          payload: runtimePayload(completionPayload),
        });
      }
      emit({
        type: "runtime.turn.completed",
        payload: runtimePayload(completionPayload),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const failure = mapCodeBuddyFailure(cancelled ? { code: "CANCELLED" } : error, { threadId, turnId });
      emit({
        ...failure,
        payload: runtimePayload({ ...failure.payload, workspaceRoot,
          ...(cancelled ? { text: "The CodeBuddy turn was stopped during runtime cleanup." } : {}) }),
      });
    }
  }

  function runtimePayload(value) {
    return {
      runtimeId: "codebuddy",
      profileId: normalizedProfile.id,
      ...value,
    };
  }

  const adapter = {
    describe() {
      return {
        id: "codebuddy",
        kind: "runtime",
        profileId: normalizedProfile.id,
        model: normalizedProfile.modelId,
        source: normalizeText(distribution?.source),
        cliVersion: normalizeText(distribution?.version),
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
      return { nativeImageInput: false, toolImageRead: false };
    },
    initialize,
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, signal } = {}) {
      await initialize({ signal });
      const binding = requireText(bindingKey, "INVALID_TURN", "A CodeBuddy binding key is required.");
      const directory = path.resolve(requireText(workspaceRoot, "INVALID_TURN", "A CodeBuddy workspace is required."));
      const promptText = requireText(text, "CODEBUDDY_TURN_FAILED", "A CodeBuddy prompt is required.");
      if (Array.isArray(attachments) && attachments.length) {
        throw runtimeError("CODEBUDDY_TURN_FAILED", "CodeBuddy attachments are not enabled yet.");
      }
      await verifyLiveIdentity(signal);
      const threadId = await attachSession({ bindingKey: binding, workspaceRoot: directory, metadata, signal });
      const turnId = requireText(randomUUID(), "CODEBUDDY_TURN_FAILED", "A CodeBuddy turn identifier is unavailable.");
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(signal?.reason);
      if (signal?.aborted) abortFromParent();
      else signal?.addEventListener?.("abort", abortFromParent, { once: true });
      emit({ type: "runtime.turn.started", payload: runtimePayload({ threadId, turnId, workspaceRoot: directory }) });
      const pending = runTurn({ threadId, turnId, workspaceRoot: directory, text: promptText, controller })
        .finally(() => {
          signal?.removeEventListener?.("abort", abortFromParent);
          activeTurns.delete(turnId);
        });
      activeTurns.set(turnId, { controller, pending, threadId });
      return { threadId, turnId };
    },
    async cancelTurn({ turnId = "" } = {}) {
      const normalizedTurnId = normalizeText(turnId);
      const active = activeTurns.get(normalizedTurnId);
      active?.controller.abort();
      return { threadId: normalizeText(active?.threadId), turnId: normalizedTurnId };
    },
    async respondApproval({ requestId, decision, result = null, signal } = {}) {
      const normalizedRequestId = normalizeRpcId(requestId);
      if (!normalizedRequestId) throw runtimeError("APPROVAL_NOT_FOUND", "A CodeBuddy approval request ID is required.");
      const pending = pendingApprovals.get(normalizedRequestId);
      if (!pending) throw runtimeError("APPROVAL_NOT_FOUND", "No pending CodeBuddy approval matches that request.");
      const optionByCommand = isRecord(pending.responseTemplate?.optionByCommand)
        ? pending.responseTemplate.optionByCommand
        : {};
      const templateResult = isRecord(result) && normalizeText(result.outcome) ? result : null;
      const accepted = decision === "accept" || result?.action === "accept";
      const command = accepted && result?.remember === true ? "always"
        : accepted ? "yes" : "no";
      const outcome = normalizeText(templateResult?.outcome || optionByCommand[command]);
      if (!outcome || typeof client?.respondPermission !== "function") {
        throw runtimeError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy permission response is unavailable.");
      }
      await client.respondPermission({
        requestId: pending.rpcId ?? normalizedRequestId,
        outcome,
        sessionId: pending.threadId,
        signal,
      });
      pendingApprovals.delete(normalizedRequestId);
      return { requestId: normalizedRequestId, decision: accepted ? "accept" : "decline" };
    },
    async resumeThread({ threadId, workspaceRoot, signal } = {}) {
      await initialize({ signal });
      const normalizedThreadId = requireText(threadId, "CODEBUDDY_SESSION_FAILED", "A CodeBuddy session is required.");
      await verifyLiveIdentity(signal);
      await client.resumeSession({
        sessionId: normalizedThreadId,
        workingDirectory: path.resolve(normalizeText(workspaceRoot) || defaultWorkspaceRoot),
        signal,
      });
      attachedSessions.add(normalizedThreadId);
      return { threadId: normalizedThreadId };
    },
    async compactThread({ threadId, workspaceRoot, signal } = {}) {
      await initialize({ signal });
      const normalizedThreadId = requireText(threadId, "CODEBUDDY_SESSION_FAILED", "A CodeBuddy session is required.");
      if (!ready?.compactionSupported || typeof client?.compactSession !== "function") {
        throw runtimeError("CODEBUDDY_COMPACTION_UNSUPPORTED", `CodeBuddy compaction is unavailable for session ${normalizedThreadId}.`);
      }
      await verifyLiveIdentity(signal);
      const directory = path.resolve(normalizeText(workspaceRoot) || defaultWorkspaceRoot);
      const result = await client.compactSession({
        sessionId: normalizedThreadId,
        workingDirectory: directory,
        signal,
        onNotification: (message) => forwardNotification(message, {
          threadId: normalizedThreadId,
          turnId: normalizeText(message?.params?.turnId),
          workspaceRoot: directory,
        }),
      });
      return { threadId: normalizedThreadId, ...(isRecord(result) ? result : {}) };
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot } = {}) {
      const binding = normalizeText(bindingKey);
      const directory = normalizeText(workspaceRoot);
      if (binding && directory) {
        sessionStore.clearThreadIdForScope(binding, directory, runtimeScope());
        sessionStore.clearThreadIdForWorkspace(binding, directory);
      }
      return { workspaceRoot: directory };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const active of activeTurns.values()) active.controller.abort();
      await Promise.allSettled([...activeTurns.values()].map((active) => active.pending));
      activeTurns.clear();
      await Promise.resolve(client?.disconnect?.()).catch(() => {});
      await Promise.resolve(host?.stop?.()).catch(() => {});
      client = null;
      host = null;
      ready = null;
      agentCapabilities = {};
      pendingApprovals.clear();
      attachedSessions.clear();
    },
  };

  return adapter;
}

function requireCodeBuddyProfile(value) {
  const source = isRecord(value) ? value : {};
  const profile = {
    ...source,
    id: normalizeText(source.id),
    runtimeId: normalizeText(source.runtimeId).toLowerCase(),
    modelId: normalizeText(source.modelId),
    secretGeneration: nonNegativeInteger(source.secretGeneration),
    options: isRecord(source.options) ? { ...source.options } : {},
    capabilities: isRecord(source.capabilities) ? { ...source.capabilities } : {},
  };
  if (profile.runtimeId !== "codebuddy" || !profile.id || !profile.modelId) {
    throw runtimeError("INVALID_PROFILE", "A complete CodeBuddy profile is required.");
  }
  return profile;
}

function hasCompactionCapability(capabilities, client) {
  return Boolean(
    typeof client?.compactSession === "function"
      && (capabilities?.sessionCompaction === true || capabilities?.compaction === true),
  );
}

function hasUsageFields(value) {
  return isRecord(value) && ["inputTokens", "outputTokens"].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function sanitizeHealth(value) {
  const source = isRecord(value) ? value : {};
  return Object.freeze({ ok: source.ok === true, status: normalizeText(source.status), version: normalizeText(source.version) });
}

function publicErrorText(error) {
  const code = normalizeText(error?.code) || "CODEBUDDY_TURN_FAILED";
  return `CodeBuddy turn failed. [${code}]`;
}

function normalizeIdentity(value) {
  const text = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

function normalizeRpcId(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function requireText(value, code, message) { const text = normalizeText(value); if (!text) throw runtimeError(code, message); return text; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createCodeBuddyRuntimeAdapter };
