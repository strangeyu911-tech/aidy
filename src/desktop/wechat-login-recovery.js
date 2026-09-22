"use strict";

/**
 * Bridge the two halves of "connect WeChat" that used to be strangers.
 *
 * Scanning the QR code writes a fresh credential to disk, but the supervisor may
 * be parked in `error` because the bridge already exited with
 * `WECHAT_SESSION_EXPIRED`. That error is deliberately never auto-restarted —
 * restarting cannot repair an expired login, and blindly retrying only burns the
 * circuit breaker and replaces the real reason with a generic "kept exiting"
 * message. The login runner, however, never spoke to the supervisor at all, so
 * after a successful re-scan the new credential was never loaded and never
 * polled: the status card kept reading "连接异常 / 微信连接已过期" while the
 * WeChat side said the scan had succeeded, and the only way out was to quit and
 * relaunch the whole application.
 *
 * This watcher closes that loop. It turns "a scan just completed successfully"
 * into exactly one supervisor retry, so the newly saved token is actually read
 * by a freshly spawned bridge. It fires once per successful login (the runner
 * passes through non-connected states in between, which is what re-arms it), and
 * it never overrides a user who explicitly stopped Aidy.
 */
function createWechatLoginRecovery({ supervisor, logger = null } = {}) {
  let lastStatus = "";

  function isStopped() {
    return supervisor?.desiredState === "stopped";
  }

  async function handleStatus(status) {
    const normalized = typeof status === "string" ? status.trim() : "";
    const previous = lastStatus;
    lastStatus = normalized;

    if (normalized !== "connected" || previous === "connected") {
      return false;
    }

    // A user who turned Aidy off keeps that choice. The stale "session expired"
    // error is still cleared by the retry below, so nothing is left lying around.
    if (isStopped()) {
      logger?.info?.("wechat.login_recovery_skipped", { reason: "desired_state_stopped" });
      return false;
    }

    try {
      await supervisor.retry();
      logger?.info?.("wechat.login_recovery", {
        previousStatus: previous || "(none)",
        phase: supervisor?.phase || "",
      });
      return true;
    } catch (error) {
      logger?.warn?.("wechat.login_recovery_failed", {
        message: error?.message || String(error || ""),
      });
      return false;
    }
  }

  function reset() {
    lastStatus = "";
  }

  return { handleStatus, reset };
}

module.exports = { createWechatLoginRecovery };
