"use strict";

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);
const PERMISSION_RESPONSES = new Set(["once", "always", "reject"]);

class OpenCodeClient {
  constructor({ endpoint, username = "opencode", password = "", directory = "", fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("OpenCodeClient requires a fetch implementation.");
    }
    this.endpoint = normalizeEndpoint(endpoint);
    this.username = normalizeUsername(username);
    this.password = typeof password === "string" ? password : "";
    this.directory = normalizeText(directory);
    this.fetch = fetchImpl;
  }

  async health(options = {}) {
    const body = await this.requestJson("global/health", {
      method: "GET",
      signal: options.signal,
      directory: options.directory,
    });
    if (body?.healthy === false) {
      throw clientError("OPENCODE_UNHEALTHY", "The OpenCode service reported an unhealthy state.");
    }
    if (body?.healthy !== true || !normalizeText(body?.version)) {
      throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned an incompatible health response.");
    }
    return { healthy: true, version: normalizeText(body.version) };
  }

  async listProviders(options = {}) {
    const body = await this.requestJson("provider", {
      method: "GET",
      signal: options.signal,
      directory: options.directory,
    });
    return normalizeProviderResponse(body);
  }

  async createSession(input = {}, options = {}) {
    const body = await this.requestJson("session", {
      method: "POST",
      body: sanitizeSessionInput(input),
      signal: options.signal,
      directory: options.directory,
    });
    if (!normalizeText(body?.id)) {
      throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode did not return a session identifier.");
    }
    return body;
  }

  async listMessages(sessionId, options = {}) {
    const body = await this.requestJson(`session/${encodeId(sessionId, "session")}/message`, {
      method: "GET",
      signal: options.signal,
      directory: options.directory,
      query: Number.isSafeInteger(options.limit) && options.limit > 0
        ? { limit: String(options.limit) }
        : {},
    });
    if (!Array.isArray(body)) {
      throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned an incompatible message list.");
    }
    return body;
  }

  async promptAsync(sessionId, input, options = {}) {
    await this.request(`session/${encodeId(sessionId, "session")}/prompt_async`, {
      method: "POST",
      body: sanitizePromptInput(input),
      signal: options.signal,
      directory: options.directory,
      expectedStatus: 204,
    });
  }

  async abortSession(sessionId, options = {}) {
    return this.requestJson(`session/${encodeId(sessionId, "session")}/abort`, {
      method: "POST",
      signal: options.signal,
      directory: options.directory,
    });
  }

  async respondPermission(sessionId, permissionId, response, options = {}) {
    const normalizedResponse = normalizeText(response).toLowerCase();
    if (!PERMISSION_RESPONSES.has(normalizedResponse)) {
      throw clientError("INVALID_PERMISSION_RESPONSE", "OpenCode permission response must be once, always, or reject.");
    }
    return this.requestJson(
      `session/${encodeId(sessionId, "session")}/permissions/${encodeId(permissionId, "permission")}`,
      {
        method: "POST",
        body: { response: normalizedResponse },
        signal: options.signal,
        directory: options.directory,
      },
    );
  }

  async *events(options = {}) {
    const response = await this.request("event", {
      method: "GET",
      signal: options.signal,
      directory: options.directory,
      headers: { Accept: "text/event-stream" },
    });
    try {
      for await (const event of parseServerSentEvents(response, options.signal)) {
        yield event;
      }
    } catch (error) {
      throw normalizeClientError(error, options.signal);
    }
  }

  async requestJson(relativePath, options = {}) {
    const response = await this.request(relativePath, options);
    try {
      if (typeof response.json === "function") return await response.json();
      if (typeof response.text === "function") {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }
    } catch {
      throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned malformed JSON.");
    }
    throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned an incompatible response.");
  }

  async request(relativePath, {
    method = "GET",
    body,
    signal,
    directory,
    query = {},
    headers = {},
    expectedStatus,
  } = {}) {
    throwIfAborted(signal);
    const url = buildRequestUrl(this.endpoint, relativePath, {
      directory: directory === undefined ? this.directory : directory,
      ...query,
    });
    const requestHeaders = {
      Accept: "application/json",
      ...headers,
    };
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    if (this.password) {
      requestHeaders.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")}`;
    }

    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw normalizeClientError(error, signal);
    }
    if (!response || typeof response !== "object") {
      throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned an incompatible HTTP response.");
    }
    const status = Number(response.status) || 0;
    if (!response.ok || (expectedStatus !== undefined && status !== expectedStatus)) {
      throw httpError(status, response.headers);
    }
    return response;
  }
}

function normalizeEndpoint(value) {
  const text = normalizeText(value);
  if (!text) throw clientError("INVALID_ENDPOINT", "An OpenCode endpoint is required.");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw clientError("INVALID_ENDPOINT", "The OpenCode endpoint is invalid.");
  }
  if (!SAFE_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw clientError("INVALID_ENDPOINT", "The OpenCode endpoint must be HTTP(S), contain no credentials, query, or fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw clientError("INSECURE_ENDPOINT", "Plaintext OpenCode endpoints must use a loopback host; use HTTPS otherwise.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHostname(value) {
  const hostname = normalizeText(value).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split(".").slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname);
}

function normalizeProviderResponse(value) {
  if (!isRecord(value) || !Array.isArray(value.all) || !Array.isArray(value.connected)) {
    throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned an incompatible provider catalog.");
  }
  const all = value.all.map(normalizeProvider).filter(Boolean);
  const connected = [...new Set(value.connected.map(normalizeText).filter(Boolean))].sort();
  const defaults = isRecord(value.default)
    ? Object.fromEntries(Object.entries(value.default)
      .map(([providerId, modelId]) => [normalizeText(providerId), normalizeText(modelId)])
      .filter(([providerId, modelId]) => providerId && modelId))
    : {};
  return { all, default: defaults, connected };
}

function normalizeProvider(value) {
  if (!isRecord(value)) return null;
  const id = normalizeText(value.id);
  if (!id || !isRecord(value.models)) return null;
  const models = Object.fromEntries(Object.entries(value.models).map(([key, model]) => {
    const normalized = normalizeProviderModel(model, key);
    return [normalized.id, normalized];
  }));
  return {
    id,
    name: normalizeText(value.name) || id,
    source: normalizeText(value.source),
    models,
  };
}

function normalizeProviderModel(value, fallbackId) {
  const source = isRecord(value) ? value : {};
  const id = normalizeText(source.id) || normalizeText(fallbackId);
  const advertisedModalities = isRecord(source.modalities) && Array.isArray(source.modalities.input)
    ? source.modalities.input
    : Array.isArray(source.inputModalities)
      ? source.inputModalities
      : [];
  const modalities = advertisedModalities.length
    ? advertisedModalities
    : source.attachment === true
      ? ["text", "image"]
      : [];
  const context = Number(source.limit?.context ?? source.contextWindow ?? source.context_window);
  return {
    id,
    name: normalizeText(source.name) || id,
    inputModalities: [...new Set(modalities.map((item) => normalizeText(item).toLowerCase()).filter(Boolean))],
    contextWindow: Number.isSafeInteger(context) && context > 0 ? context : null,
  };
}

function sanitizeSessionInput(value) {
  const source = isRecord(value) ? value : {};
  return {
    ...(normalizeText(source.parentID) ? { parentID: normalizeText(source.parentID) } : {}),
    ...(normalizeText(source.title) ? { title: normalizeText(source.title) } : {}),
  };
}

function sanitizePromptInput(value) {
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw clientError("INVALID_PROMPT", "An OpenCode prompt requires at least one part.");
  }
  const model = isRecord(value.model)
    ? { providerID: normalizeText(value.model.providerID), modelID: normalizeText(value.model.modelID) }
    : null;
  if (model && (!model.providerID || !model.modelID)) {
    throw clientError("INVALID_PROMPT", "The OpenCode model selection is incomplete.");
  }
  return {
    ...(normalizeText(value.messageID) ? { messageID: normalizeText(value.messageID) } : {}),
    ...(model ? { model } : {}),
    ...(normalizeText(value.agent) ? { agent: normalizeText(value.agent) } : {}),
    ...(typeof value.noReply === "boolean" ? { noReply: value.noReply } : {}),
    ...(normalizeText(value.system) ? { system: normalizeText(value.system) } : {}),
    ...(isRecord(value.tools) ? { tools: Object.fromEntries(Object.entries(value.tools).map(([key, enabled]) => [key, Boolean(enabled)])) } : {}),
    parts: value.parts.map(sanitizePromptPart),
  };
}

function sanitizePromptPart(value) {
  if (!isRecord(value)) throw clientError("INVALID_PROMPT", "OpenCode prompt parts must be objects.");
  const type = normalizeText(value.type).toLowerCase();
  if (type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
  if (type === "file" && normalizeText(value.url) && normalizeText(value.mime)) {
    return {
      type: "file",
      mime: normalizeText(value.mime),
      url: normalizeText(value.url),
      ...(normalizeText(value.filename) ? { filename: normalizeText(value.filename) } : {}),
    };
  }
  throw clientError("INVALID_PROMPT", "OpenCode prompt part type is unsupported.");
}

async function* parseServerSentEvents(response, signal) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of responseChunks(response)) {
    throwIfAborted(signal);
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseEventFrame(frame);
      if (event) yield event;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const finalEvent = parseEventFrame(buffer);
  if (finalEvent) yield finalEvent;
}

async function* responseChunks(response) {
  const body = response?.body;
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    yield* body;
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (typeof response?.text === "function") {
    yield await response.text();
    return;
  }
  throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode did not return an SSE response body.");
}

function parseEventFrame(frame) {
  const data = String(frame || "").split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    throw clientError("OPENCODE_INCOMPATIBLE", "OpenCode returned a malformed SSE event.");
  }
}

function buildRequestUrl(endpoint, relativePath, query) {
  const parsed = new URL(endpoint);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath}/${String(relativePath).replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  for (const [key, value] of Object.entries(query || {})) {
    const text = normalizeText(value);
    if (text) parsed.searchParams.set(key, text);
  }
  return parsed.toString();
}

function normalizeUsername(value) {
  const username = normalizeText(value) || "opencode";
  if (username.includes(":")) throw clientError("INVALID_SERVICE_CREDENTIALS", "The OpenCode service username is invalid.");
  return username;
}

function encodeId(value, label) {
  const id = normalizeText(value);
  if (!id) throw clientError("INVALID_REQUEST", `An OpenCode ${label} identifier is required.`);
  return encodeURIComponent(id);
}

function httpError(status, headers) {
  let code = "OPENCODE_REQUEST_REJECTED";
  let message = "The OpenCode service rejected the request.";
  if (status === 401 || status === 403) {
    code = "INVALID_SERVICE_CREDENTIALS";
    message = "The OpenCode service credentials were rejected.";
  } else if (status === 404) {
    code = "OPENCODE_INCOMPATIBLE";
    message = "The OpenCode service does not expose the required API endpoint.";
  } else if (status === 408 || status === 504) {
    code = "OPENCODE_TIMEOUT";
    message = "The OpenCode service request timed out.";
  } else if (status === 429) {
    code = "RATE_LIMITED";
    message = "The OpenCode service rate-limited the request.";
  } else if (status >= 500 || status === 0) {
    code = "OPENCODE_UNAVAILABLE";
    message = "The OpenCode service is unavailable.";
  }
  const error = clientError(code, message);
  error.status = status;
  const retryAfter = Number.parseInt(readHeader(headers, "retry-after"), 10);
  if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) error.retryAfterSeconds = retryAfter;
  return error;
}

function normalizeClientError(error, signal) {
  if (signal?.aborted || error?.name === "AbortError") {
    return clientError("CANCELLED", "The OpenCode request was cancelled.");
  }
  if (error?.code && typeof error.code === "string") return error;
  return clientError("OPENCODE_UNAVAILABLE", "The OpenCode service is unavailable.");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw clientError("CANCELLED", "The OpenCode request was cancelled.");
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return normalizeText(headers.get(name));
  if (!isRecord(headers)) return "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? normalizeText(headers[key]) : "";
}

function clientError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  OpenCodeClient,
  isLoopbackHostname,
  normalizeEndpoint,
};
