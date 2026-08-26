"use strict";

const crypto = require("node:crypto");

const {
  PUBLIC_ROUTES,
  decodeConnect,
  decodeHealth,
  encodeNewSessionParams,
  fingerprintAccountIdentity,
  parseSseMessages,
  protocolError,
} = require("./protocol-adapter");

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class CodeBuddyClient {
  constructor({
    endpoint,
    servicePassword,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    randomUUID = cryptoRandomUUID,
    cliVersion = "",
  } = {}) {
    this.endpoint = normalizeLoopbackEndpoint(endpoint);
    Object.defineProperty(this, "servicePassword", {
      value: requireText(servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy service password is required."),
      enumerable: false,
    });
    if (typeof fetchImpl !== "function") throw new TypeError("CodeBuddyClient requires fetch.");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
    this.randomUUID = randomUUID;
    this.cliVersion = normalizeText(cliVersion);
    this.connectionId = "";
  }

  async probeCompatibility({ signal } = {}) {
    const body = await this.requestJson(PUBLIC_ROUTES.health, { method: "GET", signal });
    return decodeHealth(body);
  }

  async connect({ signal } = {}) {
    const connected = decodeConnect(await this.requestJson(PUBLIC_ROUTES.acpConnect, { method: "POST", signal }));
    this.connectionId = connected.connectionId;
    return { connectionId: this.connectionId };
  }

  async initialize({ signal } = {}) {
    const response = await this.rpc("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "CyberBoss", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, { signal });
    if (Number(response.result?.protocolVersion) !== 1) {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP protocol version is incompatible.");
    }
    return response.result;
  }

  async getIdentityFingerprint({ signal } = {}) {
    const response = await this.rpc("_codebuddy.ai/getUserInfo", {}, { signal });
    return fingerprintAccountIdentity(response.result?.userInfo);
  }

  async newSession({ workingDirectory, signal } = {}) {
    const response = await this.rpc("session/new", encodeNewSessionParams({
      workingDirectory,
      version: this.cliVersion,
    }), { signal });
    const sessionId = normalizeText(response.result?.sessionId);
    if (!sessionId) throw protocolError("CODEBUDDY_SESSION_FAILED", "CodeBuddy did not create a session.");
    return {
      sessionId,
      modelId: normalizeText(response.result?.models?.currentModelId),
      models: Array.isArray(response.result?.models?.availableModels)
        ? response.result.models.availableModels.map((model) => ({
          id: normalizeText(model?.modelId),
          name: normalizeText(model?.name),
        })).filter((model) => model.id)
        : [],
    };
  }

  async prompt({ sessionId, text, signal } = {}) {
    const response = await this.rpc("session/prompt", {
      sessionId: requireText(sessionId, "CODEBUDDY_SESSION_FAILED", "CodeBuddy session is required."),
      prompt: [{ type: "text", text: requireText(text, "CODEBUDDY_TURN_FAILED", "CodeBuddy prompt is required.") }],
    }, { signal });
    if (normalizeText(response.result?.stopReason) !== "end_turn") {
      throw protocolError("CODEBUDDY_TURN_FAILED", "CodeBuddy did not complete the verification turn.");
    }
    return { text: collectAgentText(response.notifications), stopReason: "end_turn" };
  }

  async runTestOk({ workingDirectory, signal } = {}) {
    await this.connect({ signal });
    const initialized = await this.initialize({ signal });
    const identityFingerprint = await this.getIdentityFingerprint({ signal });
    const session = await this.newSession({ workingDirectory, signal });
    const reply = await this.prompt({
      sessionId: session.sessionId,
      text: "Respond with exactly TEST_OK and nothing else.",
      signal,
    });
    if (reply.text.trim() !== "TEST_OK") {
      throw protocolError("CODEBUDDY_TURN_FAILED", "CodeBuddy verification reply did not equal TEST_OK.");
    }
    return {
      ok: true,
      text: "TEST_OK",
      sessionId: session.sessionId,
      modelId: session.modelId,
      identityFingerprint,
      serverVersion: normalizeText(initialized?.serverInfo?.version),
    };
  }

  async rpc(method, params, { signal } = {}) {
    if (!this.connectionId) throw protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy ACP is not connected.");
    const id = requireText(this.randomUUID(), "CODEBUDDY_API_INCOMPATIBLE", "ACP request ID is unavailable.");
    const messages = await this.requestSse(PUBLIC_ROUTES.acp, {
      method: "POST",
      signal,
      headers: { "acp-connection-id": this.connectionId },
      body: { jsonrpc: "2.0", id, method, params },
    });
    const response = messages.find((message) => String(message.id ?? "") === id);
    if (!response) throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP response correlation failed.");
    if (response.error) {
      const code = method === "initialize" ? "CODEBUDDY_API_INCOMPATIBLE"
        : method === "_codebuddy.ai/getUserInfo" ? "CODEBUDDY_LOGIN_REQUIRED"
          : method === "session/new" ? "CODEBUDDY_SESSION_FAILED"
            : "CODEBUDDY_TURN_FAILED";
      const error = protocolError(code, `CodeBuddy ACP ${method} failed.`);
      Object.defineProperty(error, "diagnostic", {
        value: Object.freeze({
          method,
          upstreamCode: typeof response.error.code === "string" || typeof response.error.code === "number"
            ? response.error.code
            : null,
          upstreamMessage: sanitizeDiagnosticText(response.error.message),
        }),
        enumerable: false,
      });
      throw error;
    }
    return { result: response.result || {}, notifications: messages.filter((message) => message !== response) };
  }

  async disconnect({ signal } = {}) {
    const connectionId = this.connectionId;
    this.connectionId = "";
    if (!connectionId) return;
    await this.requestJson(PUBLIC_ROUTES.acp, {
      method: "DELETE",
      signal,
      headers: { "acp-connection-id": connectionId },
    });
  }

  async requestJson(route, { method = "GET", body, signal, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, this.timeoutMs));
    try {
      const response = await this.fetchImpl(new URL(route, `${this.endpoint}/`).href, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-CodeBuddy-Request": "1",
          Authorization: `Bearer ${this.servicePassword}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) {
        throw protocolError("CODEBUDDY_AUTH_FAILED", "CodeBuddy rejected the managed gateway credentials.");
      }
      if (!response.ok) {
        throw protocolError("CODEBUDDY_CONNECTION_LOST", `CodeBuddy public API returned HTTP ${Number(response.status) || 0}.`);
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (error?.code) throw error;
      if (controller.signal.aborted) {
        throw protocolError("CODEBUDDY_START_TIMEOUT", "CodeBuddy public API did not become ready in time.");
      }
      throw protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy public API is unavailable.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  }

  async requestSse(route, { method = "POST", body, signal, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    const response = await this.fetchProtected(route, {
      method,
      body,
      signal,
      timeoutMs,
      headers: { Accept: "application/json, text/event-stream", ...headers },
    });
    const text = await readBoundedText(response, 256 * 1024);
    return parseSseMessages(text);
  }

  async fetchProtected(route, { method = "GET", body, signal, timeoutMs = this.timeoutMs, headers = {} } = {}) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, this.timeoutMs));
    try {
      const response = await this.fetchImpl(new URL(route, `${this.endpoint}/`).href, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-CodeBuddy-Request": "1",
          Authorization: `Bearer ${this.servicePassword}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 || response.status === 403) throw protocolError("CODEBUDDY_AUTH_FAILED", "CodeBuddy rejected the managed gateway credentials.");
      if (!response.ok) throw protocolError("CODEBUDDY_CONNECTION_LOST", `CodeBuddy public API returned HTTP ${Number(response.status) || 0}.`);
      return response;
    } catch (error) {
      if (error?.code) throw error;
      if (controller.signal.aborted) throw protocolError("CODEBUDDY_START_TIMEOUT", "CodeBuddy public API did not respond in time.");
      throw protocolError("CODEBUDDY_CONNECTION_LOST", "CodeBuddy public API is unavailable.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", forwardAbort);
    }
  }
}

async function readBoundedJson(response) {
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy response exceeds the compatibility limit.");
    }
    try { return JSON.parse(text); } catch {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy returned malformed JSON.");
    }
  }
  if (typeof response.json === "function") return response.json();
  throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy returned no JSON body.");
}

async function readBoundedText(response, maxBytes) {
  if (typeof response.text !== "function") {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP returned no SSE body.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP response exceeds the compatibility limit.");
  }
  return text;
}

function collectAgentText(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const update = message?.method === "session/update" ? message.params?.update : null;
    if (update?.sessionUpdate !== "agent_message_chunk") return "";
    if (update.content?.type === "text") return normalizeText(update.content.text);
    return normalizeText(update.text);
  }).join("");
}

function normalizeLoopbackEndpoint(value) {
  let parsed;
  try { parsed = new URL(requireText(value, "CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy endpoint is required.")); } catch (error) {
    if (error?.code) throw error;
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy endpoint is invalid.");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname.toLowerCase())) {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "Managed CodeBuddy must use a loopback HTTP endpoint.");
  }
  return parsed.origin;
}

function requireText(value, code, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw protocolError(code, message);
  return text;
}
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function sanitizeDiagnosticText(value) {
  return normalizeText(value).slice(0, 300).replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}
function cryptoRandomUUID() { return crypto.randomUUID(); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }

module.exports = { CodeBuddyClient };
