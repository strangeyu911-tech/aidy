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
