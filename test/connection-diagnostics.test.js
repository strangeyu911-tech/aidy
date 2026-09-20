"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createConnectionDiagnostic,
  resolveWechatStatus,
} = require("../src/desktop/connection-diagnostics");

const now = () => new Date("2026-09-01T00:00:00.000Z");

const LIVE_CHANNEL = { hasHeartbeat: true, stale: false, lastSuccessMinutes: 1, state: "healthy" };
const NEVER_HEARTBEAT_CHANNEL = { hasHeartbeat: false, stale: false, lastSuccessMinutes: null, state: "unknown" };
const SILENT_CHANNEL = { hasHeartbeat: false, stale: true, lastSuccessMinutes: null, state: "unknown" };
const WENT_QUIET_CHANNEL = { hasHeartbeat: true, stale: true, lastSuccessMinutes: 95, state: "healthy" };

test("healthy bridge and configured account report WeChat connected", () => {
  const result = resolveWechatStatus(
    { phase: "running", error: null },
    { configured: true, state: "ready", accountId: "account-1" },
    LIVE_CHANNEL,
  );
  assert.equal(result.state, "connected");
  assert.equal(result.label, "已连接");
  assert.equal(result.diagnostic, null);
});

test("a running supervisor with no heartbeat never claims WeChat is connected", () => {
  // The supervisor phase only says the process is up. Reporting "已连接" off the
  // phase alone is how Aidy told the user everything was fine while the bridge
  // had never reached WeChat.
  const connecting = resolveWechatStatus(
    { phase: "running", error: null },
    { configured: true, state: "ready" },
    NEVER_HEARTBEAT_CHANNEL,
  );
  assert.equal(connecting.state, "connecting");
  assert.equal(connecting.label, "正在连接");
  assert.equal(connecting.diagnostic, null);
  assert.notEqual(connecting.label, "已连接");

  const silent = resolveWechatStatus(
    { phase: "running", error: null },
    { configured: true, state: "ready" },
    SILENT_CHANNEL,
  );
  assert.equal(silent.state, "degraded");
  assert.equal(silent.label, "连接异常");
  assert.equal(silent.diagnostic.code, "WECHAT_CHANNEL_SILENT");
  assert.equal(silent.diagnostic.nextAction, "wechat_login");
  assert.match(silent.detail, /一直没有成功连上微信/);
});

test("a channel that used to work and then went quiet is reported as degraded with the duration", () => {
  const result = resolveWechatStatus(
    { phase: "running", error: null },
    { configured: true, state: "ready" },
    WENT_QUIET_CHANNEL,
  );
  assert.equal(result.state, "degraded");
  assert.equal(result.label, "连接异常");
  assert.match(result.detail, /1 小时/);
  assert.match(result.detail, /消息可能收不到/);
});

test("a missing channel snapshot is treated as unverified rather than connected", () => {
  const result = resolveWechatStatus({ phase: "running", error: null }, { configured: true, state: "ready" });
  assert.equal(result.state, "connecting");
  assert.notEqual(result.state, "connected");
});

test("the quiet phase is held to the same liveness standard as running", () => {
  const live = resolveWechatStatus({ phase: "quiet", error: null }, { configured: true }, LIVE_CHANNEL);
  assert.equal(live.state, "connected");

  const dead = resolveWechatStatus({ phase: "quiet", error: null }, { configured: true }, SILENT_CHANNEL);
  assert.equal(dead.state, "degraded");
});

test("missing desktop WeChat and desktop WeChat login codes have distinct remediation", () => {
  const notRunning = createConnectionDiagnostic({ code: "WECHAT_CLIENT_NOT_RUNNING", capability: "wechat" }, { now });
  const notLoggedIn = createConnectionDiagnostic({ code: "WECHAT_CLIENT_NOT_LOGGED_IN", capability: "wechat" }, { now });
  assert.match(notRunning.repairAction, /启动电脑版微信/);
  assert.match(notLoggedIn.repairAction, /完成登录/);
  assert.notEqual(notRunning.repairAction, notLoggedIn.repairAction);
});

test("expired WeChat session recommends reconnecting instead of restarting the desktop client", () => {
  const result = createConnectionDiagnostic({ code: "WECHAT_SESSION_EXPIRED", capability: "wechat" }, { now });
  assert.equal(result.nextAction, "wechat_login");
  assert.match(result.repairAction, /重新扫码登录/);
  assert.doesNotMatch(result.repairAction, /启动电脑版微信/);
});

test("packaged runtime loss reaches the WeChat status with an actionable restart remediation", () => {
  const runtimeError = createConnectionDiagnostic({ code: "BRIDGE_RUNTIME_FILES_MISSING", capability: "bridge" }, { now });
  const result = resolveWechatStatus(
    { phase: "error", error: runtimeError },
    { configured: true, state: "ready" },
  );
  assert.equal(result.state, "error");
  assert.equal(result.diagnostic.code, "BRIDGE_RUNTIME_FILES_MISSING");
  assert.equal(result.diagnostic.nextAction, "restart_app");
  assert.match(result.detail, /运行文件不可用/);
});

test("runtime failures do not falsely claim that WeChat itself failed", () => {
  const runtimeError = createConnectionDiagnostic({ code: "APP_SERVER_NOT_READY", capability: "runtime", message: "模型服务未启动" }, { now });
  const result = resolveWechatStatus(
    { phase: "error", error: runtimeError },
    { configured: true, state: "ready" },
  );
  assert.equal(result.state, "blocked");
  assert.equal(result.label, "等待后台服务");
  assert.equal(result.diagnostic, null);
});

test("known diagnostics preserve explicit remediation and unknown diagnostics use the inspection fallback", () => {
  const known = createConnectionDiagnostic({ code: "BRIDGE_NOT_READY", capability: "bridge" }, { now });
  const unknown = createConnectionDiagnostic({ code: "UNCLASSIFIED_SOCKET_FAILURE", capability: "bridge" }, { now });
  assert.equal(known.remediationKnown, true);
  assert.match(known.repairAction, /重试启动/);
  assert.equal(unknown.remediationKnown, false);
  assert.equal(unknown.nextAction, "inspect_logs");
  assert.match(unknown.repairAction, /查看最近日志/);
  assert.equal(unknown.timestamp, "2026-09-01T00:00:00.000Z");
});
