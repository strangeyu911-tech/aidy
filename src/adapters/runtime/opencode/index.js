"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const { AtomicJsonStore } = require("../../../core/atomic-json-store");
const { SessionStore } = require("../codex/session-store");
const { OpenCodeClient } = require("./client");

const CATALOG_TTL_MS = 10 * 60_000;
const DEFAULT_PORT = 4096;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_RETRY_DELAY_MS = 50;
const CATALOG_INVALIDATION_EVENTS = new Set([
  "catalog.updated",
  "models-dev.refreshed",
  "provider.updated",
  "provider.auth.updated",
]);

function createOpenCodeRuntimeAdapter({
  config = {},
  profile,
  secrets = {},
  spawnImpl = spawn,
  fetchImpl,
} = {}) {
  const normalizedProfile = requireOpenCodeProfile(profile);
  const stateDir = path.resolve(requireText(config.stateDir, "STATE_DIR_REQUIRED", "CyberBoss stateDir is required for OpenCode."));
  const sessionStore = new SessionStore({
    filePath: normalizeText(config.sessionsFile) || path.join(stateDir, "opencode-sessions.json"),
    runtimeId: "opencode",
  });
  const emitter = new EventEmitter();
  const now = typeof config.now === "function" ? config.now : Date.now;
  const randomUUID = typeof config.randomUUID === "function" ? config.randomUUID : crypto.randomUUID;
  const effectiveFetch = fetchImpl || config.fetchImpl || globalThis.fetch;
  const ownershipMode = normalizedProfile.ownershipMode;
  const managed = ownershipMode === "managed-local";
  const workspaceRoot = path.resolve(normalizeText(config.workspaceRoot) || process.cwd());
  const managedPaths = managed ? buildManagedPaths(stateDir, normalizedProfile.id) : null;
  const managedPort = normalizePort(config.opencodePort ?? config.port, DEFAULT_PORT);
  const endpoint = managed
    ? `http://127.0.0.1:${managedPort}`
    : normalizeText(config.endpoint || normalizedProfile.options.endpoint || normalizedProfile.baseUrl);
  const externalUsername = normalizeText(
    config.serviceUsername || normalizedProfile.options.serviceUsername,
  ) || "opencode";
  const servicePassword = managed
    ? normalizeSecret(secrets.servicePassword) || generateServicePassword(config.randomBytes)
    : normalizeSecret(secrets.servicePassword);

  let client = null;
  let child = null;
  let initialized = false;
  let closed = false;
  let closing = false;
  let processFailure = null;
  let eventAbort = null;
  let eventPump = null;
  let catalogDirty = true;
  let catalogCache = null;
  const pendingPermissions = new Map();

  function runtimeScope() {
    return {
      runtimeId: "opencode",
      profileId: normalizedProfile.id,
      modelId: normalizedProfile.modelId,
      secretGeneration: normalizedProfile.secretGeneration,
    };
  }

  function getClient() {
    if (!client) {
      client = new OpenCodeClient({
        endpoint,
        username: managed ? "opencode" : externalUsername,
        password: servicePassword,
        directory: workspaceRoot,
        fetchImpl: effectiveFetch,
      });
    }
    return client;
  }

  function emit(event, raw = null) {
    emitter.emit("event", event, raw);
  }

  function rememberPermission(raw) {
    if (raw?.type !== "permission.updated") return;
    const permissionId = normalizeText(raw?.properties?.id);
    const sessionId = normalizeText(raw?.properties?.sessionID);
    if (permissionId && sessionId) pendingPermissions.set(permissionId, sessionId);
  }

  function observeCatalogInvalidation(raw) {
    const type = normalizeText(raw?.type);
    if (CATALOG_INVALIDATION_EVENTS.has(type) || type.startsWith("provider.auth.")) {
      catalogDirty = true;
    }
  }

  async function runEventPump() {
    const controller = new AbortController();
    eventAbort = controller;
    try {
      for await (const raw of getClient().events({ signal: controller.signal })) {
        observeCatalogInvalidation(raw);
        rememberPermission(raw);
        const mapped = mapOpenCodeEventToRuntimeEvent(raw);
        if (mapped) emit(mapped, raw);
      }
    } catch (error) {
      if (!closing && !closed && error?.code !== "CANCELLED") {
        emit({
          type: "runtime.turn.failed",
          payload: {
            threadId: "",
            turnId: "",
            code: normalizeText(error?.code) || "OPENCODE_EVENT_STREAM_FAILED",
            text: "The OpenCode event stream stopped unexpectedly.",
          },
        });
      }
    } finally {
      if (eventAbort === controller) eventAbort = null;
    }
  }

  function ensureEventPump() {
    if (eventPump) return;
    eventPump = runEventPump().finally(() => { eventPump = null; });
    eventPump.catch(() => {});
  }

  function startManagedProcess() {
    if (!managed || child) return;
    processFailure = null;
    writeManagedConfig({
      configPath: managedPaths.configPath,
      providerId: normalizedProfile.providerId,
      providerBaseUrl: normalizedProfile.baseUrl,
      providerNpm: normalizedProfile.options.providerNpm,
      providerName: normalizedProfile.options.providerName,
      hasProviderKey: Boolean(normalizeSecret(secrets.apiKey)),
      forbiddenValues: [normalizeSecret(secrets.apiKey), servicePassword],
    });
    const env = buildManagedEnvironment({
      inherited: config.env || process.env,
      paths: managedPaths,
      configPath: managedPaths.configPath,
      providerKey: normalizeSecret(secrets.apiKey),
      servicePassword,
    });
    const command = normalizeText(config.opencodeCommand) || "opencode";
    child = spawnImpl(command, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(managedPort),
    ], {
      cwd: workspaceRoot,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child || typeof child.on !== "function") {
      child = null;
      throw runtimeError("OPENCODE_SPAWN_FAILED", "The managed OpenCode process could not be started.");
    }
    child.stdout?.on?.("data", discardProcessOutput);
    child.stderr?.on?.("data", discardProcessOutput);
    child.once?.("error", (error) => handleProcessExit({ spawnError: error }));
    child.once?.("exit", (code, signal) => handleProcessExit({ code, signal }));
  }

  function handleProcessExit({ code = null, signal = null, spawnError = null } = {}) {
    const wasClosing = closing || closed;
    child = null;
    initialized = false;
    processFailure = wasClosing
      ? null
      : runtimeError(
        spawnError ? "OPENCODE_SPAWN_FAILED" : "OPENCODE_PROCESS_EXITED",
        spawnError
          ? "The managed OpenCode process could not be started."
          : "The managed OpenCode process exited unexpectedly.",
      );
    if (!wasClosing) {
      emit({
        type: "runtime.turn.failed",
        payload: {
          threadId: "",
          turnId: "",
          code: processFailure.code,
          text: processFailure.message,
          ...(Number.isInteger(code) ? { exitCode: code } : {}),
          ...(normalizeText(signal) ? { signal: normalizeText(signal) } : {}),
        },
      });
    }
  }

  async function probe(signal) {
    if (!managed) return getClient().health({ signal });
    const timeoutMs = positiveInteger(config.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
    const delayMs = nonNegativeInteger(config.healthRetryDelayMs, DEFAULT_HEALTH_RETRY_DELAY_MS);
    const deadline = numericNow(now) + timeoutMs;
    let lastError = null;
    while (numericNow(now) <= deadline) {
      throwIfAborted(signal);
      if (processFailure) throw processFailure;
      try {
        return await getClient().health({ signal });
      } catch (error) {
        if (error?.code === "CANCELLED") throw error;
        if (!["OPENCODE_UNAVAILABLE", "OPENCODE_TIMEOUT"].includes(error?.code)) throw error;
        lastError = error;
      }
      await abortableDelay(delayMs, signal);
    }
    throw lastError || runtimeError("OPENCODE_UNAVAILABLE", "The managed OpenCode service did not become healthy.");
  }

  async function discoverCatalog({ health, reason = "display", signal } = {}) {
    const reportedVersion = normalizeText(health?.version);
    const nowMs = numericNow(now);
    const normalizedReason = normalizeText(reason).toLowerCase();
    const forceRefresh = ownershipMode === "external" && normalizedReason === "activation"
      || new Set(["connection", "endpoint-change", "manual-refresh", "provider-auth-change", "verification", "version-change"])
        .has(normalizedReason);
    const fresh = catalogCache
      && nowMs - catalogCache.refreshedAtMs < CATALOG_TTL_MS
      && catalogCache.endpoint === endpoint
      && catalogCache.reportedVersion === reportedVersion;
    if (!forceRefresh && !catalogDirty && fresh) {
      return catalogSnapshot(catalogCache, true);
    }

    const response = await getClient().listProviders({ signal });
    const normalized = buildCatalog(response);
    assertSelectedModelAvailable(normalized, normalizedProfile);
    const connectedProviderFingerprint = fingerprintConnectedProviders(response.connected);
    catalogCache = {
      endpoint,
      reportedVersion,
      connectedProviderFingerprint,
      providers: normalized.providers,
      models: normalized.models,
      defaults: normalized.defaults,
      connected: normalized.connected,
      refreshedAtMs: nowMs,
      refreshedAt: new Date(nowMs).toISOString(),
    };
    catalogDirty = false;
    return catalogSnapshot(catalogCache, false);
  }

  const adapter = {
    describe() {
      return {
        id: "opencode",
        kind: "runtime",
        profileId: normalizedProfile.id,
        ownershipMode,
        endpoint,
        provider: normalizedProfile.providerId,
        model: normalizedProfile.modelId,
      };
    },
    createClient() {
      return getClient();
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
      const model = catalogCache?.models.find((candidate) => (
        candidate.providerId === normalizedProfile.providerId
        && candidate.id === normalizedProfile.modelId
      ));
      return {
        nativeImageInput: Boolean(model?.inputModalities?.includes("image")),
        toolImageRead: false,
      };
    },
    async initialize({ signal } = {}) {
      if (closed) throw runtimeError("RUNTIME_CLOSED", "The OpenCode runtime is closed.");
      throwIfAborted(signal);
      startManagedProcess();
      const health = await probe(signal);
      const catalog = await discoverCatalog({ health, reason: "activation", signal });
      initialized = true;
      ensureEventPump();
      return {
        endpoint,
        ownershipMode,
        health,
        catalog,
        catalogMetadata: {
          endpoint,
          reportedVersion: health.version,
          connectedProviderFingerprint: catalog.connectedProviderFingerprint,
          refreshedAt: catalog.refreshedAt,
        },
        ...(managed ? { isolatedConfigPath: managedPaths.configPath } : {}),
      };
    },
    async listCatalog({ reason = "display", signal } = {}) {
      if (closed) throw runtimeError("RUNTIME_CLOSED", "The OpenCode runtime is closed.");
      startManagedProcess();
      const health = await probe(signal);
      return discoverCatalog({ health, reason, signal });
    },
    async close() {
      if (closed) return;
      closing = true;
      eventAbort?.abort();
      const pendingPump = eventPump;
      if (child) {
        try { child.kill(); } catch { /* Process may already have exited. */ }
      }
      if (pendingPump) await Promise.race([pendingPump, abortableDelay(250).catch(() => {})]);
      pendingPermissions.clear();
      child = null;
      client = null;
      initialized = false;
      closed = true;
      closing = false;
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot: turnWorkspace, text, attachments = [], metadata = {} } = {}) {
      if (!initialized) await this.initialize();
      const binding = requireText(bindingKey, "INVALID_TURN", "A binding key is required.");
      const directory = path.resolve(requireText(turnWorkspace, "INVALID_TURN", "A workspace root is required."));
      let threadId = sessionStore.getThreadIdForScope(binding, directory, runtimeScope());
      if (!threadId) {
        const created = await getClient().createSession({ title: "CyberBoss" }, { directory });
        threadId = requireText(created?.id, "OPENCODE_INCOMPATIBLE", "OpenCode did not return a session identifier.");
        sessionStore.setThreadIdForScope(binding, directory, runtimeScope(), threadId, metadata);
        sessionStore.setThreadIdForWorkspace(binding, directory, threadId, metadata);
      }
      sessionStore.setRuntimeParamsForWorkspace(binding, directory, {
        model: normalizedProfile.modelId,
        modelProvider: normalizedProfile.providerId,
      });
      const turnId = requireText(randomUUID(), "TURN_ID_REQUIRED", "A turn identifier could not be allocated.");
      const parts = buildPromptParts(text, attachments);
      await getClient().promptAsync(threadId, {
        messageID: turnId,
        model: {
          providerID: normalizedProfile.providerId,
          modelID: normalizedProfile.modelId,
        },
        ...(config.verificationMode === true ? {
          system: "CyberBoss read-only capability verification. Use only the enabled glob tool. Do not attempt any write, command, network, or configuration operation.",
          tools: { "*": false, glob: true },
        } : {}),
        parts,
      }, { directory });
      return { threadId, turnId };
    },
    async cancelTurn({ threadId, turnId = "", signal } = {}) {
      if (!initialized) await this.initialize({ signal });
      const normalizedThreadId = requireText(threadId, "THREAD_ID_REQUIRED", "A threadId is required.");
      await getClient().abortSession(normalizedThreadId, { signal });
      const normalizedTurnId = normalizeText(turnId);
      emit(failureEvent(normalizedThreadId, normalizedTurnId, "CANCELLED"));
      return { threadId: normalizedThreadId, turnId: normalizedTurnId };
    },
    async respondApproval({ requestId, decision, remember = false, threadId = "", signal } = {}) {
      if (!initialized) await this.initialize({ signal });
      const normalizedRequestId = requireText(requestId, "APPROVAL_ID_REQUIRED", "A permission requestId is required.");
      const sessionId = normalizeText(threadId) || pendingPermissions.get(normalizedRequestId);
      if (!sessionId) throw runtimeError("APPROVAL_NOT_FOUND", "No pending OpenCode permission matches that requestId.");
      const response = decision === "accept" ? (remember ? "always" : "once") : "reject";
      await getClient().respondPermission(sessionId, normalizedRequestId, response, { signal });
      pendingPermissions.delete(normalizedRequestId);
      return {
        requestId: normalizedRequestId,
        decision: decision === "accept" ? "accept" : "decline",
      };
    },
    async resumeThread({ threadId, workspaceRoot: resumeWorkspace = "", signal } = {}) {
      if (!initialized) await this.initialize({ signal });
      const normalizedThreadId = requireText(threadId, "THREAD_ID_REQUIRED", "A threadId is required.");
      const messages = await getClient().listMessages(normalizedThreadId, {
        signal,
        directory: normalizeText(resumeWorkspace) || workspaceRoot,
      });
      return { threadId: normalizedThreadId, messages };
    },
    async compactThread({ threadId } = {}) {
      return {
        threadId: requireText(threadId, "THREAD_ID_REQUIRED", "A threadId is required."),
        compacted: false,
      };
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot: draftWorkspace } = {}) {
      const binding = normalizeText(bindingKey);
      const directory = normalizeText(draftWorkspace);
      if (binding && directory) {
        sessionStore.clearThreadIdForScope(binding, directory, runtimeScope());
        sessionStore.clearThreadIdForWorkspace(binding, directory);
      }
      return { workspaceRoot: directory };
    },
  };

  return adapter;
}

function requireOpenCodeProfile(value) {
  if (!isRecord(value)) throw runtimeError("INVALID_PROFILE", "An OpenCode profile is required.");
  const runtimeId = normalizeText(value.runtimeId).toLowerCase();
  const rawOwnership = normalizeText(value.ownershipMode).toLowerCase();
  const ownershipMode = rawOwnership === "managed" ? "managed-local" : rawOwnership;
  const profile = {
    ...value,
    id: normalizeText(value.id),
    runtimeId,
    ownershipMode,
    providerId: normalizeText(value.providerId),
    modelId: normalizeText(value.modelId),
    secretGeneration: normalizeNonNegativeInteger(value.secretGeneration),
    baseUrl: normalizeText(value.baseUrl),
    options: isRecord(value.options) ? { ...value.options } : {},
  };
  if (runtimeId !== "opencode" || !profile.id || !new Set(["managed-local", "external"]).has(ownershipMode)
    || !profile.providerId || !profile.modelId) {
    throw runtimeError("INVALID_PROFILE", "The OpenCode profile is incomplete.");
  }
  return profile;
}

function buildManagedPaths(stateDir, profileId) {
  const profileKey = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 20);
  const root = path.join(stateDir, "opencode", profileKey);
  const configDir = path.join(root, "config");
  return {
    root,
    configDir,
    configPath: path.join(configDir, "opencode.json"),
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    stateDir: path.join(root, "state"),
    appDataDir: path.join(root, "appdata"),
    localAppDataDir: path.join(root, "localappdata"),
  };
}

function writeManagedConfig({
  configPath,
  providerId,
  providerBaseUrl,
  providerNpm,
  providerName,
  hasProviderKey,
  forbiddenValues,
}) {
  const options = {
    ...(normalizeText(providerBaseUrl) ? { baseURL: normalizeText(providerBaseUrl) } : {}),
    ...(hasProviderKey ? { apiKey: "{env:CYBERBOSS_OPENCODE_PROVIDER_KEY}" } : {}),
  };
  const provider = {
    ...(normalizeText(providerNpm) ? { npm: normalizeText(providerNpm) } : {}),
    ...(normalizeText(providerName) ? { name: normalizeText(providerName) } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
  const document = {
    $schema: "https://opencode.ai/config.json",
    provider: { [providerId]: provider },
  };
  const store = new AtomicJsonStore({ filePath: configPath, defaultValue: document });
  store.write(document);
  let reopened;
  try {
    reopened = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw runtimeError("OPENCODE_CONFIG_WRITE_FAILED", "The isolated OpenCode configuration could not be reopened.");
  }
  const serialized = JSON.stringify(reopened);
  for (const forbidden of forbiddenValues.map(normalizeSecret).filter(Boolean)) {
    if (serialized.includes(forbidden)) {
      throw runtimeError("OPENCODE_CONFIG_SECRET_LEAK", "The isolated OpenCode configuration contained secret material.");
    }
  }
}

function buildManagedEnvironment({ inherited, paths, configPath, providerKey, servicePassword }) {
  const env = sanitizeEnvironment(inherited);
  fs.mkdirSync(paths.configDir, { recursive: true });
  for (const directory of [
    paths.dataDir,
    paths.cacheDir,
    paths.stateDir,
    paths.appDataDir,
    paths.localAppDataDir,
  ]) fs.mkdirSync(directory, { recursive: true });
  return {
    ...env,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: paths.configDir,
    XDG_CONFIG_HOME: paths.configDir,
    XDG_DATA_HOME: paths.dataDir,
    XDG_CACHE_HOME: paths.cacheDir,
    XDG_STATE_HOME: paths.stateDir,
    APPDATA: paths.appDataDir,
    LOCALAPPDATA: paths.localAppDataDir,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    ...(providerKey ? { CYBERBOSS_OPENCODE_PROVIDER_KEY: providerKey } : {}),
    ...(servicePassword ? { OPENCODE_SERVER_PASSWORD: servicePassword } : {}),
  };
}

function sanitizeEnvironment(value) {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(Object.entries(source).filter(([name, item]) => {
    if (typeof item !== "string") return false;
    const normalized = name.toUpperCase();
    if (normalized.startsWith("OPENCODE_")) return false;
    if (normalized === "AUTHORIZATION" || normalized === "PROXY_AUTHORIZATION") return false;
    if (normalized === "CYBERBOSS_OPENCODE_PROVIDER_KEY") return false;
    return !/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/.test(normalized);
  }));
}

function buildCatalog(response) {
  const providers = response.all.map((provider) => ({
    id: provider.id,
    name: provider.name,
    source: provider.source,
    connected: response.connected.includes(provider.id),
  }));
  const models = response.all.flatMap((provider) => Object.values(provider.models).map((model) => ({
    id: model.id,
    name: model.name,
    providerId: provider.id,
    inputModalities: [...model.inputModalities],
    contextWindow: model.contextWindow,
  })));
  return {
    providers,
    models,
    defaults: { ...response.default },
    connected: [...response.connected],
  };
}

function assertSelectedModelAvailable(catalog, profile) {
  if (!catalog.connected.includes(profile.providerId)) {
    throw runtimeError("PROVIDER_UNAVAILABLE", "The selected OpenCode provider is not connected.");
  }
  if (!catalog.models.some((model) => model.providerId === profile.providerId && model.id === profile.modelId)) {
    throw runtimeError("MODEL_UNAVAILABLE", "The selected OpenCode model is unavailable from the live catalog.");
  }
}

function catalogSnapshot(entry, cached) {
  return {
    providers: entry.providers.map((provider) => ({ ...provider })),
    models: entry.models.map((model) => ({ ...model, inputModalities: [...model.inputModalities] })),
    defaults: { ...entry.defaults },
    connected: [...entry.connected],
    connectedProviderFingerprint: entry.connectedProviderFingerprint,
    reportedVersion: entry.reportedVersion,
    refreshedAt: entry.refreshedAt,
    source: "opencode",
    cached,
    stale: false,
  };
}

function fingerprintConnectedProviders(connected) {
  const ids = [...new Set((Array.isArray(connected) ? connected : []).map(normalizeText).filter(Boolean))].sort();
  return crypto.createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

function mapOpenCodeEventToRuntimeEvent(event) {
  const type = normalizeText(event?.type);
  const properties = isRecord(event?.properties) ? event.properties : {};
  if (type === "message.updated") {
    const info = isRecord(properties.info) ? properties.info : {};
    if (info.role !== "assistant") return null;
    if (info.error) {
      return failureEvent(info.sessionID, info.id, mapOpenCodeFailureCode(info.error));
    }
    if (info.time?.completed) {
      return {
        type: "runtime.reply.completed",
        payload: { threadId: normalizeText(info.sessionID), turnId: normalizeText(info.id), itemId: normalizeText(info.id), text: "" },
      };
    }
    return {
      type: "runtime.turn.started",
      payload: { threadId: normalizeText(info.sessionID), turnId: normalizeText(info.id) },
    };
  }
  if (type === "message.part.updated") {
    const part = isRecord(properties.part) ? properties.part : {};
    const delta = typeof properties.delta === "string" ? properties.delta : "";
    if (part.type === "tool") {
      const state = isRecord(part.state) ? part.state : {};
      const status = normalizeText(state.status).toLowerCase();
      if (!new Set(["running", "completed", "error"]).has(status)) return null;
      return {
        type: status === "running" ? "runtime.tool.started" : "runtime.tool.completed",
        payload: {
          threadId: normalizeText(part.sessionID),
          turnId: normalizeText(part.messageID),
          toolCallId: normalizeText(part.callID || part.id),
          toolName: normalizeText(part.tool),
          ...(status === "running" ? {} : { isError: status === "error" }),
        },
      };
    }
    if (part.type !== "text" || !delta) return null;
    return {
      type: "runtime.reply.delta",
      payload: {
        threadId: normalizeText(part.sessionID),
        turnId: normalizeText(part.messageID),
        itemId: normalizeText(part.id),
        text: delta,
      },
    };
  }
  if (type === "permission.updated") {
    const patterns = Array.isArray(properties.pattern)
      ? properties.pattern
      : typeof properties.pattern === "string"
        ? [properties.pattern]
        : [];
    const commandTokens = patterns.map(normalizeText).filter(Boolean);
    return {
      type: "runtime.approval.requested",
      payload: {
        kind: "tool",
        threadId: normalizeText(properties.sessionID),
        turnId: normalizeText(properties.messageID),
        requestId: normalizeText(properties.id),
        reason: normalizeText(properties.title) || normalizeText(properties.type) || "OpenCode permission",
        command: normalizeText(properties.title) || normalizeText(properties.type),
        commandTokens,
        toolName: normalizeText(properties.type),
      },
    };
  }
  if (type === "session.idle") {
    return {
      type: "runtime.turn.completed",
      payload: { threadId: normalizeText(properties.sessionID), turnId: "" },
    };
  }
  if (type === "session.error") {
    return failureEvent(properties.sessionID, "", mapOpenCodeFailureCode(properties.error));
  }
  return null;
}

function failureEvent(threadId, turnId, code) {
  const messages = {
    INVALID_CREDENTIALS: "The OpenCode provider credentials were rejected.",
    CANCELLED: "The OpenCode turn was cancelled.",
    OUTPUT_LIMIT: "The OpenCode response exceeded the model output limit.",
    OPENCODE_TURN_FAILED: "The OpenCode turn failed.",
  };
  return {
    type: "runtime.turn.failed",
    payload: {
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      code,
      text: messages[code] || messages.OPENCODE_TURN_FAILED,
    },
  };
}

function mapOpenCodeFailureCode(error) {
  switch (normalizeText(error?.name)) {
    case "ProviderAuthError": return "INVALID_CREDENTIALS";
    case "MessageAbortedError": return "CANCELLED";
    case "MessageOutputLengthError": return "OUTPUT_LIMIT";
    default: return "OPENCODE_TURN_FAILED";
  }
}

function buildPromptParts(text, attachments) {
  const parts = [];
  if (typeof text === "string" && text.length) parts.push({ type: "text", text });
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!isRecord(attachment)) continue;
    const mime = normalizeText(attachment.mime || attachment.mimeType);
    let url = normalizeText(attachment.url);
    const filePath = normalizeText(attachment.filePath || attachment.path);
    if (!url && filePath) url = pathToFileURL(path.resolve(filePath)).toString();
    if (!mime || !url) continue;
    parts.push({
      type: "file",
      mime,
      url,
      ...(normalizeText(attachment.filename || attachment.name)
        ? { filename: normalizeText(attachment.filename || attachment.name) }
        : {}),
    });
  }
  if (!parts.length) throw runtimeError("INVALID_TURN", "An OpenCode turn requires text or an attachment.");
  return parts;
}

function generateServicePassword(randomBytes) {
  const source = typeof randomBytes === "function" ? randomBytes(32) : crypto.randomBytes(32);
  return Buffer.from(source).toString("base64url");
}

function discardProcessOutput() {}

function abortableDelay(milliseconds, signal) {
  const delay = nonNegativeInteger(milliseconds, 0);
  if (signal?.aborted) return Promise.reject(runtimeError("CANCELLED", "The OpenCode operation was cancelled."));
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(runtimeError("CANCELLED", "The OpenCode operation was cancelled."));
    };
    timer = setTimeout(onDone, delay);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw runtimeError("CANCELLED", "The OpenCode operation was cancelled.");
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function numericNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeSecret(value) {
  return typeof value === "string" ? value : "";
}

function requireText(value, code, message) {
  const text = normalizeText(value);
  if (!text) throw runtimeError(code, message);
  return text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimeError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

module.exports = {
  createOpenCodeRuntimeAdapter,
  fingerprintConnectedProviders,
  mapOpenCodeEventToRuntimeEvent,
  sanitizeEnvironment,
};
