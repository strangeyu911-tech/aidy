"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveLoginView } = require("../src/desktop/renderer/wechat-login-view");

test("a fresh QR code is offered for scanning with no error and no retry", () => {
  const view = resolveLoginView({
    status: "waiting",
    qrUrl: "https://ilinkai.weixin.qq.com/q/abc",
    qrSvg: "<svg></svg>",
    message: "请用微信扫描二维码。",
  });
  assert.equal(view.status, "waiting");
  assert.equal(view.showQr, true);
  assert.equal(view.qrUrl, "https://ilinkai.weixin.qq.com/q/abc");
  assert.equal(view.scanned, false);
  assert.equal(view.error, "");
  assert.equal(view.showRetry, false);
  assert.equal(view.showDone, true);
  assert.equal(view.connected, false);
});

test("the QR is hidden once it is no longer usable", () => {
  // A confirmed login and a failed one both leave the old code unscannable, so
  // keeping it on screen would invite the user to scan something dead.
  for (const status of ["confirmed", "connected", "error"]) {
    const view = resolveLoginView({ status, qrUrl: "https://x/q", qrSvg: "<svg></svg>" });
    assert.equal(view.showQr, false, `status ${status} must not show a QR code`);
  }
});

test("an empty snapshot degrades to an idle view instead of throwing", () => {
  for (const input of [undefined, null, {}, { status: 42 }]) {
    const view = resolveLoginView(input);
    assert.equal(view.status, "idle");
    assert.equal(view.showQr, false);
    assert.equal(view.message, "还没有开始连接。");
    assert.equal(view.error, "");
  }
});

test("a scanned code is flagged so the UI can mark it", () => {
  assert.equal(resolveLoginView({ status: "scanned" }).scanned, true);
  assert.equal(resolveLoginView({ status: "waiting", scanned: true }).scanned, true);
  // The refresh path clears the flag so the new code is not shown as scanned.
  assert.equal(resolveLoginView({ status: "waiting", scanned: false }).scanned, false);
});

test("a failure offers a retry and surfaces a reason even when it has none", () => {
  const withReason = resolveLoginView({ status: "error", error: "等待扫码超时了。" });
  assert.equal(withReason.showRetry, true);
  assert.equal(withReason.showDone, false);
  assert.equal(withReason.error, "等待扫码超时了。");

  const withoutReason = resolveLoginView({ status: "error" });
  assert.equal(withoutReason.showRetry, true);
  assert.match(withoutReason.error, /连接微信失败/);
});

test("statuses without an explicit message fall back to their own copy", () => {
  assert.equal(resolveLoginView({ status: "starting" }).message, "正在获取二维码…");
  assert.equal(resolveLoginView({ status: "scanned" }).message, "已扫码，请在微信里点「确认登录」。");
  // An unknown status must still render something rather than an empty line.
  assert.equal(resolveLoginView({ status: "something-else" }).message, "正在等待微信的确认…");
});
