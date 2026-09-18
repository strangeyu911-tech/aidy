"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RuntimeSupervisor } = require("../src/desktop/runtime-supervisor");
const { resolveWechatStatus } = require("../src/desktop/connection-diagnostics");

function createSupervisor() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-session-expiry-"));
  const supervisor = new RuntimeSupervisor({
    rootDir: stateDir,
    stateDir,
    logger: null,
  });
  // In the real scenario the user wants Aidy running, so the bridge exit is not
  // an intentional stop. handleExit short-circuits on desiredState === "stopped".
  supervisor.desiredState = "running";
  supervisor.children.set("bridge", { exitCode: null });
  return { supervisor, stateDir };
}

test("bridge session-expiry output is captured as WECHAT_SESSION_EXPIRED", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(child.__cyberbossError?.capability, "wechat");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bridge session-expiry via numeric errcode -14 is captured as WECHAT_SESSION_EXPIRED", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "weixin getUpdates ret=null errcode=-14 errmsg=session expired", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_SESSION_EXPIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_SESSION_EXPIRED surfaces a wechat_login remediation through resolveWechatStatus", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。", true);
    const runtimeError = child.__cyberbossError;
    const result = resolveWechatStatus(
      { phase: "error", error: runtimeError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
    assert.match(result.detail, /微信连接已过期/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_LOGIN_REQUIRED still matches after the session-expiry branch was added", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "No saved WeChat account was found", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_LOGIN_REQUIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_ACCOUNT_SELECTION_REQUIRED still matches after the session-expiry branch was added", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Multiple WeChat accounts were detected", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_ACCOUNT_SELECTION_REQUIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function driveBridgeExit(supervisor, child, capturedText) {
  supervisor.handleOutput("bridge", "[cyberboss] bridge loop started; waiting for WeChat messages.");
  supervisor.handleOutput("bridge", capturedText, true);
  supervisor.handleExit("bridge", child, 1, null);
}

test("expired WeChat session surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(
      supervisor,
      child,
      "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。",
    );
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("missing WeChat login surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(supervisor, child, "No saved WeChat account was found");
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_LOGIN_REQUIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("multiple WeChat accounts surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(supervisor, child, "Multiple WeChat accounts were detected");
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_ACCOUNT_SELECTION_REQUIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "inspect_logs");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a bridge exit with no captured WeChat error still schedules a restart", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "[cyberboss] bridge loop started; waiting for WeChat messages.");
    supervisor.handleExit("bridge", child, 1, null);
    assert.equal(supervisor.phase, "starting");
    assert.equal(supervisor.restartTimes.length, 1);
    assert.equal(supervisor.lastError, undefined);
  } finally {
    if (supervisor.retryTimer) clearTimeout(supervisor.retryTimer);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

