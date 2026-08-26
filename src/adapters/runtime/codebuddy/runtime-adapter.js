"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { SessionStore } = require("../codex/session-store");
const { CodeBuddyClient } = require("./client");
const { locateCodeBuddyDistribution } = require("./distribution-locator");
const { CodeBuddyProcessHost } = require("./process-host");

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

  let distribution = null;
  let host = null;
  let client = null;
  let ready = null;
  let readyPromise = null;
  let closed = false;
  let liveIdentity = "";

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
      await verifyLiveIdentity(signal);
      ready = Object.freeze({
        endpoint: started.endpoint,
        health: sanitizeHealth(started.health),
        cliVersion: normalizeText(distribution.version),
        serverVersion: normalizeText(initialized?.serverInfo?.version),
        identityVerified: true,
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
    if (message?.method !== "session/update") return;
    const reportedSessionId = normalizeText(message.params?.sessionId);
    if (reportedSessionId && reportedSessionId !== threadId) return;
    const update = message.params?.update;
    if (update?.sessionUpdate !== "agent_message_chunk") return;
    const text = textChunk(update);
    if (!text) return;
    emit({
      type: "runtime.reply.delta",
      payload: runtimePayload({ threadId, turnId, workspaceRoot, text }),
    }, message);
  }

  async function runTurn({ threadId, turnId, workspaceRoot, text, controller }) {
    try {
      const reply = await client.prompt({
        sessionId: threadId,
        text,
        signal: controller.signal,
        onNotification: (message) => forwardNotification(message, { threadId, turnId, workspaceRoot }),
      });
      emit({
        type: "runtime.reply.completed",
        payload: runtimePayload({ threadId, turnId, workspaceRoot, text: reply.text }),
      });
      emit({
        type: "runtime.turn.completed",
        payload: runtimePayload({ threadId, turnId, workspaceRoot, text: reply.text }),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      emit({
        type: "runtime.turn.failed",
        payload: runtimePayload({
          threadId,
          turnId,
          workspaceRoot,
          code: cancelled ? "CANCELLED" : normalizeText(error?.code) || "CODEBUDDY_TURN_FAILED",
          text: cancelled ? "The CodeBuddy turn was stopped during runtime cleanup." : publicErrorText(error),
        }),
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
    async respondApproval() {
      throw runtimeError("APPROVAL_NOT_FOUND", "No pending CodeBuddy approval matches that request.");
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
    async compactThread({ threadId } = {}) {
      throw runtimeError("CODEBUDDY_COMPACTION_UNSUPPORTED", `CodeBuddy compaction is unavailable for session ${normalizeText(threadId)}.`);
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

function textChunk(update) {
  if (update?.content?.type === "text" && typeof update.content.text === "string") return update.content.text;
  return typeof update?.text === "string" ? update.text : "";
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

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function requireText(value, code, message) { const text = normalizeText(value); if (!text) throw runtimeError(code, message); return text; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createCodeBuddyRuntimeAdapter };
