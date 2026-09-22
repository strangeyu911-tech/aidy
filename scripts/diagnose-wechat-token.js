#!/usr/bin/env node
"use strict";

/**
 * Is the saved WeChat bot token still usable, and is anything waiting behind it?
 *
 * This is the first question to answer when the user reports "Aidy 收不到消息".
 * The control center can report a connected channel while the bridge has actually
 * stopped polling, so the UI is not evidence; the token on disk is.
 *
 * ⚠️ THIS PROBE CONSUMES A PENDING BACKLOG — it is not read-only.
 * The `get_updates_buf` cursor is NOT purely client-held: measured on 2026-09-22,
 * two consecutive probes with an empty cursor returned 3 pending updates and then 0,
 * so the server tracks delivery per token and advances on each accepted poll. Any
 * update the bridge had not yet collected is swallowed by running this, and the
 * bridge will never see it. Run it when the backlog is already undeliverable (a
 * broken channel is exactly that case), or when you accept losing it.
 *
 * It never prints the token, never writes the account file, and never sends a message.
 *
 * Reading the verdict:
 *   TOKEN_ALIVE_BACKLOG  the token works and N updates are waiting undelivered.
 *                        Nothing is wrong with the credential — the bridge simply
 *                        is not polling. Restart Aidy promptly: this probe is what
 *                        drains the backlog.
 *   TOKEN_ALIVE_IDLE     the token works and nothing is pending. The long-poll held
 *                        for the full timeout, which is what a healthy idle channel
 *                        looks like.
 *   TOKEN_REJECTED       the server answered with a non-zero ret/errcode. `-14` means
 *                        the session was revoked and the user must scan again. If it
 *                        appears within seconds of a scan, that is the `eec4eae`
 *                        regression (the scan mints a new bot id and revokes the old
 *                        one, while the running bridge still holds the old account).
 *   NETWORK_ERROR        the request never reached the server; not a credential issue.
 *
 * Usage: node scripts/diagnose-wechat-token.js [--timeout-ms 8000]
 *
 * Note: `--timeout-ms` is the long-poll budget. The wall time is that value plus the
 * 5 s abort grace `apiPost` adds, so an idle channel takes timeout+5 s to answer.
 */

const os = require("node:os");
const path = require("node:path");

const { resolveSelectedAccount } = require("../src/adapters/channel/weixin/account-store");
const { getUpdates } = require("../src/adapters/channel/weixin/api");

const DEFAULT_TIMEOUT_MS = 35_000;

function readTimeoutMs(argv) {
  const index = argv.indexOf("--timeout-ms");
  const raw = index === -1 ? "" : argv[index + 1];
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_TIMEOUT_MS;
}

function resolveConfig() {
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
  return {
    stateDir,
    accountsDir: path.join(stateDir, "accounts"),
    accountId: process.env.CYBERBOSS_ACCOUNT_ID || "",
    weixinBaseUrl: process.env.CYBERBOSS_WEIXIN_BASE_URL || "https://ilinkai.weixin.qq.com",
  };
}

function rpcCodeOf(response) {
  for (const raw of [response?.ret, response?.errcode]) {
    if (raw === undefined || raw === null || raw === "") continue;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

async function main() {
  const config = resolveConfig();
  const account = resolveSelectedAccount(config);
  const timeoutMs = readTimeoutMs(process.argv.slice(2));

  console.log(`[diagnose-wechat-token] stateDir=${config.stateDir}`);
  console.log(`[diagnose-wechat-token] account=${account.accountId} tokenSavedAt=${account.savedAt || "(unknown)"}`);
  console.log(`[diagnose-wechat-token] baseUrl=${account.baseUrl}`);
  console.log("[diagnose-wechat-token] ⚠️ this poll consumes any pending backlog for this token.");
  console.log(`[diagnose-wechat-token] polling with an empty cursor and a ${timeoutMs} ms client timeout...`);

  const startedAt = Date.now();
  let response;
  try {
    response = await getUpdates({
      baseUrl: account.baseUrl,
      token: account.token,
      getUpdatesBuf: "",
      timeoutMs,
    });
  } catch (error) {
    console.log(JSON.stringify({
      verdict: "NETWORK_ERROR",
      elapsedMs: Date.now() - startedAt,
      errorClass: error?.pollErrorClass || null,
      httpStatus: error?.httpStatus ?? null,
      message: String(error?.message || error).slice(0, 300),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  const timedOut = response?.timedOut === true;
  const code = rpcCodeOf(response);
  const pendingCount = Array.isArray(response?.msgs) ? response.msgs.length : 0;

  let verdict = "TOKEN_ALIVE_IDLE";
  let guidance = "凭据正常，且没有积压。这是健康空闲通道的样子。";
  if (timedOut) {
    verdict = "TOKEN_ALIVE_IDLE";
    guidance = "凭据正常：服务端接受了这次长轮询并一直挂到客户端超时，这正是健康空闲通道的表现。";
  } else if (code !== 0) {
    verdict = code === -14 ? "TOKEN_REJECTED_SESSION_REVOKED" : "TOKEN_REJECTED";
    guidance = code === -14
      ? "会话已被吊销 → 需要重新扫码。⚠️ 若这次 -14 出现在扫码后数秒内，那是 eec4eae 修的回归：扫码会铸出新 bot id 并吊销旧会话，而正在跑的桥接还握着旧账号。"
      : "服务端以非零 ret/errcode 拒绝，请在下一步按 code 判断是否需要重扫。";
  } else if (pendingCount > 0) {
    verdict = "TOKEN_ALIVE_BACKLOG";
    guidance = `凭据正常，但有 ${pendingCount} 条更新未被投递 —— 不是凭据问题，是桥接没有在轮询。⚠️ 这次探针已把它们消费掉，重启 Aidy 也拿不回来了；让用户重发一条即可。`;
  }

  console.log(JSON.stringify({
    verdict,
    elapsedMs,
    httpStatus: 200,
    ret: response?.ret ?? null,
    errcode: response?.errcode ?? null,
    rpcCode: code,
    timedOut,
    pendingUpdates: pendingCount,
    cursorReturnedChars: typeof response?.get_updates_buf === "string" ? response.get_updates_buf.length : null,
    guidance,
  }, null, 2));
}

void main();
