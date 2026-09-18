const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { redactSensitiveText } = require("./redact");
const { attachPollMeta } = require("./poll-observability");

function readChannelVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "../../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 64 << 20;

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (typeof token === "string" && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

function truncateForLog(value, max) {
  const text = typeof value === "string" ? value : String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

async function apiPost({ baseUrl, endpoint, token, body, timeoutMs = 0, label, returnResponseMeta = false }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout + 5_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BODY_BYTES) {
      const error = new Error(`${label} response body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`);
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`${label} http ${response.status}: ${redactSensitiveText(truncateForLog(raw, 512))}`);
      error.httpStatus = response.status;
      error.pollErrorClass = "http";
      throw error;
    }
    return returnResponseMeta ? { raw, httpStatus: response.status } : raw;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${redactSensitiveText(truncateForLog(raw, 256))}`);
  }
}

async function sendMessage({ baseUrl, token, body, timeoutMs }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    timeoutMs: timeoutMs || DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
  const parsed = parseJson(raw, "sendMessage");
  const ret = parsed?.ret;
  const errcode = parsed?.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw Object.assign(
      new Error(`sendMessage ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(errmsg)}`),
      { code: "WEIXIN_SEND_FAILED", ret: ret ?? null, errcode: errcode ?? null },
    );
  }
  return parsed;
}

async function getUploadUrl(params) {
  const raw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    token: params.token,
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  const parsed = parseJson(raw, "getUploadUrl");
  const ret = parsed?.ret;
  const errcode = parsed?.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw new Error(`getUploadUrl ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(errmsg)}`);
  }
  return parsed;
}

async function getConfig({ baseUrl, token, ilinkUserId, contextToken, timeoutMs }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    token,
    body: JSON.stringify({
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    timeoutMs: timeoutMs || DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  const parsed = parseJson(raw, "getConfig");
  const ret = parsed?.ret;
  const errcode = parsed?.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw new Error(`getConfig ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(errmsg)}`);
  }
  return parsed;
}

async function sendTyping({ baseUrl, token, body, timeoutMs }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    token,
    body: JSON.stringify({ ...body, base_info: buildBaseInfo() }),
    timeoutMs: timeoutMs || DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
  const parsed = parseJson(raw, "sendTyping");
  const ret = parsed?.ret;
  const errcode = parsed?.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw new Error(`sendTyping ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(errmsg)}`);
  }
  return parsed;
}

async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS }) {
  const payload = JSON.stringify({
    get_updates_buf: getUpdatesBuf,
    base_info: buildBaseInfo(),
  });
  try {
    const result = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      token,
      body: payload,
      timeoutMs,
      label: "getUpdates",
      returnResponseMeta: true,
    });
    let parsed;
    try {
      parsed = parseJson(result.raw, "getUpdates");
    } catch (error) {
      error.pollErrorClass = "parse";
      error.httpStatus = result.httpStatus;
      error.responseEmpty = !String(result.raw || "").trim();
      attachPollMeta(error, {
        outcome: "error",
        errorClass: "parse",
        httpStatus: result.httpStatus,
        responseEmpty: error.responseEmpty,
        parseSuccess: false,
      });
      throw error;
    }
    attachPollMeta(parsed, {
      outcome: "success",
      httpStatus: result.httpStatus,
      rpcSuccess: isSuccessfulRpcResponse(parsed),
      rpcCode: resolveRpcCode(parsed),
      responseEmpty: !String(result.raw || "").trim(),
      parseSuccess: true,
    });
    return parsed;
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || String(error.message || "").includes("aborted"))) {
      // NOTE: this is NOT a successful round trip, even though it looks like a
      // normal `{ ret: 0, msgs: [] }` empty idle poll. The long-poll only hit
      // our own client timeout. The `timedOut: true` flag exists so callers
      // (the app.js poll loop) can distinguish it from a real empty success and
      // must NOT treat it as liveness or reset any failure counters. The
      // `get_updates_buf` cursor and `msgs: []` are preserved so the loop keeps
      // working unchanged.
      return attachPollMeta({ ret: 0, msgs: [], get_updates_buf: getUpdatesBuf, timedOut: true }, {
        outcome: "timeout",
        errorClass: "timeout",
        httpStatus: null,
        rpcSuccess: null,
        responseEmpty: true,
        parseSuccess: null,
      });
    }
    if (!error.pollErrorClass) {
      error.pollErrorClass = error.responseEmpty === true ? "parse" : "network";
    }
    throw error;
  }
}

function isSuccessfulRpcResponse(response) {
  const ret = response?.ret;
  const errcode = response?.errcode;
  return (ret === undefined || ret === null || Number(ret) === 0)
    && (errcode === undefined || errcode === null || Number(errcode) === 0);
}

function resolveRpcCode(response) {
  for (const raw of [response?.ret, response?.errcode]) {
    if (raw === undefined || raw === null || raw === "") {
      continue;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

async function sendText({ baseUrl, token, toUserId, text, contextToken, clientId }) {
  if (!String(contextToken || "").trim()) {
    throw new Error("weixin sendText requires contextToken");
  }
  const itemList = [];
  if (String(text || "").trim()) {
    itemList.push({
      type: 1,
      text_item: { text: String(text) },
    });
  }
  if (!itemList.length) {
    throw new Error("weixin sendText requires non-empty text");
  }
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    token,
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId || `cb-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: itemList,
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    label: "sendMessage",
  });
  const parsed = parseJson(raw, "sendMessage");
  const ret = parsed?.ret;
  const errcode = parsed?.errcode;
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof parsed?.errmsg === "string" ? parsed.errmsg.trim() : "";
    throw new Error(`sendMessage ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${redactSensitiveText(errmsg)}`);
  }
  return parsed;
}

module.exports = {
  buildBaseInfo,
  getConfig,
  getUploadUrl,
  getUpdates,
  isSuccessfulRpcResponse,
  sendMessage,
  sendTyping,
  sendText,
};
