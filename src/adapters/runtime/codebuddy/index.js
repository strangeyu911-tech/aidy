"use strict";

const { CodeBuddyClient } = require("./client");
const { locateCodeBuddyDistribution } = require("./distribution-locator");
const { CodeBuddyProcessHost } = require("./process-host");

async function verifyCodeBuddyTestOk({
  config = {},
  profile,
  secrets = {},
  locateDistribution = locateCodeBuddyDistribution,
  processHostFactory = (options) => new CodeBuddyProcessHost(options),
  clientFactory = (options) => new CodeBuddyClient(options),
} = {}) {
  const normalizedProfile = requireCodeBuddyProfile(profile);
  const stateDir = requireText(config.stateDir, "INVALID_PROFILE", "CodeBuddy verification requires a state directory.");
  const workspaceRoot = requireText(config.workspaceRoot, "INVALID_PROFILE", "CodeBuddy verification requires a workspace.");
  const servicePassword = requireText(secrets.servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy gateway password is unavailable.");
  const distribution = await locateDistribution({
    explicitExecutablePath: normalizeText(normalizedProfile.options.executablePath),
  });
  const host = processHostFactory({ stateDir });
  let client = null;
  try {
    const started = await host.start({ distribution, workspaceRoot, servicePassword });
    client = clientFactory({
      endpoint: started.endpoint,
      servicePassword,
      cliVersion: distribution.version,
      timeoutMs: positiveInteger(config.codebuddyVerificationTimeoutMs, 120_000),
    });
    const verified = await client.runTestOk({ workingDirectory: workspaceRoot });
    if (normalizedProfile.modelId !== verified.modelId) {
      throw runtimeError("CODEBUDDY_MODEL_UNAVAILABLE", "CodeBuddy did not use the selected verification model.");
    }
    const identityFingerprint = normalizeText(verified.identityFingerprint).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(identityFingerprint)) {
      throw runtimeError("CODEBUDDY_LOGIN_REQUIRED", "CodeBuddy login identity could not be verified.");
    }
    return Object.freeze({
      ok: true,
      text: "TEST_OK",
      runtimeId: "codebuddy",
      source: normalizeText(distribution.source),
      sourceLabel: normalizeText(distribution.sourceLabel),
      cliVersion: normalizeText(distribution.version),
      modelId: normalizedProfile.modelId,
      identityFingerprint,
      health: sanitizeHealth(started.health),
    });
  } finally {
    if (client) await client.disconnect().catch(() => {});
    await Promise.resolve(host?.stop?.()).catch(() => {});
  }
}

function requireCodeBuddyProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  if (normalizeText(source.runtimeId).toLowerCase() !== "codebuddy" || !normalizeText(source.modelId)) {
    throw runtimeError("INVALID_PROFILE", "A complete CodeBuddy profile is required.");
  }
  return {
    runtimeId: "codebuddy",
    modelId: normalizeText(source.modelId),
    options: source.options && typeof source.options === "object" ? { ...source.options } : {},
  };
}

function sanitizeHealth(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    ok: source.ok === true,
    status: normalizeText(source.status),
    ...(normalizeText(source.version) ? { version: normalizeText(source.version) } : {}),
  });
}

function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function requireText(value, code, message) { const text = normalizeText(value); if (!text) throw runtimeError(code, message); return text; }
function runtimeError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { verifyCodeBuddyTestOk };
