"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { computeVerificationFingerprint } = require("../core/provider-profile-store");

const ECHO_TOOL_NAME = "cyberboss_capability_echo";
const GLOB_TOOL_NAME = "glob";
const VERIFIER_SERVER_NAME = "cyberboss_verifier";
const SUPPORTED_RUNTIMES = new Set(["opencode", "codex", "claudecode"]);

class RuntimeProfileVerifier {
  constructor({
    profileStore,
    credentialVault,
    adapterFactory,
    stateDir,
    now = () => new Date(),
    randomUUID = crypto.randomUUID,
    eventTimeoutMs = 30_000,
    verificationServerPath = path.join(__dirname, "runtime-verification-mcp-server.js"),
  } = {}) {
    if (!profileStore || typeof profileStore.get !== "function" || typeof profileStore.markVerified !== "function") {
      throw new TypeError("RuntimeProfileVerifier requires a profile store.");
    }
    if (!credentialVault || typeof credentialVault.read !== "function" || typeof credentialVault.getGeneration !== "function") {
      throw new TypeError("RuntimeProfileVerifier requires a credential vault.");
    }
    if (typeof adapterFactory !== "function") throw new TypeError("RuntimeProfileVerifier requires an adapter factory.");
    if (!normalizeText(stateDir)) throw new TypeError("RuntimeProfileVerifier requires a state directory.");
    this.profileStore = profileStore;
    this.credentialVault = credentialVault;
    this.adapterFactory = adapterFactory;
    this.stateDir = path.resolve(stateDir);
    this.now = now;
    this.randomUUID = randomUUID;
    this.eventTimeoutMs = positiveInteger(eventTimeoutMs, 30_000);
    this.verificationServerPath = path.resolve(verificationServerPath);
  }

  async verify(profileId) {
    const id = normalizeText(profileId);
    let adapter = null;
    let workspaceRoot = "";
    let unsubscribe = () => {};
    try {
      const profile = this.profileStore.get(id);
      if (!profile) throw verifierError("PROFILE_NOT_FOUND", "The runtime profile was not found.");
      if (!SUPPORTED_RUNTIMES.has(profile.runtimeId)) {
        throw verifierError("UNSUPPORTED_RUNTIME", "This verifier supports optional runtime profiles only.");
      }
      const secretGeneration = this.credentialVault.getGeneration(id);
      const secrets = await this.credentialVault.read(id) || {};
      this.assertCredentialGeneration(id, secretGeneration);
      const startingFingerprint = computeVerificationFingerprint({ ...profile, secretGeneration });
      workspaceRoot = createVerificationWorkspace(this.stateDir);
      const verification = buildVerificationConfig({
        runtimeId: profile.runtimeId,
        workspaceRoot,
        token: normalizeText(this.randomUUID()) || crypto.randomUUID(),
        verificationServerPath: this.verificationServerPath,
      });
      adapter = await this.adapterFactory({
        profile: { ...profile, secretGeneration },
        secrets: { ...secrets },
        workspaceRoot,
        verification,
      });
      requireAdapter(adapter);

      const journal = new EventJournal();
      unsubscribe = adapter.onEvent((event) => {
        journal.push(event);
        if (event?.type === "runtime.approval.requested") {
          const decision = isAllowlistedApproval(event, verification) ? "accept" : "decline";
          if (decision === "decline") {
            journal.push({
              type: "runtime.verification.unsafe-approval",
              payload: { requestId: event?.payload?.requestId },
            });
          }
          Promise.resolve(adapter.respondApproval({
            requestId: event?.payload?.requestId,
            threadId: event?.payload?.threadId,
            decision,
            remember: false,
          })).catch((error) => journal.push({
            type: "runtime.verification.approval-failed",
            payload: { code: normalizeText(error?.code) || "APPROVAL_RESPONSE_FAILED" },
          }));
        }
      });

      await adapter.initialize();
      const probeTurn = await adapter.sendTurn({
        bindingKey: `runtime-verification:${id}`,
        workspaceRoot,
        text: verification.prompt,
        metadata: { purpose: "runtime-capability-verification" },
        model: profile.modelId,
      });
      await verifySuccessfulTurn({
        journal,
        turn: probeTurn,
        toolName: verification.toolName,
        timeoutMs: this.eventTimeoutMs,
      });

      const cancellationTurn = await adapter.sendTurn({
        bindingKey: `runtime-verification-cancel:${id}`,
        workspaceRoot,
        text: "CyberBoss cancellation verification: begin a deliberately long plain-text response and do not call tools.",
        metadata: { purpose: "runtime-cancellation-verification" },
        model: profile.modelId,
      });
      await journal.waitFor((events) => hasEvent(events, cancellationTurn, "runtime.turn.started"), this.eventTimeoutMs,
        "CANCELLATION_UNSUPPORTED", "The runtime did not start the cancellation probe.");
      await adapter.cancelTurn({ ...cancellationTurn, workspaceRoot });
      await journal.waitFor((events) => events.some((event) => (
        eventMatchesTurn(event, cancellationTurn)
        && event?.type === "runtime.turn.failed"
        && normalizeText(event?.payload?.code).toUpperCase() === "CANCELLED"
      )), this.eventTimeoutMs, "CANCELLATION_UNSUPPORTED", "The runtime did not acknowledge cancellation.");

      this.assertCredentialGeneration(id, secretGeneration);
      const currentProfile = this.profileStore.get(id);
      if (!currentProfile || computeVerificationFingerprint({ ...currentProfile, secretGeneration }) !== startingFingerprint) {
        throw verifierError("PROFILE_CHANGED", "The runtime profile changed during live verification.");
      }
      const capabilities = {
        authentication: true,
        modelAccess: true,
        streaming: true,
        tools: true,
        toolContinuation: true,
        cancellation: true,
        imageInput: false,
      };
      const verifiedAt = normalizeDate(this.now());
      const verified = this.profileStore.markVerified(id, {
        fingerprint: startingFingerprint,
        secretGeneration,
        capabilities,
        verifiedAt,
      });
      return {
        ok: true,
        fingerprint: verified.verifiedFingerprint,
        secretGeneration,
        capabilities,
        verifiedAt: verified.verifiedAt,
      };
    } catch (error) {
      const normalized = normalizeVerifierError(error);
      if (id && isAuthenticationError(error) && this.profileStore.get(id)) {
        this.profileStore.markUnverified(id, "invalid_credentials");
      }
      return { ok: false, error: { code: normalized.code, message: normalized.message } };
    } finally {
      unsubscribe();
      if (adapter) await Promise.resolve(adapter.close()).catch(() => {});
      removeVerificationWorkspace(workspaceRoot, this.stateDir);
    }
  }

  assertCredentialGeneration(profileId, expected) {
    if (this.credentialVault.getGeneration(profileId) !== expected) {
      throw verifierError("CREDENTIAL_CHANGED", "Credentials changed during live verification.");
    }
  }
}

class EventJournal {
  constructor() {
    this.events = [];
    this.waiters = new Set();
  }

  push(event) {
    if (!event || typeof event !== "object") return;
    this.events.push(event);
    for (const notify of this.waiters) notify();
  }

  async waitFor(predicate, timeoutMs, code, message) {
    if (predicate(this.events)) return;
    await new Promise((resolve, reject) => {
      const onChange = () => {
        if (!predicate(this.events)) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(verifierError(code, message));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(onChange);
      };
      this.waiters.add(onChange);
      onChange();
    });
  }
}

async function verifySuccessfulTurn({ journal, turn, toolName, timeoutMs }) {
  await journal.waitFor((events) => events.some((event) => (
    eventMatchesTurn(event, turn)
    && new Set(["runtime.turn.completed", "runtime.turn.failed"]).has(event?.type)
  )), timeoutMs, "MODEL_SERVICE_TIMEOUT", "The runtime verification turn did not finish.");
  const events = journal.events.filter((event) => eventMatchesTurn(event, turn));
  if (journal.events.some((event) => event?.type === "runtime.verification.unsafe-approval")) {
    throw verifierError("UNSAFE_TOOL_REQUESTED", "The runtime requested a tool outside the read-only verification allowlist.");
  }
  if (journal.events.some((event) => event?.type === "runtime.verification.approval-failed")) {
    throw verifierError("APPROVAL_RESPONSE_FAILED", "The runtime approval response could not be delivered.");
  }
  const failed = events.find((event) => event?.type === "runtime.turn.failed");
  if (failed) throw verifierError(normalizeText(failed?.payload?.code) || "MODEL_SERVICE_UNAVAILABLE", "The runtime verification turn failed.");
  if (!events.some((event) => event?.type === "runtime.turn.started")) {
    throw verifierError("RUNTIME_LIFECYCLE_INCOMPLETE", "The runtime did not report turn start.");
  }
  const startedIndex = events.findIndex((event) => (
    event?.type === "runtime.tool.started" && toolNameMatches(event?.payload?.toolName, toolName)
  ));
  if (startedIndex < 0) throw verifierError("TOOL_CALLING_UNSUPPORTED", "The runtime did not use the required read-only native tool.");
  const toolCallId = normalizeText(events[startedIndex]?.payload?.toolCallId);
  const completedIndex = events.findIndex((event, index) => index > startedIndex
    && event?.type === "runtime.tool.completed"
    && toolNameMatches(event?.payload?.toolName, toolName)
    && (!toolCallId || normalizeText(event?.payload?.toolCallId) === toolCallId)
    && event?.payload?.isError !== true);
  if (completedIndex < 0) throw verifierError("TOOL_RESULT_UNAVAILABLE", "The runtime did not report a successful tool result.");
  const continuation = events.findIndex((event, index) => index > completedIndex
    && event?.type === "runtime.reply.delta"
    && Boolean(normalizeText(event?.payload?.text)));
  if (continuation < 0) throw verifierError("TOOL_CONTINUATION_UNSUPPORTED", "The runtime did not stream text after the tool result.");
}

function buildVerificationConfig({ runtimeId, workspaceRoot, token, verificationServerPath }) {
  const useGlob = runtimeId === "opencode";
  const toolName = useGlob ? GLOB_TOOL_NAME : ECHO_TOOL_NAME;
  return {
    readOnly: true,
    runtimeId,
    serverName: VERIFIER_SERVER_NAME,
    toolName,
    token,
    workspaceRoot,
    mcpServer: useGlob ? null : {
      name: VERIFIER_SERVER_NAME,
      command: process.execPath,
      args: [verificationServerPath, "--token", token],
      env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      required: true,
      startupTimeoutSec: 10,
      toolTimeoutSec: 10,
      autoApproveTools: [ECHO_TOOL_NAME],
    },
    prompt: useGlob
      ? `Call the native ${GLOB_TOOL_NAME} tool exactly once with the read-only pattern "${token}.cyberboss-verification-no-match". After the tool result, stream a short acknowledgement.`
      : `Call the MCP tool ${ECHO_TOOL_NAME} exactly once with value "${token}". After the tool result, stream a short acknowledgement.`,
  };
}

function isAllowlistedApproval(event, verification) {
  const payload = event?.payload || {};
  const toolName = normalizeText(payload.toolName);
  if (toolNameMatches(toolName, verification.toolName)) return true;
  const tokens = Array.isArray(payload.commandTokens) ? payload.commandTokens.map(normalizeText) : [];
  if (verification.runtimeId === "opencode") {
    return tokens.length > 0 && tokens[0].toLowerCase() === GLOB_TOOL_NAME;
  }
  return tokens.join("__").toLowerCase().endsWith(`__${ECHO_TOOL_NAME}`);
}

function eventMatchesTurn(event, turn) {
  const payload = event?.payload || {};
  const expectedThread = normalizeText(turn?.threadId);
  const expectedTurn = normalizeText(turn?.turnId);
  const actualThread = normalizeText(payload.threadId);
  const actualTurn = normalizeText(payload.turnId);
  return (!expectedThread || !actualThread || expectedThread === actualThread)
    && (!expectedTurn || !actualTurn || expectedTurn === actualTurn);
}

function hasEvent(events, turn, type) {
  return events.some((event) => event?.type === type && eventMatchesTurn(event, turn));
}

function toolNameMatches(actual, expected) {
  const normalizedActual = normalizeText(actual).toLowerCase();
  const normalizedExpected = normalizeText(expected).toLowerCase();
  return normalizedActual === normalizedExpected || normalizedActual.endsWith(`__${normalizedExpected}`);
}

function createVerificationWorkspace(stateDir) {
  const parent = path.join(stateDir, "runtime-verification");
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "probe-"));
}

function removeVerificationWorkspace(workspaceRoot, stateDir) {
  if (!normalizeText(workspaceRoot)) return;
  const root = path.resolve(workspaceRoot);
  const parent = path.resolve(stateDir, "runtime-verification");
  const relative = path.relative(parent, root);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // A just-closed Windows runtime may briefly retain a file handle. The
    // workspace remains isolated under stateDir and contains no credentials.
  }
}

function requireAdapter(adapter) {
  for (const method of ["onEvent", "initialize", "sendTurn", "cancelTurn", "respondApproval", "close"]) {
    if (!adapter || typeof adapter[method] !== "function") {
      throw verifierError("RUNTIME_INCOMPATIBLE", `The runtime adapter is missing ${method}.`);
    }
  }
}

function isAuthenticationError(error) {
  const code = normalizeText(error?.code).toUpperCase();
  const name = normalizeText(error?.name).toLowerCase();
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return code === "INVALID_CREDENTIALS" || code === "PROVIDER_AUTH_ERROR"
    || name === "providerautherror" || status === 401 || status === 403;
}

function normalizeVerifierError(error) {
  if (isAuthenticationError(error)) return verifierError("INVALID_CREDENTIALS", "The runtime rejected the configured credentials.");
  const code = normalizeText(error?.code).toUpperCase() || "MODEL_SERVICE_UNAVAILABLE";
  const messages = {
    PROFILE_NOT_FOUND: "The runtime profile was not found.",
    UNSUPPORTED_RUNTIME: "The selected runtime is not supported by this verifier.",
    TOOL_CALLING_UNSUPPORTED: "The runtime did not use the required read-only tool.",
    TOOL_RESULT_UNAVAILABLE: "The runtime did not report a successful tool result.",
    TOOL_CONTINUATION_UNSUPPORTED: "The runtime did not stream text after the tool result.",
    UNSAFE_TOOL_REQUESTED: "The runtime requested an operation outside the verification allowlist.",
    APPROVAL_RESPONSE_FAILED: "The runtime approval response could not be delivered.",
    CANCELLATION_UNSUPPORTED: "The runtime did not acknowledge cancellation.",
    CREDENTIAL_CHANGED: "Credentials changed during verification; run it again.",
    PROFILE_CHANGED: "The profile changed during verification; run it again.",
    MODEL_SERVICE_TIMEOUT: "The runtime verification request timed out.",
  };
  return verifierError(code, messages[code] || "Runtime verification failed.");
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function verifierError(code, message) { return Object.assign(new Error(message), { code }); }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = {
  ECHO_TOOL_NAME,
  GLOB_TOOL_NAME,
  RuntimeProfileVerifier,
  VERIFIER_SERVER_NAME,
  buildVerificationConfig,
  isAllowlistedApproval,
};
