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
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveCheckinPreset, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { DesktopStateStore } = require("./desktop-state-store");
const { createChannelHealth } = require("./channel-health");
const { WechatActivityStore } = require("./wechat-activity-store");
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
const { ProactiveDeliveryLog } = require("./proactive-delivery-log");
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
// Wall-clock slack for the "credential on disk is newer than this process" check.
// Both timestamps come from the same machine, but the login runner writes the
// account file moments before the supervisor respawns the bridge, so a small
// tolerance keeps a legitimate restart from being misread as a superseded login.
const WECHAT_CREDENTIAL_RACE_TOLERANCE_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONSECUTIVE_TIMEOUTS = 5;
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
    this.logger = dependencies.logger || new ComponentLogger({
      logDir: path.join(config.stateDir, "logs"),
      component: "bridge",
    });
    this.credentialVault = dependencies.vault || new CredentialVault({ filePath: config.credentialVaultFile, logger: this.logger });
    this.diagnosticCapture = dependencies.capture || new DiagnosticCapture({ filePath: config.diagnosticCaptureFile });
    this.runtimeAdapterFactory = dependencies.runtimeAdapterFactory || createRuntimeAdapter;
    this.runtimeAdapter = null;
    this.activeProfile = null;
    this.visionFallback = null;
    this.startedAtMs = Date.now();
    this.threadStateStore = new ThreadStateStore();
    this.supervisionPlanStore = new SupervisionPlanStore({ stateDir: config.stateDir });
    this.systemMessageQueue = new SystemMessageQueueStore({
      filePath: config.systemMessageQueueFile,
      resolveSupervisionKey: (message) => this.resolveLegacySupervisionKey(message),
    });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.proactiveDeliveryLog = config.proactiveDeliveryLogFile
      ? new ProactiveDeliveryLog({ filePath: config.proactiveDeliveryLogFile })
      : null;
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.desktopStateStore = new DesktopStateStore({ stateDir: config.stateDir });
    this.zhijiantimeClient = new ZhijiantimeClient({
      rootDir: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", ".."),
      mcpServersFile: config.codexMcpServersFile,
      logger: this.logger,
    });
    this.zhijiantimeDailySupervisor = new ZhijiantimeDailySupervisor({
      stateDir: config.stateDir,
      client: this.zhijiantimeClient,
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
    this.channelHealth = dependencies.channelHealth || createChannelHealth({ maxConsecutiveTimeouts: MAX_CONSECUTIVE_TIMEOUTS });
    this.wechatActivityStore = dependencies.wechatActivityStore || (config.stateDir ? new WechatActivityStore({ stateDir: config.stateDir }) : null);
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
      onSystemReplyDelivered: (payload) => this.recordProactiveDelivery(payload),
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

  /**
   * Re-login survival. A WeChat re-scan mints a new accountId, which changes the
   * bindingKey and orphans every threadId the old account had accumulated. The
   * transcripts live in the runtime's store keyed by threadId, so nothing is gone
   * — the new binding just has to be pointed back at them. Runs once per bridge
   * process, after the account is resolved and before subscriptions are restored.
   *
   * Since the identity-key change the binding key is derived from the stable
   * openid, so after the one-time migration this walk becomes a no-op (every
   * prior binding for the same sender already shares the identity key); it is
   * kept as a self-healing convergence for stores that predate the migration.
   */
  inheritPriorAccountThreadBindings(account) {
    try {
      const sessionStore = this.runtimeAdapter.getSessionStore();
      const migrated = sessionStore.inheritThreadBindingsFromPriorAccounts?.({
        accountId: account?.accountId,
        senderId: account?.userId,
      });
      if (Array.isArray(migrated) && migrated.length) {
        console.log(
          `[cyberboss] inherited ${migrated.length} thread binding(s) from earlier WeChat account(s) into ${account.accountId}: ${migrated.join(", ")}`,
        );
      }
      return migrated || [];
    } catch (error) {
      // Inheritance is an optimization over "start a fresh thread", never a
      // precondition for polling. A failure must not take the bridge down.
      console.error(`[cyberboss] thread binding inheritance skipped: ${formatErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * Distinguishes "my token was revoked by a newer login" from "my token expired".
   *
   * The scan flow saves the new credential to `accounts/` and the platform revokes
   * the session this process still holds seconds later. When the credential on
   * disk is newer than this process, the right move is to exit with a *retryable*
   * code so the supervisor respawns the bridge and it adopts the fresh token —
   * not to demand another scan, which would revoke the fresh credential again and
   * lock the user into the scan → revoke → "please scan again" loop.
   */
  hasWeChatCredentialNewerThanProcess() {
    const accountsDir = this.config?.accountsDir;
    const startedAtMs = Number(this.startedAtMs) || 0;
    if (!accountsDir || !startedAtMs) {
      return false;
    }
    try {
      const entries = fs.readdirSync(accountsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json") || entry.name.endsWith(".context-tokens.json")) continue;
        const stats = fs.statSync(path.join(accountsDir, entry.name));
        if (stats.mtimeMs > startedAtMs - WECHAT_CREDENTIAL_RACE_TOLERANCE_MS) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * The workspace root is the runtime's working directory and, with the
   * identity-key change, a stable memory coordinate. The default now points at
   * a per-user directory under the state dir instead of process.cwd() (the
   * packaged install path), which previously split the transcript store across
   * one directory per install location. Create it on use so a fresh install or
   * a migrated environment has a valid working directory before the runtime
   * session is opened.
   */
  ensureWorkspaceRootAvailable() {
    const workspaceRoot = this.config?.workspaceRoot;
    if (!workspaceRoot) {
      return;
    }
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
    } catch (error) {
      // Best effort: the runtime will surface a clearer error if the directory
      // is truly unusable; never block the bridge bootstrap on this.
      console.error(`[cyberboss] could not create workspaceRoot ${workspaceRoot}: ${formatErrorMessage(error)}`);
    }
  }

  async start() {
    await this.ensureRuntimeAdapter();
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.activeIdentityKey = identityKeyFromAccount(account);
    this.ensureWorkspaceRootAvailable();
    this.inheritPriorAccountThreadBindings({
      accountId: this.activeIdentityKey,
      userId: account.userId,
    });
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
      await this.releaseRuntimeResources();
    });

    try {
      let consecutiveFailures = 0;
      let pollSequence = 0;
      let activePollCount = 0;
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
          activePollCount += 1;
          this.logRuntimeDiagnostic?.("poll.started", {
            pollSequenceId,
            startedAt: pollStartedAt,
            startedMonotonicMs: pollStartedMonotonicMs,
            cursorBefore: safePollCursor(pollCursorBefore),
            endpointHost: safeEndpointHost(account.baseUrl),
            activePollCount,
          });
          let response;
          try {
            response = await this.channelAdapter.getUpdates({
              syncBuffer: pollCursorBefore,
              timeoutMs: this.resolveLongPollTimeoutMs(),
            });
          } finally {
            activePollCount = Math.max(0, activePollCount - 1);
          }
          pollMeta = this.channelAdapter.consumeLastPollMeta?.() || {};
          assertWeixinUpdateResponse(response);

          // Decide the liveness outcome from BOTH available signals: the explicit
          // `timedOut` marker on the response object and the consumed poll meta.
          // Either may be the only available one, so treat a timeout as soon as
          // either reports it. A timeout is NOT a successful round trip.
          const observationTimedOut = Boolean(response && response.timedOut === true)
            || Boolean(pollMeta && pollMeta.outcome === "timeout");
          const outcome = observationTimedOut ? "timeout" : "success";
          const pollLatencyMs = pollStartedMonotonicMs
            ? Math.max(0, Math.round(monotonicNowMs() - Number(pollStartedMonotonicMs)))
            : null;

          const healthBefore = this.channelHealth.snapshot().state;
          this.channelHealth.observe({ outcome, latencyMs: pollLatencyMs });
          const healthAfter = this.channelHealth.snapshot();
          this.wechatActivityStore?.record({
            snapshot: healthAfter,
            outcome,
            latencyMs: pollLatencyMs,
            error: null,
          });
          if (healthBefore !== "degraded" && healthAfter.state === "degraded") {
            this.logRuntimeDiagnostic?.("poll.degraded", {
              reason: healthAfter.reason,
              consecutiveTimeouts: healthAfter.consecutiveTimeouts,
              consecutiveFailures: healthAfter.consecutiveFailures,
              degradedSince: healthAfter.degradedSince,
            });
          } else if (healthBefore === "degraded" && healthAfter.state === "healthy") {
            this.logRuntimeDiagnostic?.("poll.recovered", { reason: healthAfter.reason });
          }

          // A real round trip (including a zero-message idle success) resets the
          // failure counter for the existing retry/backoff contract. A timeout
          // must NOT reset it — that was the original silent-failure bug.
          if (outcome === "success") {
            consecutiveFailures = 0;
          }

          // A wedged channel that only ever times out (and therefore never backs
          // off via the error path) must not hot-loop the CPU at the short 2s
          // poll timeout. Back off once health is degraded.
          if (healthAfter.state === "degraded") {
            await sleep(BACKOFF_DELAY_MS);
          }

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
              endpointHost: account.baseUrl,
              activePollCount,
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
          consecutiveFailures += 1;
          const retryDelayMs = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
          if (pollStartedAt) {
            this.logRuntimeDiagnostic?.("poll.error", buildPollError({
              pollSequenceId,
              startedAt: pollStartedAt,
              startedMonotonicMs: pollStartedMonotonicMs,
              cursorBefore: pollCursorBefore,
              error,
              responseMeta: pollMeta,
              endpointHost: account.baseUrl,
              activePollCount,
              consecutiveFailures,
              retryDelayMs,
            }));
          }

          const healthBefore = this.channelHealth.snapshot().state;
          this.channelHealth.observe({ outcome: "failure", latencyMs: null, error });
          const healthAfter = this.channelHealth.snapshot();
          this.wechatActivityStore?.record({
            snapshot: healthAfter,
            outcome: "failure",
            latencyMs: null,
            error,
          });
          if (healthBefore !== "degraded" && healthAfter.state === "degraded") {
            this.logRuntimeDiagnostic?.("poll.degraded", {
              reason: healthAfter.reason,
              consecutiveTimeouts: healthAfter.consecutiveTimeouts,
              consecutiveFailures: healthAfter.consecutiveFailures,
              degradedSince: healthAfter.degradedSince,
            });
          }

          if (isSessionExpiredError(error)) {
            if (this.hasWeChatCredentialNewerThanProcess()) {
              // A newer login is already on disk and revoked the session this
              // process holds. Retryable: the supervisor restarts the bridge and
              // the fresh token is adopted. This must NOT read as "expired" to the
              // user — demanding another scan would revoke the fresh credential
              // again and lock them into the scan → revoke → scan-again loop.
              throw Object.assign(
                new Error("A newer WeChat login was saved after this bridge started; restarting to adopt it."),
                { code: "WECHAT_SESSION_SUPERSEDED" },
              );
            }
            throw Object.assign(new Error("The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。"), { code: "WECHAT_SESSION_EXPIRED" });
          }

          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(retryDelayMs);
        }
      }
    } finally {
      shutdown.dispose();
      await this.releaseRuntimeResources();
    }
  }

  /**
   * Release everything `run()` acquired.
   *
   * Both exit paths must call exactly this one method: the graceful shutdown signal
   * and the fatal `WECHAT_SESSION_EXPIRED` throw out of the poll loop. When the two
   * lists were separate copies they drifted, and the fatal path lost
   * `bridgeControlServer`. Its listening socket then held the event loop open, so the
   * bridge process survived with nothing polling WeChat. The supervisor only
   * recognises failures through the child `exit` event, so it kept reporting
   * "connected" and the control center showed a healthy channel while every message
   * went unanswered.
   */
  async releaseRuntimeResources() {
    this.clearPendingImageInboundTimers();
    await this.bridgeControlServer?.close?.();
    await this.closeLocationServer();
    await this.zhijiantimeDailySupervisor.close();
    await this.runtimeAdapter.close();
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
      accountId: this.activeIdentityKey || this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeIdentityKey || this.activeAccountId,
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
      accountId: this.activeIdentityKey || normalized.accountId,
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
      accountId: this.activeIdentityKey || normalized.accountId,
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
    normalized = await CyberbossApp.prototype.enrichIncomingMessageWithZhijiantimeFreshRead.call(this, normalized);

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

  async enrichIncomingMessageWithZhijiantimeFreshRead(normalized) {
    const withFreshRead = await CyberbossApp.prototype.applyZhijiantimeFreshRead.call(this, normalized);
    return CyberbossApp.prototype.injectProactiveDeliveryDigest.call(this, withFreshRead);
  }

  async applyZhijiantimeFreshRead(normalized) {
    if (!normalized || normalized.provider === "system" || !normalizeText(normalized.text)) {
      return normalized;
    }
    const result = await this.zhijiantimeDailySupervisor?.readFreshForUserTurn?.(normalized.text);
    if (!result?.required) {
      return normalized;
    }
    this.logRuntimeDiagnostic?.("zhijiantime.fresh_read", {
      turnCorrelation: normalizeText(normalized.turnCorrelation),
      reason: normalizeText(result.reason),
      ok: result.ok === true,
      errorCode: normalizeText(result.error?.code) || null,
      itemCount: Number.isSafeInteger(Number(result.daily?.total)) ? Number(result.daily.total) : null,
      readAt: normalizeText(result.daily?.readAt) || null,
    });
    if (!normalizeText(result.context)) {
      return normalized;
    }
    return {
      ...normalized,
      text: `${normalizeText(normalized.text)}\n\n${result.context}`.trim(),
    };
  }

  /**
   * RC1 mitigation: the proactive turns run in their own `system:<senderId>`
   * scope, so the user-scope transcript never sees what was already sent. Tell
   * the user turn what the assistant already delivered today, otherwise the
   * model greets the user again over content that was already handled.
   *
   * Source is the delivered text recorded by the delivery path, not the queued
   * message, so no internal context block can be echoed back into the session.
   */
  injectProactiveDeliveryDigest(normalized) {
    if (!this.proactiveDeliveryLog || !normalized || normalized.provider === "system" || !normalizeText(normalized.text)) {
      return normalized;
    }
    const digest = this.proactiveDeliveryLog.buildUserTurnDigest({ senderId: normalized.senderId });
    if (!digest?.text) {
      return normalized;
    }
    this.logRuntimeDiagnostic?.("proactive.digest_injected", {
      turnCorrelation: normalizeText(normalized.turnCorrelation),
      entryCount: digest.entryCount,
      charLength: digest.charLength,
    });
    return {
      ...normalized,
      text: `${normalizeText(normalized.text)}\n\n${digest.text}`.trim(),
    };
  }

  /**
   * Called only after the provider accepted a proactive message. Stores the
   * model's final text so a later user turn can be told what the user saw.
   */
  recordProactiveDelivery({ userId = "", text = "", kind = "", threadId = "" } = {}) {
    if (kind !== "system_reply") {
      return null;
    }
    const entry = this.proactiveDeliveryLog?.record({ senderId: userId, text, sourceId: threadId });
    if (entry) {
      this.logRuntimeDiagnostic?.("proactive.delivery_logged", {
        userIdFingerprint: fingerprint(userId),
        charLength: entry.text.length,
        deliveredAt: entry.deliveredAt,
      });
    }
    return entry;
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
      return { ...normalized, text: `${normalized.text}\n\n${buildSupervisionNote({
        source: planningCommitment.checkpoint.source,
        dueAt: planningCommitment.checkpoint.dueAt,
        summary: planningCommitment.announcement,
      })}` };
    }
    const settings = this.desktopStateStore.get();
    const arrangement = extractExplicitCheckpoint(normalized.text, { quietHours: settings.quietHours })
      || inferContextualCheckpoint(normalized.text, {
        durations: settings.contextDurations,
        quietHours: settings.quietHours,
      });
    if (!arrangement) {
      return normalized;
    }
    const checkpoint = this.supervisionPlanStore.add({
      ...arrangement,
      sourceRef,
      announcedAt: new Date().toISOString(),
    });
    this.supervisionPlanStore.supersedeCanonical(checkpoint.canonicalTaskId, checkpoint.id);
    return { ...normalized, text: `${normalized.text}\n\n${buildSupervisionNote({
      source: checkpoint.source,
      dueAt: checkpoint.dueAt,
      summary: arrangement.announcement,
    })}` };
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
      /*
       * Route A root fix: a proactive (system) turn runs in the *same* session
       * as the user's turns. This previously appended `::system` to the binding
       * key, which gave proactive turns their own ACP session — and therefore
       * their own history, so a later user turn had no idea what had already
       * been sent and greeted the user again. `systemTurn` is now carried
       * explicitly so the runtime keeps its non-terminal-timeout protection
       * without relying on the binding-key suffix.
       */
      const runtimeBindingKey = bindingKey;
      const systemTurn = prepared.provider === "system";
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
          actionRequestText: prepared.originalText || prepared.text || "",
          visionUsage: runtimeTurn.usageAttributions,
          systemTurn,
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
      if (systemTurn && prepared.systemMessage?.id) {
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
      accountId: this.activeIdentityKey || prepared.accountId,
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
        text: `⚠️ 图片或附件没接收到\n${persisted.failed.map((item) => item.reason).join("\n")}`,
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
        text: `⚠️ 图片或附件没接收到\n${persisted.failed.map((item) => item.reason).join("\n")}`,
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
          text: `❌ 时间轴截图失败\n${messageText}`,
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
      accountId: this.activeIdentityKey || reminder.accountId,
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
      accountId: this.activeIdentityKey || prepared.accountId,
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
        await this.handleHelpCommand(normalized, command);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: [
            "这条命令我还不认识。",
            "想让我提醒你的话，直接说一句就行，比如：",
            "  “一小时后问我简历写了没”",
            "  “今晚十点提醒我吃药”",
            "",
            "想看我认得的全部命令，发 /help",
          ].join("\n"),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 用法：/bind /绝对路径",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ /bind 只支持绝对路径。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ 这个路径必须位于你的用户目录或当前工作目录之内。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ 目录不存在\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ 已绑定目录\n目录：${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
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
      `📍 目录：${workspaceRoot}`,
      `🧵 会话：${threadId || "（无）"}`,
      `📊 状态：${formatThreadStatus(threadState?.status)}`,
      `🤖 引擎：${runtimeName}`,
      `🤖 模型：${effectiveModel || "（默认）"}`,
      `🤖 供应商：${storedModelProvider || "（默认）"}`,
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
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ 已开一个新会话\n目录：${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 现在还没有会话。先随便跟我说一句话。",
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
        text: `❌ 重新读取失败\n${error instanceof Error ? error.message : String(error || "未知错误")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 现在还没有会话。先随便跟我说一句话。",
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
        text: `🗜️ 已请求压缩会话\n会话：${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ 压缩失败\n${error instanceof Error ? error.message : String(error || "未知错误")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 用法：/switch <会话ID>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
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
      text: `✅ 已切换会话\n目录：${workspaceRoot}\n会话：${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 现在没有正在进行的任务。",
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
      text: `⏹️ 已发出停止请求\n会话：${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
    const formatRange = (range) => `${Math.round(range.minIntervalMs / 60_000)}-${Math.round(range.maxIntervalMs / 60_000)} 分钟`;

    if (!rangeInput) {
      const currentPreset = resolveCheckinPreset(this.checkinConfigStore.getPresetId());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          `⏰ 我现在是「${currentPreset ? currentPreset.label : "自定义"}」：大约每 ${formatRange(currentRange)}来一次。`,
          "",
          "想改的话，发其中一条：",
          "  /checkin 轻陪伴  （大约 30-90 分钟）",
          "  /checkin 标准    （大约 15-45 分钟）",
          "  /checkin 紧密    （大约 5-20 分钟）",
          "  /checkin 15-45   （自定义区间）",
        ].join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const preset = resolveCheckinPreset(rangeInput);
    if (preset) {
      this.checkinConfigStore.setPreset(preset.id);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `✅ 已改成「${preset.label}」：大约每 ${preset.minMinutes}-${preset.maxMinutes} 分钟来一次。${preset.description}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          "这个区间我没看懂。可以写成 15-45 这样的「最小-最大」分钟数，",
          "或者直接选档位：/checkin 轻陪伴、/checkin 标准、/checkin 紧密。",
        ].join("\n"),
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
      text: `✅ 已改成大约每 ${parsedRange.minMinutes}-${parsedRange.maxMinutes} 分钟来一次，从下一个调度周期开始生效。`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 当前短消息合并长度是 ${current} 个字符。用法：/chunk <数字>（例如 /chunk 50）`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ 这个数值不对，请填 1 到 ${MAX_MIN_WEIXIN_CHUNK} 之间的整数。`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ 短消息合并长度已设为 ${updated} 个字符。比这更短的碎片会合并成一条消息。`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: this.activeIdentityKey || normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 现在没有等你确认的操作。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ 这个 Codex MCP 请求暂时不能在微信里确认，请到桌面控制中心处理。",
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
      "🤖 模型是全局配置，这里只能看，不能改。",
      `配置：${profile?.name || profile?.id || runtime.profileId || "（无）"}`,
      `引擎：${profile?.runtimeId || runtime.id || "（无）"}`,
      `供应商：${profile?.providerId || runtime.provider || runtime.modelProvider || "（无）"}`,
      `模型：${profile?.modelId || runtime.model || "（无）"}`,
      "要验证或切换配置，请在桌面控制中心 → AI 引擎 里操作。",
    ];
    if (query) lines.push(`（你写的「${query}」这次没有生效）`);
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
        "⭐️ 觉得这个项目还不错？在 GitHub 上给我点个星吧！",
        "这点鼓励对一个人做独立项目的人来说，真的很重要 💖",
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

  async handleHelpCommand(normalized, command) {
    const wantsAll = /^(all|全部|进阶)$/i.test(normalizeCommandArgument(command?.args));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText({ includeDeveloper: wantsAll }),
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
            text: `✅ 压缩完成\n会话：${event.payload.threadId}`,
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

/**
 * Builds the supervision note appended to a user turn.
 *
 * The note deliberately states *facts* (what was recorded, for when) and lets
 * the model phrase the acknowledgement. Earlier revisions embedded a verbatim
 * line and ordered the model to say it ("naturally tell the user: “…”"), which
 * turned a parser mistake into the assistant appearing to invent a promise the
 * user had explicitly denied. Keeping the wording model-owned makes a bad
 * parse far less costly and never forces the assistant to assert something the
 * user may already be objecting to.
 */
function buildSupervisionNote({ source = "", dueAt = "", summary = "" } = {}) {
  return [
    "[CyberBoss supervision note]",
    `A ${normalizeText(source) || "conversation"} follow-up was recorded, due ${normalizeText(dueAt) || "at an unspecified time"}.`,
    normalizeText(summary) ? `Background on why: ${normalizeText(summary)}` : "",
    "Acknowledge this in your own words only if it fits the conversation. Never announce an exact time the user did not ask for, and never claim you changed or cancelled a follow-up unless you actually did.",
    "Do not mention this note or expose internal scheduling fields.",
  ].filter(Boolean).join("\n");
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

function safeEndpointHost(value) {
  const text = normalizeText(value);
  if (!text) return "";
  try { return new URL(text).hostname; } catch { return "invalid"; }
}

module.exports = { CyberbossApp, identityKeyFromAccount };

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
  out.push(`🔐 【需要你确认】${toolName || "工具调用"}`);

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
    out.push("❓ （未提供说明）");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 回复其中一个就行：");
  out.push("👉 /yes    这次允许");
  out.push("👉 /always 以后同类都允许");
  out.push("👉 /no     拒绝");

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
      return "💡 已在这个工作目录里对这个 MCP 工具开启自动允许。";
    }
    if (commandName === "yes") {
      return "✅ 这次请求已允许。";
    }
    return "❌ 这次请求已取消。";
  }
  return commandName === "always"
    ? "💡 已在这个工作目录里对这条命令前缀开启自动允许。"
    : (commandName === "yes" ? "✅ 这次请求已允许。" : "❌ 这次请求已拒绝。");
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
  out.push(`🔐 【需要你确认】${normalizeText(approval?.reason) || "MCP 请求"}`);
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
  out.push("💬 回复其中一个就行：");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    这次允许");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always 以后同类都允许");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     取消这次请求");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ 这个 Codex MCP 请求暂时不能在微信里确认，请到桌面控制中心处理。");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

// Thread status values are internal English tokens; users read these lines in
// WeChat, so translate them on the way out.
function formatThreadStatus(status) {
  switch (normalizeText(status)) {
    case "idle": return "空闲";
    case "running": return "进行中";
    case "waiting_approval": return "等待你确认";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "": return "空闲";
    default: return normalizeText(status);
  }
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
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

/**
 * The stable Aidy identity is derived from the WeChat openid (`account.userId`),
 * which survives re-scans. The bot instance id (`account.accountId`) changes on
 * every scan and must never serve as an identity key. Legacy account files
 * without a userId fall back to the bot id with a warning so the bridge keeps
 * running; the one-time migration backfills the openid.
 */
function identityKeyFromAccount(account) {
  const userId = normalizeText(account?.userId);
  if (userId) {
    return userId;
  }
  const accountId = normalizeText(account?.accountId);
  if (accountId) {
    console.warn(
      `[cyberboss] account ${accountId} has no WeChat userId; falling back to the bot id as the identity key. Re-scan to backfill a stable identity.`,
    );
  }
  return accountId;
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
