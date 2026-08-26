"use strict";

const { PUBLIC_ROUTES, decodeHealth, protocolError } = require("./protocol-adapter");

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

class CodeBuddyClient {
  constructor({ endpoint, servicePassword, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.endpoint = normalizeLoopbackEndpoint(endpoint);
    this.servicePassword = requireText(servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy service password is required.");
    if (typeof fetchImpl !== "function") throw new TypeError("CodeBuddyClient requires fetch.");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  }

  async probeCompatibility({ signal } = {}) {
    const body = await this.requestJson(PUBLIC_ROUTES.health, { method: "GET", signal });
    return decodeHealth(body);
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
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }

module.exports = { CodeBuddyClient };
