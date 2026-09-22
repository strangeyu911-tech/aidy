const qrcodeTerminal = require("qrcode-terminal");
const {
  listWeixinAccounts,
  retireWeixinAccount,
  saveWeixinAccount,
} = require("./account-store");
const { clearPersistedContextTokens } = require("./context-token-store");
const { redactSensitiveText } = require("./redact");

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchQrCode(apiBaseUrl, botType) {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${redactSensitiveText(body)}`);
  }
  return response.json();
}

async function pollQrStatus(apiBaseUrl, qrcode, signal) {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  if (signal?.aborted) {
    throw loginCancelledError();
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const response = await fetch(url.toString(), {
      headers: {
        "iLink-App-ClientVersion": "1",
      },
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`QR status polling failed: ${response.status} ${response.statusText} ${redactSensitiveText(rawText)}`);
    }
    return JSON.parse(rawText);
  } catch (error) {
    // A cancel must stay distinguishable from our own long-poll timeout,
    // otherwise aborting the request would look like a normal "no status yet".
    if (signal?.aborted) {
      throw loginCancelledError();
    }
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function loginCancelledError() {
  return Object.assign(new Error("Login cancelled."), { code: "WECHAT_LOGIN_CANCELLED" });
}

function printQrCode(url, reporter) {
  if (reporter?.silent) return;
  try {
    qrcodeTerminal.generate(url, { small: true });
    console.log("If the QR code does not render correctly here, open this link in a browser and scan it there:");
    console.log(url);
  } catch {
    console.log(url);
  }
}

function noop() {}

// The CLI prints the QR to the terminal; the desktop control center renders it
// into a window instead. Both drive the same flow, so the printing is
// injectable and the state transitions are observable.
function createLoginReporter({ silent = false, onEvent } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : noop;
  const log = silent ? noop : (...args) => console.log(...args);
  return {
    silent,
    emit,
    log,
    progress: silent ? noop : (text) => process.stdout.write(text),
  };
}

function cleanupStaleAccountsForUserId(config, activeAccount) {
  const activeUserId = typeof activeAccount?.userId === "string" ? activeAccount.userId.trim() : "";
  if (!activeUserId) {
    return [];
  }
  const staleAccounts = listWeixinAccounts(config).filter((account) => (
    account.accountId !== activeAccount.accountId
    && typeof account.userId === "string"
    && account.userId.trim() === activeUserId
  ));
  for (const staleAccount of staleAccounts) {
    // Retired, not deleted: the token is already revoked server-side, but the
    // file is the only record of which identity was live when, and destroying it
    // before the new credential is proven to work is unrecoverable. The rename
    // also keeps `resolveSelectedAccount` single-account.
    retireWeixinAccount(config, staleAccount.accountId);
    clearPersistedContextTokens(config, staleAccount.accountId);
    console.log(`[cyberboss] retired stale account ${staleAccount.accountId} for userId ${activeUserId}`);
  }
  return staleAccounts;
}

async function waitForWeixinLogin({ apiBaseUrl, botType, timeoutMs, silent = false, onEvent, shouldStop, signal }) {
  const reporter = createLoginReporter({ silent, onEvent });
  const stopRequested = () => (typeof shouldStop === "function" && shouldStop() === true) || Boolean(signal?.aborted);
  let qrResponse = await fetchQrCode(apiBaseUrl, botType);
  let startedAt = Date.now();
  let scannedPrinted = false;
  let refreshCount = 1;

  reporter.log("Scan this QR code with WeChat to connect:\n");
  printQrCode(qrResponse.qrcode_img_content, reporter);
  reporter.log("\nWaiting for the connection result...\n");
  reporter.emit({
    type: "qr",
    url: qrResponse.qrcode_img_content,
    qrId: qrResponse.qrcode,
    refreshCount,
    maxRefreshCount: MAX_QR_REFRESH_COUNT,
    reason: "initial",
  });

  const refreshQr = async (reason) => {
    qrResponse = await fetchQrCode(apiBaseUrl, botType);
    startedAt = Date.now();
    scannedPrinted = false;
    refreshCount += 1;
    if (refreshCount > MAX_QR_REFRESH_COUNT) {
      throw Object.assign(
        new Error("The QR code expired too many times. Run login again."),
        { code: "WECHAT_LOGIN_QR_EXPIRED" },
      );
    }
    reporter.log(`QR code expired. Refreshing... (${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
    printQrCode(qrResponse.qrcode_img_content, reporter);
    reporter.emit({
      type: "qr",
      url: qrResponse.qrcode_img_content,
      qrId: qrResponse.qrcode,
      refreshCount,
      maxRefreshCount: MAX_QR_REFRESH_COUNT,
      reason,
    });
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopRequested()) {
      throw loginCancelledError();
    }
    if (Date.now() - startedAt > ACTIVE_LOGIN_TTL_MS) {
      await refreshQr("ttl");
    }

    const statusResponse = await pollQrStatus(apiBaseUrl, qrResponse.qrcode, signal);
    switch (statusResponse.status) {
      case "wait":
        reporter.progress(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          reporter.progress("\nQR code scanned. Confirm the login inside WeChat...\n");
          scannedPrinted = true;
          reporter.emit({ type: "scanned" });
        }
        break;
      case "expired":
        await refreshQr("expired");
        break;
      case "confirmed":
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          throw Object.assign(
            new Error("Login succeeded but the response is missing the bot token or account ID."),
            { code: "WECHAT_LOGIN_INCOMPLETE" },
          );
        }
        reporter.emit({
          type: "confirmed",
          accountId: statusResponse.ilink_bot_id,
          userId: statusResponse.ilink_user_id || "",
        });
        return {
          accountId: statusResponse.ilink_bot_id,
          token: statusResponse.bot_token,
          baseUrl: statusResponse.baseurl || apiBaseUrl,
          userId: statusResponse.ilink_user_id || "",
        };
      default:
        break;
    }
  }
  throw Object.assign(new Error("Login timed out. Run login again."), { code: "WECHAT_LOGIN_TIMEOUT" });
}

async function runLoginFlow(config, options = {}) {
  const reporter = createLoginReporter(options);
  reporter.log("[cyberboss] starting WeChat QR login...");
  const result = await waitForWeixinLogin({
    apiBaseUrl: config.weixinBaseUrl,
    botType: config.weixinQrBotType,
    timeoutMs: 480_000,
    silent: options.silent,
    onEvent: options.onEvent,
    shouldStop: options.shouldStop,
    signal: options.signal,
  });
  const account = saveWeixinAccount(config, result.accountId, result);
  cleanupStaleAccountsForUserId(config, account);
  reporter.log("\n✅ Connected to WeChat successfully.");
  reporter.log(`accountId: ${account.accountId}`);
  reporter.log(`userId: ${account.userId || "(unknown)"}`);
  reporter.log(`baseUrl: ${account.baseUrl}`);
  return account;
}

module.exports = { runLoginFlow, waitForWeixinLogin };
