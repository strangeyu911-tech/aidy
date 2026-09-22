"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { waitForWeixinLogin } = require("../src/adapters/channel/weixin/login");
const {
  listWeixinAccounts,
  loadWeixinAccount,
  retireWeixinAccount,
  saveWeixinAccount,
} = require("../src/adapters/channel/weixin/account-store");

const QR_URL = "https://ilinkai.weixin.qq.com/ilink/bot/qrcode?qrcode=flow-test";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/`)));
}

// A held long poll keeps the socket open, so closeAllConnections is required or
// server.close() never settles and the test process hangs.
function stopServer(t, server) {
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
}

/**
 * Stands up a fake iLink endpoint. `statusFor` decides what each
 * get_qrcode_status call answers; returning null holds the connection open so
 * the long-poll behaviour can be exercised.
 */
async function startFakeEndpoint(t, statusFor) {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/ilink/bot/get_bot_qrcode")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ qrcode: "qr-1", qrcode_img_content: QR_URL }));
      return;
    }
    if (request.url.startsWith("/ilink/bot/get_qrcode_status")) {
      const status = statusFor();
      if (!status) return; // hold the long poll open
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  stopServer(t, server);
  return await listen(server);
}

test("the login emits the QR before it starts polling for the scan", async (t) => {
  const baseUrl = await startFakeEndpoint(t, () => ({ status: "wait" }));
  const events = [];
  const controller = new AbortController();
  const pending = waitForWeixinLogin({
    apiBaseUrl: baseUrl,
    botType: "3",
    timeoutMs: 20_000,
    silent: true,
    onEvent: (event) => events.push(event),
    signal: controller.signal,
  });
  pending.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();

  const first = events[0];
  assert.equal(first.type, "qr");
  assert.equal(first.url, QR_URL);
  assert.equal(first.refreshCount, 1);
  assert.equal(first.reason, "initial");
});

test("a scanned code is announced so the window can prompt for confirmation", async (t) => {
  const baseUrl = await startFakeEndpoint(t, () => ({ status: "scaned" }));
  const events = [];
  const controller = new AbortController();
  const pending = waitForWeixinLogin({
    apiBaseUrl: baseUrl,
    botType: "3",
    timeoutMs: 20_000,
    silent: true,
    onEvent: (event) => events.push(event),
    signal: controller.signal,
  });
  pending.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  assert.equal(events.some((event) => event.type === "scanned"), true);
});

test("a confirmed scan resolves with the account credentials", async (t) => {
  const baseUrl = await startFakeEndpoint(t, () => ({
    status: "confirmed",
    bot_token: "token-value",
    ilink_bot_id: "bot-123",
    ilink_user_id: "user-456",
    baseurl: "https://example.test",
  }));
  const events = [];

  const account = await waitForWeixinLogin({
    apiBaseUrl: baseUrl,
    botType: "3",
    timeoutMs: 20_000,
    silent: true,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(account, {
    accountId: "bot-123",
    token: "token-value",
    baseUrl: "https://example.test",
    userId: "user-456",
  });
  assert.equal(events.at(-1).type, "confirmed");
});

test("aborting a long poll reports a cancel, not a timeout", async (t) => {
  // The server never answers, which is exactly the state the user is in while
  // they stare at the QR code trying to decide.
  const baseUrl = await startFakeEndpoint(t, () => null);
  const controller = new AbortController();
  const pending = waitForWeixinLogin({
    apiBaseUrl: baseUrl,
    botType: "3",
    timeoutMs: 60_000,
    silent: true,
    signal: controller.signal,
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();

  // If cancellation were mistaken for our own long-poll timeout this would
  // resolve with { status: "wait" } and the dialog would never close.
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "WECHAT_LOGIN_CANCELLED");
    return true;
  });
});

test("a failure to fetch a QR code is reported to the caller", async (t) => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 500;
    response.end("boom");
  });
  stopServer(t, server);
  const baseUrl = await listen(server);

  await assert.rejects(
    waitForWeixinLogin({ apiBaseUrl: baseUrl, botType: "3", timeoutMs: 5_000, silent: true }),
    /Failed to fetch QR code: 500/,
  );
});

test("retireWeixinAccount removes a credential from rotation without destroying it", () => {
  // A re-scan mints a new accountId and revokes the old token server-side. Deleting
  // the file before the replacement credential is proven to work would turn a bad
  // login into an unrecoverable one, so retiring must keep the file on disk.
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-retire-account-"));
  const config = { accountsDir, weixinBaseUrl: "https://ilinkai.weixin.qq.com" };
  try {
    saveWeixinAccount(config, "old-acct", { token: "secret-token", userId: "wxid_user" });
    assert.equal(listWeixinAccounts(config).length, 1);

    assert.equal(retireWeixinAccount(config, "old-acct"), true);

    assert.equal(listWeixinAccounts(config).length, 0, "a retired account must leave the .json rotation");
    assert.equal(loadWeixinAccount(config, "old-acct"), null);

    const leftovers = fs.readdirSync(accountsDir).filter((name) => name.startsWith("old-acct.json.retired-"));
    assert.equal(leftovers.length, 1, "the retired file stays on disk for forensics");
    const retired = JSON.parse(fs.readFileSync(path.join(accountsDir, leftovers[0]), "utf8"));
    assert.equal(retired.token, "secret-token", "the retired file keeps the credential record");
  } finally {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  }
});

test("retireWeixinAccount returns false for unknown or invalid account ids", () => {
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-retire-account-"));
  const config = { accountsDir, weixinBaseUrl: "https://ilinkai.weixin.qq.com" };
  try {
    assert.equal(retireWeixinAccount(config, "no-such-acct"), false);
    assert.equal(retireWeixinAccount(config, ""), false);
  } finally {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  }
});
