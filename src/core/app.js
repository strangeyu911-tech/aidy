const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const {
  buildPollError,
  buildPollResult,
  fingerprint,
  monotonicNowMs,
} = require("../adapters/channel/weixin/poll-observability");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createRuntimeAdapter } = require("../adapters/runtime/factory");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ZhijiantimeClient, ZhijiantimeDailySupervisor } = require("../integrations/zhijiantime");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const { VisionFallback } = require("../services/vision-fallback");
const { CredentialVault } = require("../security/credential-vault");
const { DiagnosticCapture } = require("../security/diagnostic-capture");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { DesktopStateStore } = require("./desktop-state-store");
const { extractExplicitCheckpoint } = require("./explicit-checkpoint");
const { inferContextualCheckpoint } = require("./contextual-checkpoint");
const { SupervisionPlanStore } = require("./supervision-plan-store");
const {
  isStaleTimeSensitiveSystemMessage,
  resolveSupervisionKey,
  sourcePriority,
} = require("./supervision-policy");
const { ProviderProfileStore } = require("./provider-profile-store");
const { BridgeControlServer } = require("./bridge-control-server");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { coalesceSystemMessages, SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { normalizeWorkspaceRoot } = require("./workspace-path");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { ComponentLogger } = require("./component-logger");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;
const PROACTIVE_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const PROACTIVE_CIRCUIT_FAILURE_THRESHOLD = 3;
const PROACTIVE_CIRCUIT_COOLDOWN_MS = 120_000;
const PROACTIVE_BURST_WINDOW_MS = 60_000;
const PROACTIVE_MAX_MESSAGES_WITHOUT_USER_TURN = 3;
const PROACTIVE_MAX_MESSAGES_AFTER_USER_TURN = 1;

class CyberbossApp {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.profileStore = dependencies.profileStore || new ProviderProfileStore({ filePath: config.providerProfilesFile });
    this.credentialVault = dependencies.vault || new CredentialVault({ filePath: config.credentialVaultFile });
    this.diagnosticCapture = dependencies.capture || new DiagnosticCapture({ filePath: config.diagnosticCaptureFile });
    this.logger = dependencies.logger || new ComponentLogger({
      logDir: path.join(config.stateDir, "logs"),
      component: "bridge",
    });
    this.runtimeAdapterFactory = dependencies.runtimeAdapterFactory || createRuntimeAdapter;
    this.runtimeAdapter = null;
    this.activeProfile = null;
    this.visionFallback = null;
    this.threadStateStore = new ThreadStateStore();
    this.supervisionPlanStore = new SupervisionPlanStore({ stateDir: config.stateDir });
    this.systemMessageQueue = new SystemMessageQueueStore({
      filePath: config.systemMessageQueueFile,
      resolveSupervisionKey: (message) => this.resolveLegacySupervisionKey(message),
    });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.desktopStateStore = new DesktopStateStore({ stateDir: config.stateDir });
    this.zhijiantimeDailySupervisor = new ZhijiantimeDailySupervisor({
      stateDir: config.stateDir,
      client: new ZhijiantimeClient({
        rootDir: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", ".."),
        mcpServersFile: config.codexMcpServersFile,
      }),
      planStore: this.supervisionPlanStore,
    });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = null;
    this.pendingOperationByRunKey = new Map();
    this.systemMessageByRunKey = new Map();
    this.proactiveProviderFailures = 0;
    this.proactiveProviderCooldownUntil = 0;
    this.proactiveBurstByScope = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.activeTurnRecords = new Map();
    this.drainingForSwitch = false;
    this.nonInterruptibleBoundaryCount = 0;
    this.bridgeControlServer = null;
    this.runtimeState = null;
  }

  async ensureRuntimeAdapter() {
    if (this.runtimeAdapter) return this.runtimeAdapter;
    const activeProfile = this.profileStore.getActive();
    if (!activeProfile) {
      throw Object.assign(new Error("No active model profile is configured. Open Control Center to verify and activate one. [NO_ACTIVE_ENGINE]"), {
        code: "NO_ACTIVE_ENGINE",
      });
    }
    const runtimeConfig = { ...this.config, capture: this.diagnosticCapture, logger: this.logger };
    const adapter = await this.runtimeAdapterFactory({
      config: runtimeConfig,
      profileStore: this.profileStore,
      vault: this.credentialVault,
      projectToolHost: this.projectToolHost,
    });
    this.activeProfile = this.profileStore.getActive();
    if (!this.activeProfile || this.activeProfile.id !== activeProfile.id) {
      await Promise.resolve(adapter.close?.()).catch(() => {});
      throw Object.assign(new Error("The global active profile changed during startup. [ACTIVE_PROFILE_CHANGED]"), {
        code: "ACTIVE_PROFILE_CHANGED",
      });
    }
    this.runtimeAdapter = adapter;
    this.visionFallback = new VisionFallback({
      config: runtimeConfig,
      profileStore: this.profileStore,
      vault: this.credentialVault,
      projectToolHost: this.projectToolHost,
      capture: this.diagnosticCapture,
    });
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: adapter.getSessionStore(),
      runtimeId: adapter.describe().id,
      logger: this.logger,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
    });
    adapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(withUsageProfile(event, this.activeProfile?.id));
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
    return adapter;
  }

  printDoctor() {
    const activeProfile = this.profileStore.getActive();
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter?.describe?.() || (activeProfile ? {
        id: activeProfile.runtimeId,
        profileId: activeProfile.id,
        provider: activeProfile.providerId,
        model: activeProfile.modelId,
        initialized: false,
      } : { id: "", code: "NO_ACTIVE_ENGINE", initialized: false }),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    await this.ensureRuntimeAdapter();
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    this.runtimeState = runtimeState;
    await this.startBridgeControlServer();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    await this.restoreBoundThreadSubscriptions();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[cyberboss] bridge loop started; waiting for WeChat messages.");
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }

    const shutdown = createShutdownController(async () => {
      this.clearPendingImageInboundTimers();
      await this.bridgeControlServer?.close?.();
      await this.closeLocationServer();
      await this.zhijiantimeDailySupervisor.close();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      let pollSequence = 0;
      while (!shutdown.stopped) {
        const pollSequenceId = `poll-${++pollSequence}`;
        let pollCursorBefore = "";
        let pollStartedAt = "";
        let pollStartedMonotonicMs = 0;
        let pollMeta = {};
        try {
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          pollCursorBefore = this.channelAdapter.loadSyncBuffer();
          pollStartedAt = new Date().toISOString();
          pollStartedMonotonicMs = monotonicNowMs();
          this.logRuntimeDiagnostic?.("poll.started", {
            pollSequenceId,
            startedAt: pollStartedAt,
            startedMonotonicMs: pollStartedMonotonicMs,
            cursorBefore: safePollCursor(pollCursorBefore),
          });
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: pollCursorBefore,
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          pollMeta = this.channelAdapter.consumeLastPollMeta?.() || {};
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          let parserAcceptedCount = 0;
          let parserRejectedCount = 0;
          try {
            for (const message of messages) {
              if (shutdown.stopped) {
                break;
              }
              let accepted;
              try {
                accepted = await this.handleIncomingMessage(message);
              } catch (error) {
                if (error && error.inboundParserAccepted) {
                  parserAcceptedCount += 1;
                }
                throw error;
              }
              if (accepted) {
                parserAcceptedCount += 1;
              } else {
                parserRejectedCount += 1;
              }
            }
          } finally {
            this.logRuntimeDiagnostic?.("poll.result", buildPollResult({
              pollSequenceId,
              startedAt: pollStartedAt,
              startedMonotonicMs: pollStartedMonotonicMs,
              cursorBefore: pollCursorBefore,
              cursorAfter: this.channelAdapter.loadSyncBuffer(),
              responseMeta: pollMeta,
              updates: Array.isArray(response?.msgs) ? response.msgs : [],
              parserAcceptedCount,
              parserRejectedCount,
            }));
          }
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages({ skipCheckin: messages.length > 0 }),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          pollMeta = this.channelAdapter.consumeLastPollMeta?.() || pollMeta;
          if (pollStartedAt) {
            this.logRuntimeDiagnostic?.("poll.error", buildPollError({
              pollSequenceId,
              startedAt: pollStartedAt,
              startedMonotonicMs: pollStartedMonotonicMs,
              cursorBefore: pollCursorBefore,
              error,
              responseMeta: pollMeta,
            }));
          }
          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.zhijiantimeDailySupervisor.close();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
        taskType: "location",
        sendTrigger: "location_trigger",
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
        taskType: "location",
        sendTrigger: "location_movement",
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return false;
    }

    const turnCorrelation = crypto.randomUUID();
    this.logRuntimeDiagnostic?.("inbound.received", {
      turnCorrelation,
      runtimeId: normalizeText(this.runtimeAdapter?.describe?.().id),
      profileId: normalizeText(this.activeProfile?.id || this.profileStore?.getActive?.()?.id),
      modelId: normalizeText(this.activeProfile?.modelId || this.profileStore?.getActive?.()?.modelId),
      provider: normalizeText(normalized.provider),
      hasText: Boolean(normalizeText(normalized.text)),
      attachmentCount: Array.isArray(normalized.attachments) ? normalized.attachments.length : 0,
    });

    this.primeDeferredRepliesForSender(normalized);
    try {
      await this.handlePreparedMessage({ ...normalized, turnCorrelation }, { allowCommands: true });
    } catch (error) {
      if (error && typeof error === "object") {
        try {
          Object.defineProperty(error, "inboundParserAccepted", {
            configurable: true,
            enumerable: false,
            value: true,
          });
        } catch {
          // Best-effort marker for poll telemetry; preserve the original error.
        }
      }
      throw error;
    }
    return true;
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const turnCorrelation = normalizeText(normalized?.turnCorrelation) || crypto.randomUUID();
    if (!normalizeText(normalized?.turnCorrelation)) {
      this.logRuntimeDiagnostic?.("inbound.received", {
        turnCorrelation,
        runtimeId: normalizeText(this.runtimeAdapter?.describe?.().id),
        profileId: normalizeText(this.activeProfile?.id || this.profileStore?.getActive?.()?.id),
        modelId: normalizeText(this.activeProfile?.modelId || this.profileStore?.getActive?.()?.modelId),
        provider: normalizeText(normalized?.provider),
        hasText: Boolean(normalizeText(normalized?.text)),
        attachmentCount: Array.isArray(normalized?.attachments) ? normalized.attachments.length : 0,
      });
    }
    normalized = { ...normalized, turnCorrelation };
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    });

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    normalized = CyberbossApp.prototype.captureSupervisionArrangement.call(this, normalized);

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  captureSupervisionArrangement(normalized) {
    if (!this.desktopStateStore || !this.supervisionPlanStore || !normalized || normalized.provider === "system" || !normalizeText(normalized.text)) {
      return normalized;
    }
    const sourceRef = normalizeText(normalized.messageId);
    if (sourceRef && this.supervisionPlanStore.list().some((item) => item.sourceRef === sourceRef)) {
      return normalized;
    }
    const planningCommitment = this.zhijiantimeDailySupervisor?.capturePlanningCommitment(normalized.text, { sourceRef });
    if (planningCommitment) {
      const systemNote = [
        "[CyberBoss supervision note]",
        `A zhijiantime daily-planning follow-up was saved for ${planningCommitment.checkpoint.dueAt}.`,
        `In this reply, naturally tell the user: “${planningCommitment.announcement}”`,
        "Do not mention this note or expose internal scheduling fields.",
      ].join("\n");
      return { ...normalized, text: `${normalized.text}\n\n${systemNote}` };
    }
    const settings = this.desktopStateStore.get();
    const arrangement = extractExplicitCheckpoint(normalized.text)
      || inferContextualCheckpoint(normalized.text, { durations: settings.contextDurations });
    if (!arrangement) {
      return normalized;
    }
    const checkpoint = this.supervisionPlanStore.add({
      ...arrangement,
      sourceRef,
      announcedAt: new Date().toISOString(),
    });
    this.supervisionPlanStore.supersedeCanonical(checkpoint.canonicalTaskId, checkpoint.id);
    const systemNote = [
      "[CyberBoss supervision note]",
      `A ${checkpoint.source} follow-up was saved for ${checkpoint.dueAt}.`,
      `In this reply, naturally tell the user: “${arrangement.announcement}”`,
      "Do not mention this note or expose internal scheduling fields.",
    ].join("\n");
    return { ...normalized, text: `${normalized.text}\n\n${systemNote}` };
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    if (this.drainingForSwitch) {
      return true;
    }
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const turnCorrelation = normalizeText(prepared?.turnCorrelation) || crypto.randomUUID();
    this.logRuntimeDiagnostic?.("dispatchPreparedTurn.entry", {
      turnCorrelation,
      runtimeId: normalizeText(this.runtimeAdapter?.describe?.().id),
      profileId: normalizeText(this.activeProfile?.id || this.profileStore?.getActive?.()?.id),
      modelId: normalizeText(this.activeProfile?.modelId || this.profileStore?.getActive?.()?.modelId),
    });
    if (this.drainingForSwitch) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    const activeRecordId = crypto.randomUUID();
    const controller = new AbortController();
    this.activeTurnRecords.set(activeRecordId, {
      id: activeRecordId,
      bindingKey,
      workspaceRoot,
      threadId: "",
      turnId: "",
      turnCorrelation,
      stage: "dispatchPreparedTurn.entry",
      controller,
      startedAt: new Date().toISOString(),
      systemMessage: prepared.provider === "system" && prepared.systemMessage?.id
        ? { ...prepared.systemMessage }
        : null,
    });
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    try {
      const activeRecord = this.activeTurnRecords.get(activeRecordId);
      if (activeRecord) activeRecord.stage = "resolve_profile";
      const activeProfile = resolveGlobalActiveProfile(this, {
        sessionStore: this.runtimeAdapter.getSessionStore(),
        bindingKey,
        workspaceRoot,
      });
      const model = activeProfile.modelId;
      const parentTurn = {
        id: normalizeText(prepared?.id || prepared?.messageId) || crypto.randomUUID(),
        profileId: activeProfile.id,
        usage: { total: { inputTokens: 0, outputTokens: 0 }, byProfile: {}, childOperations: [] },
      };
      const runtimeSignal = prepared?.signal
        ? AbortSignal.any([controller.signal, prepared.signal])
        : controller.signal;
      if (activeRecord) activeRecord.stage = "build_runtime_turn";
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model, parentTurn, signal: runtimeSignal });
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const runtimeBindingKey = prepared.provider === "system"
        ? buildSystemRuntimeBindingKey(bindingKey)
        : bindingKey;
      if (activeRecord) activeRecord.stage = "runtime_send";
      const turn = await sendTurn({
        bindingKey: runtimeBindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          activeProfileId: activeProfile.id,
          visionUsage: runtimeTurn.usageAttributions,
        },
        turnCorrelation,
      });
      if (activeRecord) activeRecord.stage = "runtime_turn_started";
      if (activeRecord) {
        activeRecord.threadId = normalizeText(turn.threadId);
        activeRecord.turnId = normalizeText(turn.turnId);
        const state = this.threadStateStore.getThreadState(activeRecord.threadId);
        if (state && ["idle", "failed"].includes(state.status)
          && (!activeRecord.turnId || !state.turnId || state.turnId === activeRecord.turnId)) {
          this.activeTurnRecords.delete(activeRecordId);
        }
      }
      for (const attribution of runtimeTurn.usageAttributions || []) {
        this.threadStateStore.recordUsage(turn.threadId, {
          ...attribution,
          turnId: turn.turnId,
          kind: "vision",
        });
      }
      if (prepared.provider !== "system") {
        this.runtimeContextStore?.setActiveContext?.({
          workspaceRoot,
          runtimeId: this.runtimeAdapter.describe().id,
          threadId: turn.threadId,
          bindingKey,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
        });
      }
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      if (prepared.provider === "system" && prepared.systemMessage?.id) {
        this.systemMessageByRunKey.set(buildRunKey(turn.threadId, turn.turnId), {
          ...prepared.systemMessage,
          __bindingKey: bindingKey,
          __workspaceRoot: workspaceRoot,
        });
      } else {
        this.beginProactiveBurst?.(bindingKey, workspaceRoot);
      }
      return true;
    } catch (error) {
      const activeRecord = this.activeTurnRecords.get(activeRecordId);
      this.activeTurnRecords.delete(activeRecordId);
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const errorCode = normalizeText(error?.code) || "RUNTIME_TURN_START_FAILED";
      this.logRuntimeDiagnostic?.("dispatchPreparedTurn.failed", {
        turnCorrelation,
        runtimeId: normalizeText(this.runtimeAdapter?.describe?.().id),
        profileId: normalizeText(this.activeProfile?.id || this.profileStore?.getActive?.()?.id),
        modelId: normalizeText(this.activeProfile?.modelId || this.profileStore?.getActive?.()?.modelId),
        stage: normalizeText(activeRecord?.stage) || "runtime_send",
        error: summarizeRuntimeDiagnosticError(error),
      });
      console.error(`[cyberboss] runtime turn start failed provider=${prepared.provider || "user"} code=${errorCode}`);
      if (prepared.provider === "system" && prepared.systemMessage?.id) {
        this.scheduleSystemMessageRetry(prepared.systemMessage, error);
        return true;
      }
      return false;
    }
  }

  async buildRuntimeTurn({ prepared, model = "", parentTurn = {}, signal } = {}) {
    if (prepared?.provider === "system") {
      return {
        text: String(prepared.text || "").trim(),
        attachments: [],
      };
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
      visionFallback: this.visionFallback,
      parentTurn,
      signal,
    });
    if (visionContext.blockingError) {
      throw Object.assign(new Error(visionContext.blockingError.message), {
        code: visionContext.blockingError.code,
        attachmentErrors: visionContext.errors,
      });
    }
    return {
      text: assembleRuntimeTurnText({
        prepared,
        config: this.config,
        visionContext,
      }),
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
      usageAttributions: Array.isArray(visionContext.usageAttributions) ? visionContext.usageAttributions : [],
    };
  }

  requireActiveProfile() {
    return resolveGlobalActiveProfile(this);
  }

  async startBridgeControlServer() {
    const token = normalizeText(process.env.CYBERBOSS_BRIDGE_CONTROL_TOKEN);
    const port = Number(this.config.bridgeControlPort);
    if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    this.bridgeControlServer = new BridgeControlServer({ app: this, token, port });
    return this.bridgeControlServer.start();
  }

  getBridgeControlStatus() {
    const activeProfile = this.activeProfile || this.profileStore?.getActive?.() || null;
    const runtime = this.runtimeAdapter?.describe?.() || {};
    const externalOpenCode = activeProfile?.runtimeId === "opencode" && activeProfile?.ownershipMode === "external";
    return {
      draining: Boolean(this.drainingForSwitch),
      activeTurns: this.activeTurnRecords?.size || 0,
      nonInterruptibleBoundary: (this.nonInterruptibleBoundaryCount || 0) > 0,
      runtimeReady: Boolean(this.runtimeAdapter && this.runtimeState),
      activeProfileId: normalizeText(activeProfile?.id),
      runtimeId: normalizeText(activeProfile?.runtimeId || runtime.id),
      modelId: normalizeText(activeProfile?.modelId || runtime.model),
      secretGeneration: Number.isSafeInteger(Number(activeProfile?.secretGeneration)) ? Number(activeProfile.secretGeneration) : 0,
      catalogLive: externalOpenCode ? Boolean(this.runtimeState?.catalog && this.runtimeState.catalog.cached === false) : true,
    };
  }

  async drainForSwitch({ deadlineAt } = {}) {
    this.drainingForSwitch = true;
    const parsedDeadline = Date.parse(normalizeText(deadlineAt));
    const deadlineMs = Number.isFinite(parsedDeadline) ? parsedDeadline : Date.now();
    while ((this.activeTurnRecords?.size || 0) > 0) {
      const deadlineExceeded = Date.now() >= deadlineMs;
      const atBoundary = (this.nonInterruptibleBoundaryCount || 0) > 0;
      if (deadlineExceeded && !atBoundary) break;
      await sleep(10);
    }
    return {
      ...this.getBridgeControlStatus(),
      deadlineExceeded: Date.now() >= deadlineMs && (this.activeTurnRecords?.size || 0) > 0,
    };
  }

  async abortActiveTurns(reason = "runtime profile switch") {
    const records = [...(this.activeTurnRecords?.values?.() || [])];
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    await Promise.all(records.map(async (record) => {
      record.controller?.abort?.(reason);
      if (record.threadId) {
        await this.runtimeAdapter?.cancelTurn?.({
          threadId: record.threadId,
          turnId: record.turnId,
          workspaceRoot: record.workspaceRoot,
        });
        sessionStore?.clearApprovalPrompt?.(record.threadId);
        this.threadStateStore?.resolveApproval?.(record.threadId, "failed");
        this.turnGateStore?.releaseThread?.(record.threadId);
      } else {
        while (this.activeTurnRecords.has(record.id)) await sleep(10);
        return;
      }
      this.pendingOperationByRunKey?.delete?.(buildRunKey(record.threadId, record.turnId));
      this.activeTurnRecords.delete(record.id);
    }));
    return this.getBridgeControlStatus();
  }

  enterNonInterruptibleBoundary() {
    this.nonInterruptibleBoundaryCount = Math.max(0, Number(this.nonInterruptibleBoundaryCount) || 0) + 1;
    return () => this.leaveNonInterruptibleBoundary();
  }

  leaveNonInterruptibleBoundary() {
    this.nonInterruptibleBoundaryCount = Math.max(0, (Number(this.nonInterruptibleBoundaryCount) || 0) - 1);
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        messages: remainingMessages,
        timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
    });
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      turnCorrelation: prepared.turnCorrelation,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      receivedAt: prepared.receivedAt,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const pendingDispatch = this.mergePendingInboundDraft(draft);
      if (!pendingDispatch?.prepared) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          turnCorrelation: pendingDispatch.prepared.turnCorrelation,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          receivedAt: pendingDispatch.prepared.receivedAt,
        },
      });
      if (!dispatched) {
        this.pendingInboundByScope.set(scopeKey, draft);
        continue;
      }
      if (pendingDispatch.remainingMessages.length) {
        this.pendingInboundByScope.set(scopeKey, {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: pendingDispatch.remainingMessages,
        });
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    if (queued.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
      return {
        prepared: buildMergedInboundPrepared({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: batchMessages,
        }),
        remainingMessages,
      };
    }

    if (queued.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        },
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    const blocks = queued
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);

    return {
      prepared: {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        text: [
          "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
          "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
          "",
          blocks.join("\n\n"),
        ].join("\n").trim(),
      },
      remainingMessages: [],
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages({ skipCheckin = false } = {}) {
    if (this.proactiveProviderCooldownUntil > Date.now()) {
      return;
    }
    const pendingMessages = coalesceSystemMessages(this.systemMessageDispatcher?.drainPending() || [])
      .filter((message) => {
        if (!isStaleTimeSensitiveSystemMessage(message)) return true;
        this.logSystemMessageEvent?.("expired", message);
        return false;
      })
      .sort(compareProactiveMessages);
    for (const message of pendingMessages) {
      if (skipCheckin && isCheckinSystemMessage(message)) {
        this.systemMessageDispatcher.requeue(message);
        continue;
      }
      if (typeof this.canDispatchProactiveMessage === "function"
        && !this.canDispatchProactiveMessage(message)) {
        this.deferProactiveForBurst?.(message);
        continue;
      }
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        } else {
          this.recordProactiveDispatch?.(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          createdAt: new Date().toISOString(),
          dueAt: new Date(reminder.dueAtMs).toISOString(),
          taskType: "reminder",
          sendTrigger: "reminder_poller",
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const enriched = this.zhijiantimeDailySupervisor
      ? await this.zhijiantimeDailySupervisor.enrichSystemMessage(message)
      : { message, skip: false };
    if (enriched.skip) {
      this.logSystemMessageEvent?.("skipped", enriched.message || message);
      return true;
    }
    message = enriched.message;
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    this.logSystemMessageEvent?.("dispatching", message);
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const activeProfile = resolveGlobalActiveProfile(this, { sessionStore, bindingKey, workspaceRoot });
    const effectiveModel = activeProfile.modelId;
    const storedModelProvider = activeProfile.providerId;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const activeProfile = resolveGlobalActiveProfile(this, { sessionStore, bindingKey, workspaceRoot });
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: activeProfile.modelId,
        modelProvider: activeProfile.providerId,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: resolveGlobalActiveProfile(this, { sessionStore, bindingKey, workspaceRoot }).modelId,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const activeProfile = resolveGlobalActiveProfile(this, { sessionStore, bindingKey, workspaceRoot });
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      model: activeProfile.modelId,
      modelProvider: activeProfile.providerId,
    });
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && isApprovalAcceptResponse(approvalResponse)) {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const query = normalizeCommandArgument(command.args);
    const profile = this.activeProfile || this.profileStore?.getActive?.() || null;
    const runtime = this.runtimeAdapter?.describe?.() || {};
    const lines = [
      "Model selection is global and this command is read-only.",
      `Profile: ${profile?.name || profile?.id || runtime.profileId || "(none)"}`,
      `Runtime: ${profile?.runtimeId || runtime.id || "(none)"}`,
      `Provider: ${profile?.providerId || runtime.provider || runtime.modelProvider || "(none)"}`,
      `Model: ${profile?.modelId || runtime.model || "(none)"}`,
      "Open Control Center → Models and APIs to verify and activate a different profile.",
    ];
    if (query) lines.push(`Requested value was not applied: ${query}`);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  logRuntimeDiagnostic(event, data = {}) {
    try {
      this.logger?.info?.(event, data);
    } catch {
      // Diagnostics must never affect runtime behavior.
    }
  }

  async handleRuntimeEvent(event) {
    if (event?.type === "runtime.turn.started" && event.payload?.threadId) {
      const earlySystemRecord = [...this.activeTurnRecords.values()].find((record) => (
        record.systemMessage?.id
        && !record.threadId
        && normalizeWorkspaceRoot(record.workspaceRoot) === normalizeWorkspaceRoot(event.payload.workspaceRoot)
      ));
      if (earlySystemRecord) {
        earlySystemRecord.threadId = normalizeText(event.payload.threadId);
        earlySystemRecord.turnId = normalizeText(event.payload.turnId);
        this.systemMessageByRunKey.set(
          buildRunKey(event.payload.threadId, event.payload.turnId),
          {
            ...earlySystemRecord.systemMessage,
            __bindingKey: earlySystemRecord.bindingKey,
            __workspaceRoot: earlySystemRecord.workspaceRoot,
          },
        );
      }
    }
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      for (const [recordId, record] of this.activeTurnRecords.entries()) {
        if (record.threadId === normalizeText(event.payload.threadId)
          && (!normalizeText(event.payload.turnId) || !record.turnId || record.turnId === normalizeText(event.payload.turnId))) {
          this.activeTurnRecords.delete(recordId);
        }
      }
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const systemMessage = this.systemMessageByRunKey?.get?.(completedRunKey) || null;
      this.systemMessageByRunKey?.delete?.(completedRunKey);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const completionBindingKey = normalizeText(systemMessage?.__bindingKey) || linked?.bindingKey;
      const completionWorkspaceRoot = normalizeText(systemMessage?.__workspaceRoot) || linked?.workspaceRoot;
      const scopeKey = completionBindingKey && completionWorkspaceRoot
        ? buildScopeKey(completionBindingKey, completionWorkspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        if (systemMessage && event.type === "runtime.turn.failed") {
          this.scheduleSystemMessageRetry(systemMessage, event.payload);
        } else if (systemMessage && event.type === "runtime.turn.completed") {
          this.recordProactiveProviderSuccess();
          this.logSystemMessageEvent?.("delivered", systemMessage);
        }
        if (completionBindingKey && completionWorkspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: completionBindingKey,
            workspaceRoot: completionWorkspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = completionBindingKey && completionWorkspaceRoot
          ? (
            this.turnGateStore.isPending(completionBindingKey, completionWorkspaceRoot)
            || this.hasPendingInboundMessage(completionBindingKey, completionWorkspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    if (normalizeText(this.runtimeAdapter?.describe?.().id).toLowerCase() === "codebuddy"
      && !isDeveloperCapabilitySession(this)) {
      await this.runtimeAdapter.respondApproval({
        requestId: event.payload.requestId,
        decision: "decline",
        result: { action: "cancel", remember: false },
      }).catch(() => {});
      this.runtimeAdapter.getSessionStore().clearApprovalPrompt(event.payload.threadId);
      this.threadStateStore.resolveApproval(event.payload.threadId, "running");
      console.warn(`[cyberboss] denied CodeBuddy capability request thread=${event.payload.threadId}`);
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      if (!isDeveloperCapabilitySession(this)) {
        const denial = buildApprovalResponsePayload(event.payload, "no") || {
          requestId: event.payload.requestId,
          decision: "decline",
        };
        await this.runtimeAdapter.respondApproval(denial).catch(() => {});
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        this.threadStateStore.resolveApproval(event.payload.threadId, "running");
        console.warn(`[cyberboss] denied supervisor capability request thread=${event.payload.threadId}`);
        return;
      }
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  scheduleSystemMessageRetry(message, error = null) {
    if (!message?.id || !this.systemMessageQueue) return null;
    const attempt = Math.max(0, Number(message.attempt) || 0) + 1;
    this.proactiveProviderFailures += 1;
    const baseDelay = PROACTIVE_RETRY_DELAYS_MS[Math.min(attempt - 1, PROACTIVE_RETRY_DELAYS_MS.length - 1)];
    const nowMs = Date.now();
    if (this.proactiveProviderFailures >= PROACTIVE_CIRCUIT_FAILURE_THRESHOLD) {
      this.proactiveProviderCooldownUntil = Math.max(
        this.proactiveProviderCooldownUntil,
        nowMs + PROACTIVE_CIRCUIT_COOLDOWN_MS,
      );
    }
    const nextAttemptMs = Math.max(nowMs + baseDelay, this.proactiveProviderCooldownUntil);
    const queued = this.systemMessageQueue.enqueue({
      ...message,
      attempt,
      nextAttemptAt: new Date(nextAttemptMs).toISOString(),
      lastErrorCode: normalizeText(error?.code) || "PROVIDER_UNAVAILABLE",
    });
    console.warn(`[cyberboss] proactive task deferred id=${queued.id} attempt=${attempt} code=${queued.lastErrorCode}`);
    return queued;
  }

  recordProactiveProviderSuccess() {
    this.proactiveProviderFailures = 0;
    this.proactiveProviderCooldownUntil = 0;
  }

  beginProactiveBurst(bindingKey, workspaceRoot) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) return;
    this.proactiveBurstByScope.set(scopeKey, {
      startedAt: Date.now(),
      sentCount: 0,
      maxMessages: PROACTIVE_MAX_MESSAGES_AFTER_USER_TURN,
      causedByUserTurn: true,
    });
  }

  resolveSystemMessageScopeKey(message) {
    const accountId = normalizeText(message?.accountId);
    const senderId = normalizeText(message?.senderId);
    const workspaceRoot = normalizeText(message?.workspaceRoot);
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    const bindingKey = sessionStore?.buildBindingKey?.({
      workspaceId: this.config?.workspaceId,
      accountId,
      senderId,
    }) || `${accountId}:${senderId}`;
    return buildScopeKey(bindingKey, workspaceRoot) || `${accountId}:${senderId}:${workspaceRoot}`;
  }

  getProactiveBurst(message) {
    if (!(this.proactiveBurstByScope instanceof Map)) return null;
    const scopeKey = this.resolveSystemMessageScopeKey(message);
    if (!scopeKey) return null;
    const current = this.proactiveBurstByScope.get(scopeKey);
    if (current && Date.now() - current.startedAt < PROACTIVE_BURST_WINDOW_MS) {
      return current;
    }
    const next = {
      startedAt: Date.now(),
      sentCount: 0,
      maxMessages: PROACTIVE_MAX_MESSAGES_WITHOUT_USER_TURN,
      causedByUserTurn: false,
    };
    this.proactiveBurstByScope.set(scopeKey, next);
    return next;
  }

  canDispatchProactiveMessage(message) {
    const burst = this.getProactiveBurst(message);
    return !burst || burst.sentCount < burst.maxMessages;
  }

  recordProactiveDispatch(message) {
    const burst = this.getProactiveBurst(message);
    if (burst) burst.sentCount += 1;
  }

  deferProactiveForBurst(message) {
    const nextAttemptAt = new Date(Date.now() + PROACTIVE_BURST_WINDOW_MS).toISOString();
    this.systemMessageDispatcher?.requeue?.({
      ...message,
      nextAttemptAt,
      lastErrorCode: "BURST_PROTECTION",
    });
  }

  resolveLegacySupervisionKey(message) {
    const id = normalizeText(message?.id);
    if (!id.startsWith("supervision:")) return "";
    const checkpointId = id.slice("supervision:".length);
    const checkpoint = this.supervisionPlanStore.list().find((item) => item.id === checkpointId);
    return checkpoint ? resolveSupervisionKey(checkpoint) : "";
  }

  logSystemMessageEvent(eventName, message) {
    const data = [
      `event=${eventName}`,
      `id=${normalizeText(message?.id)}`,
      `taskType=${normalizeText(message?.taskType) || "system"}`,
      `source=${normalizeText(message?.source) || "unknown"}`,
      `supervisionKey=${normalizeText(message?.supervisionKey) || ""}`,
      `createdAt=${normalizeText(message?.createdAt)}`,
      `dueAt=${normalizeText(message?.dueAt)}`,
      `nextAttemptAt=${normalizeText(message?.nextAttemptAt)}`,
      `sendTrigger=${normalizeText(message?.sendTrigger) || "unknown"}`,
    ];
    console.log(`[cyberboss] system message ${data.join(" ")}`);
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: "weixin",
    };
  }
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function summarizeRuntimeDiagnosticError(error) {
  const diagnostic = error?.diagnostic && typeof error.diagnostic === "object" ? error.diagnostic : {};
  const errorClass = normalizeText(error?.name) || "Error";
  const code = diagnostic.upstreamCode ?? (normalizeText(error?.code) || null);
  const detail = normalizeText(diagnostic.upstreamMessage);
  return {
    class: errorClass,
    ...(code == null || code === "" ? {} : { code }),
    ...(detail ? { detail: sanitizeRuntimeDiagnosticText(detail) } : {}),
  };
}

function sanitizeRuntimeDiagnosticText(value) {
  return normalizeText(value)
    .slice(0, 300)
    .replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePollCursor(value) {
  return fingerprint(value);
}

module.exports = { CyberbossApp };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function isDeveloperCapabilitySession(app) {
  const runtimeId = normalizeText(app?.runtimeAdapter?.describe?.().id).toLowerCase();
  if (normalizeText(app?.config?.weixinCapabilityMode).toLowerCase() === "developer") return true;
  return runtimeId === "codebuddy"
    && normalizeText(app?.config?.codebuddyCapabilityMode).toLowerCase() === "developer";
}

function isCheckinSystemMessage(message) {
  return typeof message?.id === "string"
    && (message.id.startsWith("checkin:") || message.id.startsWith("supervision:random:"));
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (normalized[0] === "mcp_tool" && normalized[1] === "cyberboss_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.responseTemplate?.responseByCommand
    && typeof approval.responseTemplate.responseByCommand === "object") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const effectiveCommandName = commandName === "always" ? "yes" : commandName;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? (responseByCommand[commandName] || responseByCommand[effectiveCommandName])
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "always" && isApprovalAcceptResponse(approvalResponse)) {
      return "💡 Auto-approve enabled for this MCP tool in the current workspace.";
    }
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function isApprovalAcceptResponse(approvalResponse) {
  if (!approvalResponse || typeof approvalResponse !== "object") {
    return false;
  }
  if (approvalResponse.decision === "accept") {
    return true;
  }
  return normalizeText(approvalResponse.result?.action) === "accept";
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always auto-allow");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function buildSystemRuntimeBindingKey(bindingKey) {
  const normalized = normalizeText(bindingKey);
  return normalized ? `${normalized}::system` : normalized;
}

function compareProactiveMessages(left, right) {
  const leftPriority = Number.isSafeInteger(Number(left?.priority))
    ? Number(left.priority)
    : sourcePriority(normalizeText(left?.source));
  const rightPriority = Number.isSafeInteger(Number(right?.priority))
    ? Number(right.priority)
    : sourcePriority(normalizeText(right?.source));
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }
  const leftTime = Date.parse(left?.dueAt || left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.dueAt || right?.createdAt || "") || 0;
  return leftTime - rightTime || String(left?.id || "").localeCompare(String(right?.id || ""));
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDeferredSystemReplyText(text) {
  return unwrapLegacyDeferredText(text);
}

function formatDeferredSystemReplyBatch(replies) {
  return (Array.isArray(replies) ? replies : [])
    .map((reply) => unwrapLegacyDeferredText(reply?.text))
    .filter(Boolean)
    .join("\n\n");
}

function unwrapLegacyDeferredText(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const headers = new Set([
    "===== 上轮对话遗留内容 =====",
    "===== 期间模型主动联系 =====",
    "===== 本轮模型回复 =====",
  ]);
  return lines
    .filter((line) => !line.startsWith("由于微信 context_token 的限制") && !headers.has(line.trim()))
    .join("\n")
    .trim();
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}

function withUsageProfile(event, profileId) {
  if (event?.type !== "runtime.turn.completed" || !event.payload?.usage || !normalizeText(profileId)) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      profileId: normalizeText(profileId),
    },
  };
}

function resolveGlobalActiveProfile(app, { sessionStore = null, bindingKey = "", workspaceRoot = "" } = {}) {
  if (app?.profileStore && typeof app.profileStore.getActive === "function") {
    const active = app.profileStore.getActive();
    const startupProfile = app.activeProfile;
    const changedSinceStartup = startupProfile && (
      active?.id !== startupProfile.id
      || active?.runtimeId !== startupProfile.runtimeId
      || active?.modelId !== startupProfile.modelId
      || active?.secretGeneration !== startupProfile.secretGeneration
    );
    if (!active || active.status !== "verified" || changedSinceStartup) {
      throw Object.assign(new Error("The global active model profile is unavailable. Open Control Center to verify and activate one. [NO_ACTIVE_ENGINE]"), {
        code: "NO_ACTIVE_ENGINE",
      });
    }
    return active;
  }

  // Prototype-level unit fixtures created before global profiles existed do not
  // construct a ProviderProfileStore. Production CyberbossApp instances always do.
  const runtime = app?.runtimeAdapter?.describe?.() || {};
  const legacyParams = sessionStore?.getRuntimeParamsForWorkspace?.(bindingKey, workspaceRoot) || {};
  return {
    id: normalizeText(app?.activeProfile?.id || runtime.profileId) || "test-runtime-profile",
    name: normalizeText(app?.activeProfile?.name),
    status: "verified",
    runtimeId: normalizeText(app?.activeProfile?.runtimeId || runtime.id) || "runtime",
    providerId: normalizeText(app?.activeProfile?.providerId || runtime.provider || runtime.modelProvider || legacyParams.modelProvider),
    modelId: normalizeText(app?.activeProfile?.modelId || runtime.model || legacyParams.model),
  };
}
