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
    // A night the user never answered must not be rewritten as another night of
    // the same cadence. Every random checkpoint is re-created the moment the
    // previous one leaves "pending", so without this the interval is a constant
    // 15-45 min regardless of whether anyone replied -- that is how 2026-09-23
    // produced eight unanswered check-ins between 23:43 and 07:57, and why the
    // 15-45 min "standard" preset was in practice a nonstop knock.
    const backoff = resolveRandomBackoff(this.planStore.list({ includeRandom: true }).filter((item) => item.source === "random"), now);
    const delay = pickRandomDelay(range.minIntervalMs, range.maxIntervalMs) * backoff.multiplier;
    const checkpoint = this.planStore.add({
      id: `random:${crypto.randomUUID()}`,
      canonicalTaskId: "random:current",
      source: "random",
      dueAt: new Date(now.getTime() + delay).toISOString(),
      prompt: "The user comes to mind again. Review recent context and decide whether a useful, non-repetitive check-in is appropriate.",
    });
    if (backoff.multiplier > 1) {
      this.logger?.info("supervision.random_backoff", {
        multiplier: backoff.multiplier,
        unansweredStreak: backoff.streak,
        delayMs: delay,
      });
    }
    return checkpoint;
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

// How many consecutive unanswered random check-ins are required before the
// interval starts stretching, and where it stops. Two is deliberate: a single
// missed window is normal (the user is in a meeting, or the model judged a
// check-in unnecessary), so the first one must not change anything.
const RANDOM_BACKOFF_FREE_STREAK = 2;
const RANDOM_BACKOFF_MAX_MULTIPLIER = 8;

/**
 * Escalating multiplier for the random check-in interval, derived purely from
 * the plan itself so no new state file is needed.
 *
 * "Unanswered" is measured from the checkpoint lifecycle, not from whether a
 * message left the machine: a random checkpoint that reached "completed" was
 * handed to the model, and an all-night run of those produced silent replies.
 * Treating queued-but-ignored as unanswered is exactly the feedback loop we
 * want to break. Checkpoints the dispatcher itself dropped (`skipped`, e.g.
 * quiet hours or newly arrived user activity) say nothing about the user's
 * responsiveness, so they neither extend nor reset the streak.
 *
 * Half-open on purpose: the streak starts at the newest blocker and stops at
 * the first entry that is not a blocker, so old traffic cannot inflate it.
 */
function resolveRandomBackoff(checkpoints, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ordered = (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((item) => item?.source === "random")
    .sort((left, right) => {
      const leftTime = Date.parse(left?.updatedAt || left?.createdAt || "") || 0;
      const rightTime = Date.parse(right?.updatedAt || right?.createdAt || "") || 0;
      return rightTime - leftTime;
    });

  let streak = 0;
  for (const checkpoint of ordered) {
    const blocked = isBlockingOutcome(checkpoint);
    if (!blocked) break;
    streak += 1;
  }

  if (!Number.isFinite(nowMs) || streak <= RANDOM_BACKOFF_FREE_STREAK) {
    return { multiplier: 1, streak, capped: false };
  }
  const steps = streak - RANDOM_BACKOFF_FREE_STREAK;
  const multiplier = Math.min(2 ** steps, RANDOM_BACKOFF_MAX_MULTIPLIER);
  return { multiplier, streak, capped: multiplier >= RANDOM_BACKOFF_MAX_MULTIPLIER };
}

function isBlockingOutcome(checkpoint) {
  const state = normalizeText(checkpoint?.state);
  if (state === "completed") return true;
  if (state !== "failed") return false;
  const outcome = normalizeText(checkpoint?.outcome);
  // target_unavailable means there is nobody to reach at all; that is an
  // infrastructure problem, not the user ignoring check-ins, so it must not be
  // counted as an unanswered knock.
  return outcome !== "target_unavailable";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SupervisionDispatcher, pickRandomDelay, resolveRandomBackoff };
