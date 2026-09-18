"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { WeixinLoginRunner, buildQrSvg } = require("../src/desktop/weixin-login-runner");

const QR_URL = "https://ilinkai.weixin.qq.com/ilink/bot/qrcode?qrcode=smoke-test-value";

function waitFor(predicate, label) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > 2_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 5);
  });
}

test("buildQrSvg renders a scannable dark-on-light code and refuses empty input", () => {
  const svg = buildQrSvg(QR_URL);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /fill="#000000"/);
  // A QR with no dark modules would be a blank image, not a code.
  assert.ok((svg.match(/M\d+ \d+h/g) || []).length > 100, "expected many dark modules");
  assert.equal(buildQrSvg(""), "");
  assert.equal(buildQrSvg("   "), "");
  // The payload must actually be encoded: a different payload yields a different code.
  assert.notEqual(buildQrSvg(`${QR_URL}x`), svg);
});

test("starting the login surfaces a QR code in the snapshot", async () => {
  let observed = null;
  const runner = new WeixinLoginRunner({
    config: {},
    onUpdate: () => { observed = runner.snapshot(); },
    loginFlow: async (_config, options) => {
      options.onEvent({ type: "qr", url: QR_URL, qrId: "qr-1", refreshCount: 1, maxRefreshCount: 3, reason: "initial" });
      await new Promise(() => {});
    },
  });

  const started = runner.start();
  assert.equal(started.started, true);
  assert.equal(started.wechatLogin.active, true);

  await waitFor(() => runner.snapshot().status === "waiting", "the QR to arrive");
  const state = runner.snapshot();
  assert.equal(state.qrUrl, QR_URL);
  assert.match(state.qrSvg, /^<svg/);
  assert.equal(state.scanned, false);
  assert.equal(state.error, "");
  // The desktop only learns about progress through this callback.
  assert.equal(observed.status, "waiting");
});

test("a second start while login is running does not open a second flow", async () => {
  let flows = 0;
  const runner = new WeixinLoginRunner({
    config: {},
    loginFlow: async () => { flows += 1; await new Promise(() => {}); },
  });
  runner.start();
  const second = runner.start();
  assert.equal(second.started, false);
  assert.equal(second.alreadyRunning, true);
  assert.equal(flows, 1);
});

test("scanning and confirming move through the states and finish connected", async () => {
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const runner = new WeixinLoginRunner({
    config: {},
    loginFlow: async (_config, options) => {
      options.onEvent({ type: "qr", url: QR_URL, refreshCount: 1, maxRefreshCount: 3, reason: "initial" });
      await done;
      options.onEvent({ type: "confirmed", accountId: "bot-1", userId: "user-1" });
      return { accountId: "bot-1" };
    },
  });

  runner.start();
  await waitFor(() => runner.snapshot().status === "waiting", "the QR to arrive");
  runner.handleLoginEvent({ type: "scanned" });
  assert.equal(runner.snapshot().status, "scanned");
  assert.equal(runner.snapshot().scanned, true);

  release();
  await waitFor(() => runner.snapshot().status === "connected", "the login to finish");
  const state = runner.snapshot();
  assert.equal(state.active, false);
  // The used code must not be left around for the user to scan again.
  assert.equal(state.qrSvg, "");
  assert.equal(state.qrUrl, "");
  assert.equal(state.error, "");
});

test("a failed login becomes an actionable Chinese error, never a developer instruction", async () => {
  const runner = new WeixinLoginRunner({
    config: {},
    loginFlow: async () => {
      throw Object.assign(new Error("The QR code expired too many times. Run login again."), { code: "WECHAT_LOGIN_QR_EXPIRED" });
    },
  });

  runner.start();
  await waitFor(() => runner.snapshot().status === "error", "the failure to land");
  const state = runner.snapshot();
  assert.equal(state.active, false);
  assert.equal(state.errorCode, "WECHAT_LOGIN_QR_EXPIRED");
  assert.match(state.error, /重新点一次「连接微信」/);
  assert.doesNotMatch(state.error, /npm run login|Run login again/);
  assert.equal(state.qrSvg, "");
});

test("cancelling aborts the flow and returns to idle instead of reporting an error", async () => {
  let receivedSignal = null;
  const runner = new WeixinLoginRunner({
    config: {},
    loginFlow: async (_config, options) => {
      receivedSignal = options.signal;
      options.onEvent({ type: "qr", url: QR_URL, refreshCount: 1, maxRefreshCount: 3, reason: "initial" });
      await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      throw Object.assign(new Error("Login cancelled."), { code: "WECHAT_LOGIN_CANCELLED" });
    },
  });

  runner.start();
  await waitFor(() => runner.snapshot().status === "waiting", "the QR to arrive");
  runner.cancel();
  assert.equal(receivedSignal.aborted, true);

  await waitFor(() => runner.snapshot().active === false, "the cancel to settle");
  const state = runner.snapshot();
  // A user-initiated cancel is not a failure and must not paint an error banner.
  assert.equal(state.status, "idle");
  assert.equal(state.error, "");
  assert.equal(state.message, "已取消登录。");
});

test("cancelling when nothing is running is a harmless no-op", () => {
  const runner = new WeixinLoginRunner({ config: {} });
  const result = runner.cancel();
  assert.equal(result.ok, true);
  assert.equal(runner.snapshot().status, "idle");
});
