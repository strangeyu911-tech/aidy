"use strict";

const { getProviderPreset } = require("../../../services/provider-catalog");

const DEFAULT_OVERALL_TIMEOUT_MS = 60_000;
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 32 * 1024;
const PROTOCOL_FACTORIES = Object.freeze({
  "openai-chat": () => require("./protocols/openai").createOpenAiChatClient,
  "openai-responses": () => require("./protocols/openai").createOpenAiResponsesClient,
  "anthropic-messages": () => require("./protocols/anthropic").createAnthropicClient,
  gemini: () => require("./protocols/gemini").createGeminiClient,
  ollama: () => require("./protocols/ollama").createOllamaClient,
});

function createProtocolClient({ profile, secrets = {}, fetchImpl = globalThis.fetch, capture = null } = {}) {
  const normalizedProfile = normalizeProfile(profile);
  if (typeof fetchImpl !== "function") throw protocolError("FETCH_UNAVAILABLE", "A fetch implementation is required.");
  const protocolId = normalizedProfile.protocolId
    || getProviderPreset(normalizedProfile.providerId)?.protocol
    || "";
  const loadFactory = PROTOCOL_FACTORIES[protocolId];
  if (!loadFactory) throw protocolError("UNSUPPORTED_PROTOCOL", "The provider protocol is not supported.");
  return loadFactory()({
    profile: { ...normalizedProfile, protocolId },
    secrets: isRecord(secrets) ? { ...secrets } : {},
    fetchImpl,
    capture,
  });
}

async function performJsonRequest(context, { url, method = "GET", headers = {}, body, signal } = {}) {
  return performRequest(context, { url, method, headers, body, signal }, async (response) => {
    try {
      return await response.json();
    } catch {
      throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned malformed JSON.");
    }
  });
}

async function performStreamRequest(context, { url, method = "POST", headers = {}, body, signal } = {}, consume) {
  return performRequest(context, { url, method, headers, body, signal }, async (response, requestState) => {
    if (!response.body || typeof response.body.getReader !== "function") {
      throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned no readable response stream.");
    }
    return consume(response, requestState);
  });
}

async function performRequest(context, request, consume) {
  const requestState = createRequestState(request.signal, context.profile.options);
  const requestUrl = requireHttpUrl(request.url);
  recordCapture(context.capture, "provider.request", {
    protocolId: context.profile.protocolId,
    providerId: context.profile.providerId,
    method: request.method,
    endpoint: `${requestUrl.origin}${requestUrl.pathname}`,
  });
  try {
    let response;
    try {
      response = await context.fetchImpl(requestUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: requestState.controller.signal,
      });
    } catch (error) {
      throw normalizeProtocolError(error, requestState);
    }
    if (!response || typeof response !== "object") {
      throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned an invalid HTTP response.");
    }
    if (!response.ok) throw await httpProtocolError(response);
    const value = await consume(response, requestState);
    recordCapture(context.capture, "provider.response", {
      protocolId: context.profile.protocolId,
      providerId: context.profile.providerId,
      status: Number(response.status) || 200,
    });
    return value;
  } catch (error) {
    const normalized = normalizeProtocolError(error, requestState);
    recordCapture(context.capture, "provider.error", {
      protocolId: context.profile.protocolId,
      providerId: context.profile.providerId,
      code: normalized.code,
    });
    throw normalized;
  } finally {
    requestState.cleanup();
  }
}

async function* iterateSse(body, requestState) {
  let pending = "";
  for await (const text of iterateUtf8(body, requestState)) {
    pending += text;
    while (true) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const event = parseSseFrame(frame);
      if (event) yield event;
    }
  }
  if (pending.trim()) {
    const event = parseSseFrame(pending);
    if (event) yield event;
  }
}

async function* iterateJsonLines(body, requestState) {
  let pending = "";
  for await (const text of iterateUtf8(body, requestState)) {
    pending += text;
    while (true) {
      const lineEnd = pending.indexOf("\n");
      if (lineEnd < 0) break;
      const line = pending.slice(0, lineEnd).trim();
      pending = pending.slice(lineEnd + 1);
      if (line) yield parseProtocolJson(line);
    }
  }
  if (pending.trim()) yield parseProtocolJson(pending.trim());
}

async function* iterateUtf8(body, requestState) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      let result;
      try {
        result = await readWithChunkTimeout(reader, requestState);
      } catch (error) {
        throw normalizeProtocolError(error, requestState);
      }
      if (result.done) break;
      try {
        yield decoder.decode(result.value, { stream: true });
      } catch {
        throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider stream contains invalid UTF-8.");
      }
    }
    const remainder = decoder.decode();
    if (remainder) yield remainder;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function readWithChunkTimeout(reader, requestState) {
  if (!requestState.chunkTimeoutMs) return reader.read();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestState.abortKind = "timeout";
      requestState.controller.abort();
      reject(protocolError("MODEL_SERVICE_TIMEOUT", "The provider stream timed out."));
    }, requestState.chunkTimeoutMs);
    reader.read().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function parseSseFrame(frame) {
  if (!frame || frame.startsWith(":")) return null;
  let event = "message";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

function parseProtocolJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned a malformed stream event.");
  }
}

async function httpProtocolError(response) {
  const status = Number(response.status) || 0;
  let detail = "";
  try {
    const text = await response.text();
    detail = text.slice(0, MAX_ERROR_BODY_BYTES).toLowerCase();
  } catch {}
  const code = mapHttpErrorCode(status, detail);
  const error = protocolError(code, errorMessage(code));
  error.status = status;
  const retryAfter = Number.parseInt(readHeader(response.headers, "retry-after"), 10);
  if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) error.retryAfterSeconds = retryAfter;
  return error;
}

function mapHttpErrorCode(status, detail = "") {
  if (status === 401 || status === 403) return "INVALID_CREDENTIALS";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 408 || status === 504) return "MODEL_SERVICE_TIMEOUT";
  if (status === 429) {
    return /quota|credit|balance|billing|payment|insufficient/.test(detail)
      ? "QUOTA_EXHAUSTED"
      : "RATE_LIMITED";
  }
  if (status >= 500) return "MODEL_SERVICE_UNAVAILABLE";
  if (status >= 400) return "INVALID_REQUEST";
  return "INCOMPATIBLE_PROTOCOL";
}

function normalizeProtocolError(error, requestState = {}) {
  if (error?.code && typeof error.code === "string") return error;
  if (requestState.abortKind === "timeout") return protocolError("MODEL_SERVICE_TIMEOUT", "The provider request timed out.");
  if (requestState.abortKind === "cancelled" || error?.name === "AbortError") {
    return protocolError("CANCELLED", "The provider request was cancelled.");
  }
  return protocolError("MODEL_SERVICE_UNAVAILABLE", "The model service is unavailable.");
}

function createRequestState(parentSignal, options) {
  const controller = new AbortController();
  const overallTimeoutMs = positiveInteger(options?.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS);
  const chunkTimeoutMs = positiveInteger(options?.chunkTimeoutMs, DEFAULT_CHUNK_TIMEOUT_MS);
  const state = { controller, abortKind: "", chunkTimeoutMs, cleanup: () => {} };
  const onParentAbort = () => {
    state.abortKind = "cancelled";
    controller.abort();
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    state.abortKind = "timeout";
    controller.abort();
  }, overallTimeoutMs);
  state.cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  };
  return state;
}

function normalizeProfile(value) {
  if (!isRecord(value)) throw protocolError("INVALID_PROFILE", "A provider profile is required.");
  const providerId = normalizeText(value.providerId).toLowerCase();
  const profile = {
    ...value,
    id: normalizeText(value.id),
    providerId,
    protocolId: normalizeText(value.protocolId).toLowerCase(),
    baseUrl: normalizeText(value.baseUrl) || getProviderPreset(providerId)?.defaultBaseUrl || "",
    modelId: normalizeText(value.modelId),
    options: isRecord(value.options) ? { ...value.options } : {},
  };
  if (!profile.id || !profile.providerId || !profile.baseUrl || !profile.modelId) {
    throw protocolError("INVALID_PROFILE", "The provider profile is incomplete.");
  }
  requireHttpUrl(profile.baseUrl);
  return profile;
}

function normalizeMessage(message) {
  if (!isRecord(message) || !["user", "assistant", "tool", "system"].includes(message.role)) {
    throw protocolError("INVALID_REQUEST", "A normalized message has an invalid role.");
  }
  return {
    ...message,
    role: message.role,
    content: normalizeContent(message.content),
    toolCallId: normalizeText(message.toolCallId),
    toolCalls: normalizeToolCalls(message.toolCalls),
  };
}

function normalizeContent(value) {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return { type: "text", text: item };
    if (!isRecord(item)) return null;
    if (item.type === "text") return { type: "text", text: String(item.text ?? "") };
    return { ...item };
  }).filter(Boolean);
}

function normalizeTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    if (!isRecord(tool) || !normalizeText(tool.name)) {
      throw protocolError("INVALID_REQUEST", "A normalized tool requires a name.");
    }
    return {
      name: normalizeText(tool.name),
      description: normalizeText(tool.description),
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    };
  });
}

function normalizeToolCalls(value) {
  return (Array.isArray(value) ? value : []).map((call, index) => ({
    id: normalizeText(call?.id) || `call-${index + 1}`,
    name: normalizeText(call?.name),
    arguments: parseToolArguments(call?.arguments),
  })).filter((call) => call.name);
}

function parseToolArguments(value) {
  if (isRecord(value)) return value;
  const text = normalizeText(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw protocolError("TOOL_CALL_MALFORMED", "The provider returned malformed tool arguments.");
  }
}

function normalizedResult(text, toolCalls = [], usage = {}) {
  const content = text ? [{ type: "text", text }] : [];
  return {
    message: { role: "assistant", content },
    toolCalls: normalizeToolCalls(toolCalls),
    usage: {
      inputTokens: nonNegativeInteger(usage.inputTokens),
      outputTokens: nonNegativeInteger(usage.outputTokens),
    },
  };
}

function textContent(message) {
  return normalizeContent(message?.content)
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function emitDelta(callback, text) {
  if (text && typeof callback === "function") callback(text);
}

function normalizeModels(values, providerId) {
  const seen = new Set();
  const models = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = normalizeText(value?.id || value?.name || value?.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const modalities = value?.inputModalities || value?.input_modalities || value?.architecture?.input_modalities || [];
    models.push({
      id: id.replace(/^models\//, ""),
      name: normalizeText(value?.displayName || value?.name) || id.replace(/^models\//, ""),
      providerId,
      inputModalities: [...new Set((Array.isArray(modalities) ? modalities : []).map((item) => normalizeText(item).toLowerCase()).filter(Boolean))],
      contextWindow: positiveIntegerOrNull(value?.contextWindow ?? value?.context_window ?? value?.context_length),
    });
  }
  return models;
}

function context(profile, secrets, fetchImpl, capture) {
  return { profile, secrets, fetchImpl, capture };
}

function assertContentType(response, allowed) {
  const contentType = readHeader(response?.headers, "content-type").toLowerCase().split(";", 1)[0].trim();
  if (!allowed.includes(contentType)) {
    throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned an incompatible stream content type.");
  }
}

function joinUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}/${String(suffix).replace(/^\//, "")}`;
}

function jsonHeaders(extra = {}) {
  return { accept: "application/json", "content-type": "application/json", ...extra };
}

function customHeaders(profile, secrets) {
  const values = { ...(isRecord(profile.options?.headers) ? profile.options.headers : {}), ...(isRecord(secrets?.sensitiveHeaders) ? secrets.sensitiveHeaders : {}) };
  const denied = new Set(["authorization", "content-length", "host", "transfer-encoding", "x-api-key", "x-goog-api-key"]);
  return Object.fromEntries(Object.entries(values)
    .filter(([name, value]) => normalizeText(name) && !denied.has(name.toLowerCase()) && typeof value === "string")
    .map(([name, value]) => [name, value]));
}

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function errorMessage(code) {
  return {
    INVALID_CREDENTIALS: "The provider rejected the configured credentials.",
    MODEL_UNAVAILABLE: "The selected model is unavailable.",
    RATE_LIMITED: "The provider rate-limited the request.",
    QUOTA_EXHAUSTED: "The provider account has insufficient quota or credits.",
    MODEL_SERVICE_TIMEOUT: "The provider request timed out.",
    MODEL_SERVICE_UNAVAILABLE: "The model service is unavailable.",
    INVALID_REQUEST: "The provider rejected the request.",
    INCOMPATIBLE_PROTOCOL: "The provider returned an incompatible response.",
  }[code] || "The provider request failed.";
}

function requireHttpUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw protocolError("INVALID_BASE_URL", "The provider base URL is invalid."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw protocolError("INVALID_BASE_URL", "The provider base URL must be HTTP(S) and contain no credentials.");
  }
  return parsed;
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return normalizeText(headers.get(name));
  return "";
}

function recordCapture(capture, type, metadata) {
  try {
    if (typeof capture === "function") capture({ type, ...metadata });
    else if (typeof capture?.record === "function") capture.record({ type, ...metadata });
  } catch {}
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  assertContentType,
  createProtocolClient,
  context,
  customHeaders,
  emitDelta,
  iterateJsonLines,
  iterateSse,
  joinUrl,
  jsonHeaders,
  normalizeMessage,
  normalizeModels,
  normalizeTools,
  normalizedResult,
  parseProtocolJson,
  parseToolArguments,
  performJsonRequest,
  performStreamRequest,
  protocolError,
  textContent,
};
