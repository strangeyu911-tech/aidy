const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const {
  isWithinQuietHours,
  resolveDueCheckpointAction,
  resolveSupervisionKey,
  sourcePriority,
} = require("../core/supervision-policy");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

class SupervisionDispatcher {
  constructor({ config, desktopStateStore, planStore, logger, intervalMs = 1_000 } = {}) {
    this.config = config;
    this.desktopStateStore = desktopStateStore;
    this.planStore = planStore;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.dispatching = false;
    this.queue = new SystemMessageQueueStore({
      filePath: config.systemMessageQueueFile,
      resolveSupervisionKey: (message) => this.resolveLegacySupervisionKey(message),
    });
    this.checkinConfig = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  }

  start() {
    if (this.timer) return;
    this.ensureRandomCheckpoint();
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.logger?.error("supervision.tick_failed", { code: error.code || "TICK_FAILED" });
    }), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()) {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const settings = this.desktopStateStore.get();
      const desiredState = settings.desiredState;
      const quietHours = settings.quietHours;
      for (const checkpoint of this.planStore.due(now)) {
        const decision = resolveDueCheckpointAction({
          desiredState,
          checkpoint,
          now,
          timeZone: checkpoint.timezone,
          quietHours,
        });
        if (decision.action === "hold") continue;
        if (decision.action === "defer") {
          const deferToMs = Date.parse(decision.deferTo || "");
          // Guard against moving a checkpoint to a time that is already due,
          // which would spin the 1s tick forever.
          if (Number.isFinite(deferToMs) && deferToMs > now.getTime()) {
            this.planStore.update(checkpoint.id, { dueAt: new Date(deferToMs).toISOString(), outcome: decision.outcome });
            this.logger?.info("supervision.deferred", { checkpointId: checkpoint.id, deferTo: decision.deferTo });
          } else {
            this.planStore.update(checkpoint.id, { state: "skipped", outcome: "suppressed_quiet_hours" });
          }
          continue;
        }
        if (decision.action === "discard" || decision.action === "archive") {
          this.planStore.update(checkpoint.id, { state: "skipped", outcome: decision.outcome });
          continue;
        }
        if (decision.action === "dispatch") await this.dispatch(checkpoint);
      }
      this.ensureRandomCheckpoint(now);
    } finally {
      this.dispatching = false;
    }
  }

  async dispatch(checkpoint) {
    const target = this.resolveTarget();
    if (!target) {
      this.planStore.update(checkpoint.id, { state: "failed", outcome: "target_unavailable" });
      return;
    }
    if (checkpoint.source === "random" && this.queue.hasPendingForAccount(target.accountId)) {
      this.planStore.update(checkpoint.id, { state: "skipped", outcome: "pending_activity" });
      return;
    }
    this.queue.enqueue({
      id: `supervision:${checkpoint.id}`,
      accountId: target.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: checkpoint.prompt || "The user comes to mind again. Decide whether a useful, non-repetitive check-in is appropriate.",
      createdAt: new Date().toISOString(),
      dueAt: checkpoint.dueAt,
      taskType: "supervision",
      source: checkpoint.source,
      supervisionKey: resolveSupervisionKey(checkpoint),
      priority: sourcePriority(checkpoint.source),
      sendTrigger: "scheduler",
    });
    this.planStore.update(checkpoint.id, { state: "completed", outcome: "queued" });
    this.logger?.info("supervision.dispatched", { source: checkpoint.source, checkpointId: checkpoint.id });
  }

  async enqueueNotice(text) {
    const target = this.resolveTarget();
    if (!target || !String(text || "").trim()) return false;
    this.queue.enqueue({
      id: `integration-notice:${crypto.randomUUID()}`,
      accountId: target.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: `Send the user this concise schedule correction naturally, without adding new claims: ${String(text).trim()}`,
      createdAt: new Date().toISOString(),
      taskType: "integration_notice",
      sendTrigger: "integration_notice",
    });
    return true;
  }

  ensureRandomCheckpoint(now = new Date()) {
    const settings = this.desktopStateStore.get();
    if (!settings.randomCheckinsEnabled || settings.desiredState === "stopped") return null;
    if (settings.desiredState === "quiet" || isWithinQuietHours(now, settings.timezone, settings.quietHours)) return null;
    const existing = this.planStore.list({ state: "pending" }).find((item) => item.source === "random");
    if (existing) return existing;
    const range = this.checkinConfig.getRange(resolveDefaultCheckinRange());
    const delay = pickRandomDelay(range.minIntervalMs, range.maxIntervalMs);
    return this.planStore.add({
      id: `random:${crypto.randomUUID()}`,
      canonicalTaskId: "random:current",
      source: "random",
      dueAt: new Date(now.getTime() + delay).toISOString(),
      prompt: "The user comes to mind again. Review recent context and decide whether a useful, non-repetitive check-in is appropriate.",
    });
  }

  /**
   * Manual "check on me now" trigger. Exists so this core capability can be
   * verified from the desktop instead of waiting for a random window, and so
   * the user can ask for one immediately when they are stuck.
   */
  runCheckinNow(now = new Date()) {
    const settings = this.desktopStateStore.get();
    if (settings.desiredState === "stopped") {
      return { ok: false, error: "艾迪当前是停止状态，先启动再试。" };
    }
    const target = this.resolveTarget();
    if (!target) {
      return { ok: false, error: "还没有可用的微信会话。先在微信里跟艾迪说一句话，再回来试。" };
    }
    this.queue.enqueue({
      id: `manual-checkin:${crypto.randomUUID()}`,
      accountId: target.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: "The user explicitly asked for a check-in right now. Review recent context and send one short, timely, non-repetitive check-in message.",
      createdAt: now.toISOString(),
      taskType: "supervision",
      source: "manual",
      sendTrigger: "manual_checkin",
    });
    this.logger?.info("supervision.manual_checkin_queued", { checkpointId: "manual" });
    return { ok: true };
  }

  resolveTarget() {
    try {
      const account = resolveSelectedAccount(this.config);
      const sessionStore = new SessionStore({ filePath: this.config.sessionsFile });
      const senderId = resolvePreferredSenderId({ config: this.config, accountId: account.accountId, sessionStore });
      const workspaceRoot = resolvePreferredWorkspaceRoot({ config: this.config, accountId: account.accountId, senderId, sessionStore });
      return senderId && workspaceRoot ? { accountId: account.accountId, senderId, workspaceRoot } : null;
    } catch {
      return null;
    }
  }

  resolveLegacySupervisionKey(message) {
    const id = normalizeText(message?.id);
    if (!id.startsWith("supervision:")) return "";
    const checkpointId = id.slice("supervision:".length);
    const checkpoint = this.planStore.list().find((item) => item.id === checkpointId);
    return checkpoint ? resolveSupervisionKey(checkpoint) : "";
  }
}

function pickRandomDelay(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SupervisionDispatcher, pickRandomDelay };
