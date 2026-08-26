"use strict";

const crypto = require("node:crypto");

const PUBLIC_ROUTES = Object.freeze({
  health: "/api/v1/health",
  acpConnect: "/api/v1/acp/connect",
  acp: "/api/v1/acp",
});

function decodeHealth(value) {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const status = normalizeText(data.status).toLowerCase();
  if (!new Set(["ok", "healthy", "ready"]).has(status)) {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy health response is incompatible.");
  }
  return {
    ok: true,
    status,
    version: normalizeText(data.version || root.version),
  };
}

function decodeConnect(value) {
  const root = isRecord(value) ? value : {};
  const data = isRecord(root.data) ? root.data : root;
  const connectionId = normalizeText(data.connectionId);
  if (!connectionId || !normalizeText(data.sessionToken)) {
    throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP connect response is incompatible.");
  }
  return { connectionId };
}

function parseSseMessages(value) {
  const parser = createSseMessageParser();
  parser.push(String(value || ""));
  return parser.finish();
}

function createSseMessageParser({ onMessage } = {}) {
  const messages = [];
  let pending = "";
  let dataLines = [];

  return Object.freeze({
    push(value) {
      pending += String(value || "");
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consumeLine(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    finish() {
      if (pending) consumeLine(pending.replace(/\r$/, ""));
      pending = "";
      flushEvent();
      return messages.slice();
    },
  });

  function consumeLine(line) {
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  function flushEvent() {
    if (!dataLines.length) return;
    const text = dataLines.join("\n");
    dataLines = [];
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      throw protocolError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy ACP returned malformed SSE JSON.");
    }
    if (!isRecord(parsed)) return;
    messages.push(parsed);
    if (typeof onMessage === "function") onMessage(parsed);
  }
}

function fingerprintAccountIdentity(value) {
  const source = isRecord(value) ? value : {};
  const userId = normalizeText(source.userId);
  if (!userId) throw protocolError("CODEBUDDY_LOGIN_REQUIRED", "CodeBuddy login is required.");
  const canonical = JSON.stringify({
    userId,
    userName: normalizeText(source.userName),
    userNickname: normalizeText(source.userNickname),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function encodeNewSessionParams({ workingDirectory, version = "" } = {}) {
  const directory = normalizeText(workingDirectory);
  if (!directory) throw protocolError("CODEBUDDY_SESSION_FAILED", "CodeBuddy working directory is required.");
  if (/^2\.115\./.test(normalizeText(version))) {
    return { cwd: directory, mcpServers: [] };
  }
  return { workingDirectory: directory, mcpServers: [] };
}

function encodeResumeSessionParams({ sessionId, workingDirectory, version = "" } = {}) {
  const normalizedSessionId = normalizeText(sessionId);
  const directory = normalizeText(workingDirectory);
  if (!normalizedSessionId || !directory) {
    throw protocolError("CODEBUDDY_SESSION_FAILED", "CodeBuddy resume requires a session and working directory.");
  }
  if (/^2\.115\./.test(normalizeText(version))) {
    return { sessionId: normalizedSessionId, cwd: directory, mcpServers: [] };
  }
  return { sessionId: normalizedSessionId, workingDirectory: directory, mcpServers: [] };
}

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

module.exports = {
  PUBLIC_ROUTES,
  decodeConnect,
  decodeHealth,
  createSseMessageParser,
  encodeNewSessionParams,
  encodeResumeSessionParams,
  fingerprintAccountIdentity,
  parseSseMessages,
  protocolError,
};
