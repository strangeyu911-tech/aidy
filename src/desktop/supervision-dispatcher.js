const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { resolveDueCheckpointAction } = require("../core/supervision-policy");
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
    this.queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
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
      const desiredState = this.desktopStateStore.get().desiredState;
      for (const checkpoint of this.planStore.due(now)) {
        const decision = resolveDueCheckpointAction({ desiredState, checkpoint });
        if (decision.action === "hold") continue;
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
    });
    return true;
  }

  ensureRandomCheckpoint(now = new Date()) {
    const settings = this.desktopStateStore.get();
    if (!settings.randomCheckinsEnabled || settings.desiredState === "stopped") return null;
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
}

function pickRandomDelay(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

module.exports = { SupervisionDispatcher, pickRandomDelay };
