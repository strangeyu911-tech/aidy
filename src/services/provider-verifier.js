"use strict";

const { computeVerificationFingerprint } = require("../core/provider-profile-store");
const { createProtocolClient } = require("../adapters/runtime/api/protocol-client");

const ECHO_TOOL_NAME = "cyberboss_capability_echo";
const VERIFICATION_TOKEN = "verification-token";
const ECHO_TOOL = Object.freeze({
  name: ECHO_TOOL_NAME,
  description: "Return the supplied synthetic verification value unchanged.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
    required: Object.freeze(["value"]),
    additionalProperties: false,
  }),
});

class ProviderVerifier {
  constructor({
    profileStore,
    credentialVault,
    clientFactory = createProtocolClient,
    fetchImpl = globalThis.fetch,
    capture = null,
    imageProbe = null,
    now = () => new Date(),
    cancellationDelayMs = 25,
  } = {}) {
    if (!profileStore || typeof profileStore.get !== "function" || typeof profileStore.markVerified !== "function") {
      throw new TypeError("ProviderVerifier requires a profile store.");
    }
    if (!credentialVault || typeof credentialVault.read !== "function" || typeof credentialVault.getGeneration !== "function") {
      throw new TypeError("ProviderVerifier requires a credential vault.");
    }
    if (typeof clientFactory !== "function") throw new TypeError("ProviderVerifier clientFactory must be a function.");
    if (imageProbe !== null && typeof imageProbe !== "function") throw new TypeError("ProviderVerifier imageProbe must be a function.");
    this.profileStore = profileStore;
    this.credentialVault = credentialVault;
    this.clientFactory = clientFactory;
    this.fetchImpl = fetchImpl;
    this.capture = capture;
    this.imageProbe = imageProbe;
    this.now = now;
    this.cancellationDelayMs = positiveInteger(cancellationDelayMs, 25);
  }

  async verify(profileId) {
    const id = normalizeText(profileId);
    try {
      const profile = this.profileStore.get(id);
      if (!profile) throw verifierError("PROFILE_NOT_FOUND", "The provider profile was not found.");
      if (profile.runtimeId !== "builtin-api") {
        throw verifierError("UNSUPPORTED_RUNTIME", "This verifier supports built-in API profiles only.");
      }

      const secretGeneration = this.credentialVault.getGeneration(id);
      const secrets = await this.credentialVault.read(id) || {};
      this.assertCredentialGeneration(id, secretGeneration);
      const startingFingerprint = computeVerificationFingerprint({ ...profile, secretGeneration });
      const client = this.clientFactory({
        profile,
        secrets,
        fetchImpl: this.fetchImpl,
        capture: this.capture,
      });
      requireClient(client);

      const models = await client.listModels({});
      if (!Array.isArray(models) || !models.some((model) => normalizeText(model?.id) === profile.modelId)) {
        throw verifierError("MODEL_UNAVAILABLE", "The selected model is not available from the live provider catalog.");
      }
      const selectedModel = models.find((model) => normalizeText(model?.id) === profile.modelId);

      const streamDeltas = [];
      const streamResult = await client.streamTurn({
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with a short acknowledgement for an Aidy streaming capability test." }] }],
        tools: [],
        onDelta: (text) => streamDeltas.push(text),
      });
      if (!streamDeltas.join("") || !assistantText(streamResult)) {
        throw verifierError("STREAMING_UNSUPPORTED", "The model did not produce streamed assistant text.");
      }

      const toolResult = await client.streamTurn({
        messages: [{
          role: "user",
          content: [{ type: "text", text: `Call ${ECHO_TOOL_NAME} exactly once with value ${VERIFICATION_TOKEN}.` }],
        }],
        tools: [ECHO_TOOL],
      });
      const echoCall = Array.isArray(toolResult?.toolCalls)
        ? toolResult.toolCalls.find((call) => call?.name === ECHO_TOOL_NAME)
        : null;
      if (!echoCall) throw verifierError("TOOL_CALLING_UNSUPPORTED", "The model did not issue the required native tool call.");
      if (echoCall.arguments?.value !== VERIFICATION_TOKEN) {
        throw verifierError("TOOL_CALL_MALFORMED", "The model issued malformed capability tool arguments.");
      }

      const continuationDeltas = [];
      const continuation = await client.streamTurn({
        messages: [
          { role: "user", content: [{ type: "text", text: `Call ${ECHO_TOOL_NAME} exactly once with value ${VERIFICATION_TOKEN}.` }] },
          { ...toolResult.message, toolCalls: toolResult.toolCalls },
          {
            role: "tool",
            toolCallId: echoCall.id,
            name: ECHO_TOOL_NAME,
            content: [{ type: "text", text: JSON.stringify({ value: echoCall.arguments.value }) }],
          },
        ],
        tools: [ECHO_TOOL],
        onDelta: (text) => continuationDeltas.push(text),
      });
      if (!continuationDeltas.join("") || !assistantText(continuation)) {
        throw verifierError("TOOL_CONTINUATION_UNSUPPORTED", "The model did not continue after the tool result.");
      }

      await verifyCancellation(client, this.cancellationDelayMs);
      const imageInput = await this.verifyImageOptional({ client, profile, selectedModel });
      this.assertCredentialGeneration(id, secretGeneration);
      const currentProfile = this.profileStore.get(id);
      if (!currentProfile || computeVerificationFingerprint({ ...currentProfile, secretGeneration }) !== startingFingerprint) {
        throw verifierError("PROFILE_CHANGED", "The provider profile changed during live verification.");
      }

      const capabilities = {
        authentication: true,
        modelAccess: true,
        streaming: true,
        tools: true,
        toolContinuation: true,
        cancellation: true,
        imageInput,
      };
      const verifiedAt = normalizeDate(this.now());
      const fingerprint = computeVerificationFingerprint({ ...currentProfile, secretGeneration });
      const verified = this.profileStore.markVerified(id, {
        fingerprint,
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
      if (normalized.code === "INVALID_CREDENTIALS" && id && this.profileStore.get(id)) {
        this.profileStore.markUnverified(id, "invalid_credentials");
      }
      return {
        ok: false,
        error: { code: normalized.code, message: normalized.message },
      };
    }
  }

  assertCredentialGeneration(profileId, expected) {
    if (this.credentialVault.getGeneration(profileId) !== expected) {
      throw verifierError("CREDENTIAL_CHANGED", "Credentials changed during live verification; verification must be repeated.");
    }
  }

  async verifyImageOptional({ client, profile, selectedModel }) {
    const advertised = Array.isArray(selectedModel?.inputModalities)
      && selectedModel.inputModalities.some((modality) => normalizeText(modality).toLowerCase() === "image");
    if (!this.imageProbe) return advertised;
    try {
      return (await this.imageProbe({ client, profile: { ...profile } })) === true;
    } catch {
      return false;
    }
  }
}

async function verifyCancellation(client, delayMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), delayMs);
  try {
    await client.streamTurn({
      messages: [{ role: "user", content: [{ type: "text", text: "Aidy cancellation probe: provide a deliberately considered response." }] }],
      tools: [],
      signal: controller.signal,
    });
    throw verifierError("CANCELLATION_UNSUPPORTED", "The provider request completed without observing cancellation.");
  } catch (error) {
    if (error?.code !== "CANCELLED") throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireClient(client) {
  if (!client || typeof client.listModels !== "function" || typeof client.streamTurn !== "function") {
    throw verifierError("INCOMPATIBLE_PROTOCOL", "The provider protocol client is incomplete.");
  }
}

function assistantText(result) {
  return (Array.isArray(result?.message?.content) ? result.message.content : [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function normalizeVerifierError(error) {
  const code = normalizeText(error?.code) || "MODEL_SERVICE_UNAVAILABLE";
  const messages = {
    PROFILE_NOT_FOUND: "The provider profile was not found.",
    UNSUPPORTED_RUNTIME: "The selected runtime cannot be verified by the built-in API verifier.",
    INVALID_CREDENTIALS: "The provider rejected the configured credentials.",
    MODEL_UNAVAILABLE: "The selected model is unavailable.",
    STREAMING_UNSUPPORTED: "The model does not provide usable streamed text.",
    TOOL_CALLING_UNSUPPORTED: "The model does not provide the required native tool call.",
    TOOL_CALL_MALFORMED: "The model returned malformed tool arguments.",
    TOOL_CONTINUATION_UNSUPPORTED: "The model cannot continue after a tool result.",
    CANCELLATION_UNSUPPORTED: "The provider request could not be cancelled.",
    CREDENTIAL_CHANGED: "Credentials changed during verification; run verification again.",
    PROFILE_CHANGED: "The profile changed during verification; run verification again.",
    RATE_LIMITED: "The provider rate-limited the verification request.",
    QUOTA_EXHAUSTED: "The provider account has insufficient quota or credits.",
    MODEL_SERVICE_TIMEOUT: "The provider verification request timed out.",
    CANCELLED: "Provider verification was cancelled.",
    INCOMPATIBLE_PROTOCOL: "The provider returned an incompatible response.",
    MODEL_SERVICE_UNAVAILABLE: "The model service is unavailable.",
  };
  return verifierError(code, messages[code] || "Provider verification failed.");
}

function verifierError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ECHO_TOOL,
  ProviderVerifier,
};
