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
const {
  mergeCodeBuddyMcpServers,
  SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
} = require("./project-settings");
const {
  buildActionRequest,
  createActionEvidenceLedger,
  finalizeActionEvidence,
  normalizeActionRequest,
  recordCodeBuddyNotification,
} = require("../shared/action-evidence");
const { buildOpeningTurnText } = require("../shared-instructions");

function createCodeBuddyRuntimeAdapter({
  config = {},
  profile,
  secrets = {},
  profileStore,
  locateDistribution = locateCodeBuddyDistribution,
  processHostFactory = (options) => new CodeBuddyProcessHost(options),
  clientFactory = (options) => new CodeBuddyClient(options),
  projectToolHost = null,
} = {}) {
  const normalizedProfile = requireCodeBuddyProfile(profile);
  const stateDir = path.resolve(requireText(config.stateDir, "INVALID_PROFILE", "CodeBuddy requires a state directory."));
  const defaultWorkspaceRoot = path.resolve(normalizeText(config.workspaceRoot) || process.cwd());
  const servicePassword = requireText(secrets.servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy gateway password is unavailable.");
  const expectedIdentity = normalizeIdentity(normalizedProfile.capabilities.accountIdentityFingerprint);
  const discoveryOnly = config.discoveryOnly === true;
  if (!expectedIdentity && !discoveryOnly) throw runtimeError("CODEBUDDY_LOGIN_REQUIRED", "CodeBuddy profile identity has not been verified.");
  const runtimeInstanceId = normalizeText(config.runtimeInstanceId) || crypto.randomUUID();
  let transportGenerationId = crypto.randomUUID();
  const sessionStore = new SessionStore({
    filePath: normalizeText(config.sessionsFile) || path.join(stateDir, "sessions.json"),
    runtimeId: "codebuddy",
  });
  const emitter = new EventEmitter();
  const randomUUID = typeof config.randomUUID === "function" ? config.randomUUID : crypto.randomUUID;
  const activeTurns = new Map();
  // A persisted session remains durable, but an in-process attachment is only
  // valid for the transport generation that established it.
  const attachedSessions = new Map();
  const pendingApprovals = new Map();
  const logger = config.logger;
  const capabilityMode = normalizeCapabilityMode(config.codebuddyCapabilityMode);
  const supervisorAllowedTools = capabilityMode === "supervisor"
    ? normalizeSupervisorAllowedTools(config.codebuddyAllowedTools, { projectToolsAvailable: Boolean(projectToolHost) })
    : null;

  let distribution = null;
  let host = null;
  let client = null;
  let ready = null;
  let readyPromise = null;
  let closed = false;
  let liveIdentity = "";
  let agentCapabilities = {};
  // A gateway-side wedged run survives `session/new`, so repeated non-terminal
  // turn timeouts escalate to restarting the managed process.
  let consecutiveNonterminalTimeouts = 0;

  function invalidateAttachments({ reason = "lifecycle", generationId = "" } = {}) {
    const nextGenerationId = normalizeText(generationId);
    const generationChanged = Boolean(nextGenerationId && nextGenerationId !== transportGenerationId);
    const previousGenerationId = transportGenerationId;
    if (generationChanged) transportGenerationId = nextGenerationId;
    attachedSessions.clear();
    logDiagnostic("runtime.transport.lifecycle", diagnosticContext("", {
      phase: "transport_lifecycle",
      lifecycle: reason,
      previousTransportGenerationId: previousGenerationId,
      transportGenerationId,
      generationChanged,
      attachedSessionCount: 0,
    }));
  }

  function handleLifecycle(event = {}) {
    const lifecycle = normalizeText(event?.type || event?.lifecycle).toLowerCase();
    const generationId = normalizeText(event?.generationId);
    if (lifecycle === "connected" && generationId && generationId === transportGenerationId) return;
    invalidateAttachments({ reason: lifecycle || "transport_lifecycle", generationId });
  }

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

  function logDiagnostic(event, data = {}) {
    try {
      logger?.info?.(event, data);
    } catch {
      // Diagnostics must never affect runtime behavior.
    }
  }

  function diagnosticContext(turnCorrelation, extra = {}) {
    return {
      runtimeId: "codebuddy",
      profileId: normalizedProfile.id,
      modelId: normalizedProfile.modelId,
      ...(normalizeText(turnCorrelation) ? { turnCorrelation: normalizeText(turnCorrelation) } : {}),
      ...extra,
    };
  }

  async function ensureTransportConnected(signal, turnCorrelation = "") {
    if (!client || typeof client.isConnected !== "function" || client.isConnected()) return;
    logDiagnostic("runtime.transport.reconnect.started", diagnosticContext(turnCorrelation, {
      phase: "transport_reconnect",
    }));
    try {
      await client.connect({ signal });
      const initialized = await client.initialize({ signal });
      agentCapabilities = isRecord(initialized?.agentCapabilities) ? { ...initialized.agentCapabilities } : agentCapabilities;
      logDiagnostic("runtime.transport.reconnect.succeeded", diagnosticContext(turnCorrelation, {
        phase: "transport_reconnect",
        transportGenerationId,
      }));
    } catch (error) {
      logDiagnostic("runtime.transport.reconnect.failed", diagnosticContext(turnCorrelation, {
        phase: "transport_reconnect",
        error: summarizeDiagnosticError(error),
      }));
      throw error;
    }
  }

  async function verifyLiveIdentity(signal) {
    const fingerprint = normalizeIdentity(await client.getIdentityFingerprint({ signal }));
    if (!fingerprint || (expectedIdentity && fingerprint !== expectedIdentity)) {
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
      host = processHostFactory({ stateDir, onLifecycle: handleLifecycle });
      const mcpServers = mergeCodeBuddyMcpServers({
        existingServers: isRecord(config.codebuddyMcpServers) ? config.codebuddyMcpServers : {},
        projectToolHost,
        workspaceRoot: defaultWorkspaceRoot,
        stateDir,
        cyberbossHome: config.cyberbossHome,
      });
      const started = await host.start({
        distribution,
        workspaceRoot: defaultWorkspaceRoot,
        servicePassword,
        ...(discoveryOnly ? {} : { model: normalizedProfile.modelId }),
        mcpServers,
        allowedTools: capabilityMode === "developer"
          ? (Array.isArray(config.codebuddyAllowedTools) ? config.codebuddyAllowedTools : null)
          : supervisorAllowedTools,
        // Supervisor mode intentionally blocks tool use, so let the managed
        // process resolve that itself instead of asking and waiting. The
        // interactive approval round trip is what previously wedged the channel:
        // a dropped permission response left the run in `waiting_for_permission`
        // and every later prompt was parked in a queue forever. Developer mode
        // keeps asking, because the control center is meant to answer.
        permissionMode: capabilityMode === "developer" ? "default" : "dontAsk",
      });
      client = clientFactory({
        endpoint: started.endpoint,
        servicePassword,
        timeoutMs: positiveInteger(config.codebuddyRequestTimeoutMs, 120_000),
        logger,
        runtimeInstanceId,
        transportGenerationId,
        onLifecycle: handleLifecycle,
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

  async function attachSession({ bindingKey, workspaceRoot, metadata, signal, turnCorrelation }) {
    let sessionId = sessionStore.getThreadIdForScope(bindingKey, workspaceRoot, runtimeScope());
    let isNewSession = false;
    const hasPersistedSessionId = Boolean(sessionId);
    logDiagnostic("runtime.session_attach.started", diagnosticContext(turnCorrelation, {
      phase: "attach",
      hasPersistedSessionId,
    }));
    if (sessionId && attachedSessions.get(sessionId) !== transportGenerationId) {
      logDiagnostic("runtime.session_attach.decision", diagnosticContext(turnCorrelation, {
        phase: "resume",
        attachDecision: "resume",
        hasPersistedSessionId,
        sessionId,
      }));
      try {
        await client.resumeSession({
          sessionId,
          workingDirectory: workspaceRoot,
          signal,
          observability: diagnosticContext(turnCorrelation, {
            phase: "resume",
            attachDecision: "resume",
            hasPersistedSessionId,
          }),
        });
        attachedSessions.set(sessionId, transportGenerationId);
        logDiagnostic("runtime.session_attach.succeeded", diagnosticContext(turnCorrelation, {
          phase: "resume",
          attachDecision: "resume",
          hasPersistedSessionId,
          sessionId,
        }));
      } catch (error) {
        logDiagnostic("runtime.session_attach.failed", diagnosticContext(turnCorrelation, {
          phase: "resume",
          attachDecision: "resume",
          hasPersistedSessionId,
          sessionId,
          error: summarizeDiagnosticError(error),
        }));
        sessionStore.clearThreadIdForScope(bindingKey, workspaceRoot, runtimeScope());
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        sessionId = "";
      }
    }
    if (!sessionId) {
      isNewSession = true;
      logDiagnostic("runtime.session_attach.decision", diagnosticContext(turnCorrelation, {
        phase: "new",
        attachDecision: "new",
        hasPersistedSessionId,
      }));
      try {
        const created = await client.newSession({
          workingDirectory: workspaceRoot,
          signal,
          observability: diagnosticContext(turnCorrelation, {
            phase: "new",
            attachDecision: "new",
            hasPersistedSessionId,
          }),
        });
        sessionId = requireText(created.sessionId, "CODEBUDDY_SESSION_FAILED", "CodeBuddy did not create a session.");
        if (created.modelId && created.modelId !== normalizedProfile.modelId) {
          throw runtimeError("CODEBUDDY_MODEL_UNAVAILABLE", "CodeBuddy did not select the configured model.");
        }
        attachedSessions.set(sessionId, transportGenerationId);
        sessionStore.setThreadIdForScope(bindingKey, workspaceRoot, runtimeScope(), sessionId, metadata);
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, sessionId, metadata);
        logDiagnostic("runtime.session_attach.succeeded", diagnosticContext(turnCorrelation, {
          phase: "new",
          attachDecision: "new",
          hasPersistedSessionId,
          sessionId,
        }));
      } catch (error) {
        logDiagnostic("runtime.session_attach.failed", diagnosticContext(turnCorrelation, {
          phase: "new",
          attachDecision: "new",
          hasPersistedSessionId,
          error: summarizeDiagnosticError(error),
        }));
        throw error;
      }
    }
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: normalizedProfile.modelId,
      modelProvider: "",
    });
    return { sessionId, isNewSession };
  }

  function forwardNotification(message, { threadId, turnId, workspaceRoot, turnCorrelation }) {
    return forwardMappedEvents(message, { threadId, turnId, workspaceRoot, turnCorrelation });
  }

  function forwardProtocolRequest(message, { threadId, turnId, workspaceRoot, turnCorrelation }) {
    return forwardMappedEvents(message, { threadId, turnId, workspaceRoot, turnCorrelation });
  }

  function forwardMappedEvents(message, { threadId, turnId, workspaceRoot, turnCorrelation }) {
    const events = mapCodeBuddyNotification(message, { threadId, turnId, workspaceRoot });
    for (const event of events) {
      if (event?.type === "runtime.approval.requested" && capabilityMode !== "developer") {
        const outcome = normalizeText(event.payload?.responseTemplate?.optionByCommand?.no);
        emit({
          type: "runtime.approval.denied",
          payload: runtimePayload({
            threadId,
            turnId,
            workspaceRoot,
            requestId: event.payload.requestId,
            code: "CODEBUDDY_CAPABILITY_DENIED",
          }),
        }, message);
        if (outcome) {
          void respondToPermissionResilient({
            requestId: message?.id ?? event.payload.requestId,
            outcome,
            sessionId: threadId,
            turnCorrelation,
            phase: "automatic_denial",
          });
        }
        continue;
      }
      if (event?.type === "runtime.approval.requested") {
        pendingApprovals.set(normalizeRpcId(event.payload.requestId), {
          threadId,
          rpcId: message?.id,
          responseTemplate: event.payload.responseTemplate,
        });
      }
      emit({
        ...event,
        payload: runtimePayload({ ...event.payload, workspaceRoot, turnCorrelation }),
      }, message);
      if (event?.type === "runtime.approval.denied" && event.payload.response?.outcome) {
        void respondToPermissionResilient({
          requestId: message?.id ?? event.payload.requestId,
          outcome: event.payload.response.outcome,
          sessionId: threadId,
          turnCorrelation,
          phase: "automatic_denial",
        });
      }
    }
    return events;
  }

  // A permission response that never lands strands the gateway run in
  // `waiting_for_permission`: every later prompt is queued behind it and never
  // runs, and the bridge only sees a non-terminal stream that times out. The
  // response is best-effort by design, so retry once before giving up, and never
  // drop the failure silently.
  async function respondToPermissionResilient({ requestId, outcome, sessionId, turnCorrelation, phase }) {
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await sendPermissionResponse({ requestId, outcome, sessionId, turnCorrelation, phase });
        return;
      } catch (error) {
        if (attempt >= attempts) {
          logDiagnostic("runtime.approval.response.abandoned", diagnosticContext(turnCorrelation, {
            phase,
            attempts,
            requestIdFingerprint: fingerprintIdentifier(normalizeRpcId(requestId)),
            error: summarizeDiagnosticError(error),
          }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async function sendPermissionResponse({ requestId, outcome, sessionId, turnCorrelation, phase, signal }) {
    const normalizedRequestId = normalizeRpcId(requestId);
    logDiagnostic("runtime.approval.response.started", diagnosticContext(turnCorrelation, {
      phase,
      requestIdFingerprint: fingerprintIdentifier(normalizedRequestId),
      sessionIdFingerprint: fingerprintIdentifier(sessionId),
    }));
    try {
      const response = await client?.respondPermission?.({
        requestId,
        outcome,
        sessionId,
        signal,
        observability: diagnosticContext(turnCorrelation, {
          phase,
          requestIdFingerprint: fingerprintIdentifier(normalizedRequestId),
        }),
      });
      logDiagnostic("runtime.approval.response.succeeded", diagnosticContext(turnCorrelation, {
        phase,
        requestIdFingerprint: fingerprintIdentifier(normalizedRequestId),
        sessionIdFingerprint: fingerprintIdentifier(sessionId),
        responsePresent: Boolean(response),
      }));
      return response;
    } catch (error) {
      logDiagnostic("runtime.approval.response.failed", diagnosticContext(turnCorrelation, {
        phase,
        requestIdFingerprint: fingerprintIdentifier(normalizedRequestId),
        sessionIdFingerprint: fingerprintIdentifier(sessionId),
        error: summarizeDiagnosticError(error),
      }));
      throw error;
    }
  }

  // A wedged run lives on the managed CLI's internal per-workspace session, not
  // on the ACP-facing session id, so `session/new` cannot clear it. Only a fresh
  // managed process does — which is exactly what the observed incident needed.
  async function restartManagedGateway() {
    const currentClient = client;
    const currentHost = host;
    client = null;
    host = null;
    ready = null;
    readyPromise = null;
    attachedSessions.clear();
    try { await Promise.resolve(currentClient?.disconnect?.()); } catch {}
    try { await Promise.resolve(currentHost?.stop?.()); } catch {}
    logDiagnostic("runtime.managed_restart.completed", diagnosticContext("", {
      phase: "managed_gateway_restart",
    }));
  }

  function resetOrdinarySessionAfterTimeout({ bindingKey, workspaceRoot, threadId, turnCorrelation, error, controller, systemTurn = false }) {
    const diagnostic = error?.diagnostic;
    // A proactive turn must never reset the session that the user's turns share
    // with it: clearing the binding here would make the next user turn start a
    // brand-new session and drop the conversation. `systemTurn` carries that
    // fact explicitly now that proactive turns reuse the user's binding key;
    // the `::system` suffix is kept as a fallback for pre-existing bindings.
    const abortOrSystem = Boolean(controller?.signal?.aborted)
      || systemTurn === true
      || normalizeText(bindingKey).endsWith("::system");
    const nonterminalTimeout = normalizeText(error?.code) === "CODEBUDDY_START_TIMEOUT"
      && normalizeText(diagnostic?.timeoutKind) === "overall_turn"
      && diagnostic?.terminalEventSeen === false;
    if (abortOrSystem || !nonterminalTimeout) {
      consecutiveNonterminalTimeouts = 0;
      return false;
    }
    sessionStore.clearThreadIdForScope(bindingKey, workspaceRoot, runtimeScope());
    sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    attachedSessions.delete(threadId);
    consecutiveNonterminalTimeouts += 1;
    const escalate = consecutiveNonterminalTimeouts >= 2;
    if (escalate) consecutiveNonterminalTimeouts = 0;
    logDiagnostic("runtime.session_migration.reset", diagnosticContext(turnCorrelation, {
      phase: "ordinary_session_recovery",
      bindingKind: "ordinary",
      resetReason: "overall_turn_timeout_nonterminal",
      sessionIdFingerprint: fingerprintIdentifier(threadId),
      timeoutStage: normalizeText(diagnostic.stage),
      sseEventCount: nonNegativeInteger(diagnostic.sseEventCount),
      lastEventType: normalizeText(diagnostic.lastEventType),
      ...(escalate ? { escalation: "managed_gateway_restart" } : {}),
    }));
    if (escalate) void restartManagedGateway().catch(() => {});
    return true;
  }

  async function runTurn({ bindingKey, threadId, turnId, workspaceRoot, text, controller, turnCorrelation = "", actionRequest = {}, systemTurn = false }) {
    const startedAt = Date.now();
    const correlation = normalizeText(turnCorrelation);
    const actionEvidenceLedger = createActionEvidenceLedger(actionRequest);
    try {
      let streamedReply = false;
      const reply = await client.prompt({
        sessionId: threadId,
        text,
        signal: controller.signal,
        observability: diagnosticContext(correlation, { phase: "prompt" }),
        onNotification: (message) => {
          recordCodeBuddyNotification(actionEvidenceLedger, message);
          const events = forwardNotification(message, { threadId, turnId, workspaceRoot, turnCorrelation: correlation });
          if (events.some((event) => event?.type === "runtime.reply.delta")) {
            streamedReply = true;
          }
        },
        onRequest: (message) => forwardProtocolRequest(message, { threadId, turnId, workspaceRoot, turnCorrelation: correlation }),
      });
      const normalizedUsage = hasUsageFields(reply.usage) ? normalizeCodeBuddyUsage(reply.usage) : {};
      const completionPayload = {
        threadId,
        turnId,
        workspaceRoot,
        turnCorrelation: correlation,
        text: reply.text,
        actionEvidence: finalizeActionEvidence(actionEvidenceLedger),
        ...(normalizedUsage.usage ? { usage: normalizedUsage.usage } : {}),
        ...(normalizedUsage.vendorUsage ? { vendorUsage: normalizedUsage.vendorUsage } : {}),
      };
      if (reply.stopReason === "cancelled") {
        logDiagnostic("runtime.turn.failed", diagnosticContext(correlation, {
          phase: "runtime_turn",
          sessionIdFingerprint: fingerprintIdentifier(threadId),
          latencyMs: Date.now() - startedAt,
          failureStage: "runtime.turn",
          errorClass: "CancelledError",
          errorCode: "CANCELLED",
        }));
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
      const replyText = typeof reply.text === "string" ? reply.text : "";
      logDiagnostic("runtime.turn.completed", diagnosticContext(correlation, {
        phase: "runtime_turn_completed",
        sessionIdFingerprint: fingerprintIdentifier(threadId),
        latencyMs: Date.now() - startedAt,
        stopReason: normalizeStopReason(reply.stopReason),
        assistantReplyPresent: Boolean(replyText.trim()),
        replyCharLength: replyText.length,
        replyByteLength: Buffer.byteLength(replyText, "utf8"),
        replyEmpty: !replyText.trim(),
      }));
      consecutiveNonterminalTimeouts = 0;
      emit({
        type: "runtime.turn.completed",
        payload: runtimePayload(completionPayload),
      });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const sessionReset = resetOrdinarySessionAfterTimeout({
        bindingKey,
        workspaceRoot,
        threadId,
        turnCorrelation: correlation,
        error,
        controller,
        systemTurn,
      });
      const failure = mapCodeBuddyFailure(cancelled ? { code: "CANCELLED" } : error, { threadId, turnId, turnCorrelation: correlation });
      logDiagnostic("runtime.turn.failed", diagnosticContext(correlation, {
        phase: "runtime_turn",
        sessionIdFingerprint: fingerprintIdentifier(threadId),
        latencyMs: Date.now() - startedAt,
        failureStage: "runtime.turn",
        errorClass: cancelled ? "CancelledError" : normalizeText(error?.name) || "Error",
        errorCode: cancelled ? "CANCELLED" : normalizeText(error?.code) || normalizeText(failure.payload?.code) || "CODEBUDDY_TURN_FAILED",
        ...(sessionReset ? { sessionRecovery: "ordinary_session_reset" } : {}),
        ...(!cancelled && error?.diagnostic?.timeoutKind ? {
          timeoutKind: normalizeText(error.diagnostic.timeoutKind),
          timeoutStage: normalizeText(error.diagnostic.stage),
          sseEventCount: nonNegativeInteger(error.diagnostic.sseEventCount),
          terminalEventSeen: error.diagnostic.terminalEventSeen === true,
          lastEventType: normalizeText(error.diagnostic.lastEventType),
        } : {}),
      }));
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
    async listModels({ signal } = {}) {
      await initialize({ signal });
      await ensureTransportConnected(signal);
      await verifyLiveIdentity(signal);
      if (typeof client?.listModels !== "function") {
        throw runtimeError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy model discovery is unavailable.");
      }
      const result = await client.listModels({ workingDirectory: defaultWorkspaceRoot, signal });
      return {
        models: Array.isArray(result?.models) ? result.models.map((model) => ({
          id: normalizeText(model?.id),
          name: normalizeText(model?.name) || normalizeText(model?.id),
        })).filter((model) => model.id) : [],
        source: "codebuddy-acp-session-new",
        currentModelId: normalizeText(result?.currentModelId),
      };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, signal, turnCorrelation = "" } = {}) {
      const correlation = normalizeText(turnCorrelation) || normalizeText(metadata?.turnCorrelation);
      let stage = "initialize";
      logDiagnostic("runtime.dispatch.started", diagnosticContext(correlation, { phase: "dispatch" }));
      try {
        await initialize({ signal });
        await ensureTransportConnected(signal, correlation);
        stage = "validate_input";
        const binding = requireText(bindingKey, "INVALID_TURN", "A CodeBuddy binding key is required.");
        const directory = path.resolve(requireText(workspaceRoot, "INVALID_TURN", "A CodeBuddy workspace is required."));
        const promptText = requireText(text, "CODEBUDDY_TURN_FAILED", "A CodeBuddy prompt is required.");
        if (Array.isArray(attachments) && attachments.length) {
          throw runtimeError("CODEBUDDY_TURN_FAILED", "CodeBuddy attachments are not enabled yet.");
        }
        stage = "verify_identity";
        await verifyLiveIdentity(signal);
        stage = "attach_session";
        const attached = await attachSession({
          bindingKey: binding,
          workspaceRoot: directory,
          metadata,
          signal,
          turnCorrelation: correlation,
        });
        const threadId = attached.sessionId;
        const outboundText = attached.isNewSession
          ? buildOpeningTurnText(config, promptText)
          : promptText;
        stage = "create_turn";
        const turnId = requireText(randomUUID(), "CODEBUDDY_TURN_FAILED", "A CodeBuddy turn identifier is unavailable.");
        const controller = new AbortController();
        const abortFromParent = () => controller.abort(signal?.reason);
        if (signal?.aborted) abortFromParent();
        else signal?.addEventListener?.("abort", abortFromParent, { once: true });
        logDiagnostic("runtime.turn.started", diagnosticContext(correlation, {
          phase: "runtime_turn_started",
          threadId,
          turnId,
        }));
        const actionRequest = normalizeActionRequest(metadata?.actionRequest || buildActionRequest(metadata?.actionRequestText || promptText));
        emit({ type: "runtime.turn.started", payload: runtimePayload({
          threadId,
          turnId,
          workspaceRoot: directory,
          turnCorrelation: correlation,
          actionRequest,
        }) });
        const pending = runTurn({
          bindingKey: binding,
          threadId,
          turnId,
          workspaceRoot: directory,
          text: outboundText,
          controller,
          turnCorrelation: correlation,
          actionRequest,
          systemTurn: metadata?.systemTurn === true,
        })
          .finally(() => {
            signal?.removeEventListener?.("abort", abortFromParent);
            activeTurns.delete(turnId);
          });
        activeTurns.set(turnId, { controller, pending, threadId });
        return { threadId, turnId };
      } catch (error) {
        logDiagnostic("runtime.dispatch.failed", diagnosticContext(correlation, {
          phase: stage,
          error: summarizeDiagnosticError(error),
        }));
        throw error;
      }
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
      await sendPermissionResponse({
        requestId: pending.rpcId ?? normalizedRequestId,
        outcome,
        sessionId: pending.threadId,
        turnCorrelation: "",
        phase: "user_decision",
        signal,
      });
      pendingApprovals.delete(normalizedRequestId);
      return { requestId: normalizedRequestId, decision: accepted ? "accept" : "decline" };
    },
    async resumeThread({ threadId, workspaceRoot, signal } = {}) {
      await initialize({ signal });
      await ensureTransportConnected(signal);
      const normalizedThreadId = requireText(threadId, "CODEBUDDY_SESSION_FAILED", "A CodeBuddy session is required.");
      await verifyLiveIdentity(signal);
      await client.resumeSession({
        sessionId: normalizedThreadId,
        workingDirectory: path.resolve(normalizeText(workspaceRoot) || defaultWorkspaceRoot),
        signal,
      });
      attachedSessions.set(normalizedThreadId, transportGenerationId);
      return { threadId: normalizedThreadId };
    },
    async compactThread({ threadId, workspaceRoot, signal } = {}) {
      await initialize({ signal });
      await ensureTransportConnected(signal);
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
      invalidateAttachments({ reason: "adapter_close" });
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
function normalizeStopReason(value) {
  const normalized = normalizeText(value).toLowerCase();
  return new Set(["end_turn", "cancelled", "max_tokens", "tool_use", "stop"]).has(normalized)
    ? normalized
    : normalized ? "other" : "unspecified";
}
function fingerprintIdentifier(value) {
  const normalized = normalizeText(value);
  return normalized
    ? `sha256:${crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16)}`
    : "";
}
function summarizeDiagnosticError(error) {
  const diagnostic = error?.diagnostic && typeof error.diagnostic === "object" ? error.diagnostic : {};
  const code = diagnostic.upstreamCode ?? (normalizeText(error?.code) || null);
  const detail = normalizeText(diagnostic.upstreamMessage);
  return {
    class: normalizeText(error?.name) || "Error",
    ...(code == null || code === "" ? {} : { code }),
    ...(detail ? { detail: sanitizeDiagnosticText(detail) } : {}),
  };
}
function sanitizeDiagnosticText(value) {
  return normalizeText(value).slice(0, 300).replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}
function normalizeCapabilityMode(value) {
  return normalizeText(value).toLowerCase() === "developer" ? "developer" : "supervisor";
}
function normalizeSupervisorAllowedTools(value, { projectToolsAvailable = false } = {}) {
  if (value === undefined) {
    return projectToolsAvailable ? [...SUPERVISOR_PROJECT_TOOL_ALLOWLIST] : ["mcp__cyberboss_supervisor__disabled"];
  }
  const tools = Array.isArray(value) ? value.map(normalizeText).filter(Boolean) : [];
  if (tools.some((tool) => !/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_.:-]+$/.test(tool))) {
    throw runtimeError("CODEBUDDY_CAPABILITY_POLICY_INVALID", "Supervisor CodeBuddy tools must be explicit MCP tool names.");
  }
  if (!tools.length) return ["mcp__cyberboss_supervisor__disabled"];
  if (projectToolsAvailable && tools.some((tool) => !SUPERVISOR_PROJECT_TOOL_ALLOWLIST.includes(tool))) {
    throw runtimeError("CODEBUDDY_CAPABILITY_POLICY_INVALID", "Supervisor CodeBuddy tools must use the approved project-tool allowlist.");
  }
  return [...new Set(tools)];
}
function requireText(value, code, message) { const text = normalizeText(value); if (!text) throw runtimeError(code, message); return text; }
function nonNegativeInteger(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { createCodeBuddyRuntimeAdapter };
