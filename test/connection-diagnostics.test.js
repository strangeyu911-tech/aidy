"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createConnectionDiagnostic,
  resolveWechatStatus,
} = require("../src/desktop/connection-diagnostics");

const now = () => new Date("2026-09-01T00:00:00.000Z");

test("healthy bridge and configured account report WeChat connected", () => {
  const result = resolveWechatStatus(
    { phase: "running", error: null },
    { configured: true, state: "ready", accountId: "account-1" },
  );
  assert.equal(result.state, "connected");
  assert.equal(result.label, "已连接");
  assert.equal(result.diagnostic, null);
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
