"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveErrorView,
  stateDisplay,
} = require("../src/desktop/renderer/connection-status-view");

test("error hero displays the real diagnostic summary", () => {
  const display = stateDisplay("error", "running", { complete: true }, {
    summary: "CyberBoss 内部微信连接运行文件不可用。",
  });
  assert.equal(display.title, "需要处理");
  assert.match(display.description, /运行文件不可用/);
  assert.doesNotMatch(display.description, /请按下面/);
});

test("renderer exposes diagnostic code and only offers a matching action", () => {
  const retry = resolveErrorView({
    code: "BRIDGE_NOT_READY",
    capability: "bridge",
    summary: "连接服务未就绪",
    repairAction: "重试",
    nextAction: "retry",
  });
  const restart = resolveErrorView({
    code: "BRIDGE_RUNTIME_FILES_MISSING",
    capability: "bridge",
    summary: "运行文件不可用",
    repairAction: "完全退出并重新启动",
    nextAction: "restart_app",
  });
  assert.equal(retry.buttonLabel, "重试启动");
  assert.equal(restart.buttonLabel, "");
  assert.equal(restart.code, "BRIDGE_RUNTIME_FILES_MISSING");
});

test("renderer fallback never pretends to know an unknown repair", () => {
  const result = resolveErrorView({ code: "UNKNOWN", capability: "bridge" });
  assert.match(result.summary, /无法确定/);
  assert.match(result.repairAction, /查看最近日志/);
  assert.equal(result.buttonAction, "");
});

// The hero card used to assert "微信已连接" from the supervisor phase alone, so it
// contradicted the WeChat tile directly below it (which reads the channel
// heartbeat) whenever the bridge was silent. These four cases pin the contract:
// the hero card may only claim a connection the channel actually reported.
test("hero card claims WeChat only when the channel reports it connected", () => {
  const onboarding = { complete: true };
  const running = ["running", "quiet"];

  for (const phase of running) {
    const connected = stateDisplay(phase, "running", onboarding, null, { state: "connected" });
    assert.equal(connected.title, "艾迪已配置完成并正在运行");
    assert.match(connected.description, /微信已连接/);

    const connecting = stateDisplay(phase, "running", onboarding, null, { state: "connecting" });
    assert.doesNotMatch(connecting.description, /微信已连接/);
    assert.match(connecting.description, /还在连接中|正在连接/);
    assert.equal(connecting.short, "连接中");

    const degraded = stateDisplay(phase, "running", onboarding, null, { state: "degraded" });
    assert.doesNotMatch(degraded.description, /微信已连接/);
    assert.match(degraded.description, /没有连上/);
    assert.equal(degraded.short, "微信异常");

    // No evidence at all must not be read as success either.
    const unknown = stateDisplay(phase, "running", onboarding, null, undefined);
    assert.doesNotMatch(unknown.description, /微信已连接/);
    assert.equal(unknown.short, "连接中");
  }
});
