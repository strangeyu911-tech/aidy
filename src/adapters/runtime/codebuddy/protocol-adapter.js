"use strict";

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

function protocolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

module.exports = { PUBLIC_ROUTES, decodeHealth, protocolError };
