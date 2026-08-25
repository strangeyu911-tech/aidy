"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { createRuntimeAdapterForProfile } = require("../adapters/runtime/factory");

const DEFAULT_VISION_TIMEOUT_MS = 30_000;
const DEFAULT_VISION_PROMPT = "Describe this image concisely for a text-only assistant. Include visible text, people, objects, scene context, and whether it looks like a reusable chat sticker. Return only the description.";
const TRANSIENT_CODES = new Set([
  "RATE_LIMITED",
  "MODEL_SERVICE_UNAVAILABLE",
  "NETWORK_ERROR",
  "TRANSPORT_ERROR",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);
const AUTHENTICATION_CODES = new Set(["INVALID_CREDENTIALS", "INVALID_SERVICE_CREDENTIALS"]);

class VisionFallback {
  constructor({
    config = {},
    profileStore,
    vault,
    projectToolHost,
    capture = null,
    timeoutMs = DEFAULT_VISION_TIMEOUT_MS,
    runVisionOperation = null,
    adapterFactory = createRuntimeAdapterForProfile,
    randomUUID = crypto.randomUUID,
  } = {}) {
    if (!profileStore || typeof profileStore.getActive !== "function" || typeof profileStore.get !== "function") {
      throw new TypeError("VisionFallback requires a provider profile store.");
    }
    if (runVisionOperation !== null && typeof runVisionOperation !== "function") {
      throw new TypeError("VisionFallback runVisionOperation must be a function.");
    }
    this.config = config;
    this.profileStore = profileStore;
    this.vault = vault;
    this.projectToolHost = projectToolHost;
    this.capture = capture;
    this.timeoutMs = Math.min(positiveInteger(timeoutMs, DEFAULT_VISION_TIMEOUT_MS), DEFAULT_VISION_TIMEOUT_MS);
    this.randomUUID = typeof randomUUID === "function" ? randomUUID : crypto.randomUUID;
    this.runVisionOperation = runVisionOperation || ((input) => runWithRuntimeAdapter({
      ...input,
      config: this.config,
      profileStore: this.profileStore,
      vault: this.vault,
      adapterFactory,
    }));
  }

  async describeAttachment({ attachment, parentTurn = {}, signal } = {}) {
    const operationId = normalizeText(this.randomUUID()) || crypto.randomUUID();
    const childAbort = createChildAbort(signal, this.timeoutMs);
    let profile = null;
    let attempts = 0;

    try {
      requireAttachment(attachment);
      profile = resolveVisionProfile(this.profileStore);
      await recordCapture(this.capture, await captureEvent({
        phase: "request",
        attachment,
        operationId,
        parentTurn,
        profile,
        requestText: DEFAULT_VISION_PROMPT,
      }));

      while (attempts < 2) {
        attempts += 1;
        throwIfChildAborted(childAbort);
        profile = revalidateVisionProfile(this.profileStore, profile);
        try {
          const result = await this.runVisionOperation({
            attachment,
            operationId,
            parentTurn,
            profile,
            prompt: DEFAULT_VISION_PROMPT,
            signal: childAbort.controller.signal,
            attempt: attempts,
          });
          throwIfChildAborted(childAbort);
          profile = revalidateVisionProfile(this.profileStore, profile);
          const description = normalizeText(result?.description ?? result?.text);
          if (!description) throw visionError("VISION_EMPTY_DESCRIPTION", "The vision profile returned no usable description.");
          const tokens = normalizeUsage(result?.usage);
          const usage = {
            operationId,
            parentTurnId: normalizeText(parentTurn?.id || parentTurn?.turnId),
            profileId: profile.id,
            tokens,
          };
          aggregateParentUsage(parentTurn, usage);
          await recordCapture(this.capture, await captureEvent({
            phase: "response",
            attachment,
            operationId,
            parentTurn,
            profile,
            responseText: description,
          }));
          return { ok: true, attachment, description, usage, attempts };
        } catch (error) {
          const normalized = normalizeVisionFailure(error, childAbort);
          if (AUTHENTICATION_CODES.has(error?.code)) {
            invalidateVisionProfile(this.profileStore, profile.id);
          }
          if (attempts < 2 && isTransientFailure(normalized) && !childAbort.controller.signal.aborted) {
            continue;
          }
          throw normalized;
        }
      }
      throw visionError("VISION_PROCESSING_FAILED", "The image could not be processed.");
    } catch (error) {
      const failure = normalizeVisionFailure(error, childAbort);
      await recordCapture(this.capture, await captureEvent({
        phase: "error",
        attachment,
        operationId,
        parentTurn,
        profile,
        errorCode: failure.code,
        errorText: failure.message,
      }));
      return {
        ok: false,
        attachment,
        attempts,
        error: {
          code: failure.code || "VISION_PROCESSING_FAILED",
          message: userFacingVisionMessage(failure),
        },
      };
    } finally {
      childAbort.cleanup();
    }
  }
}

async function runWithRuntimeAdapter({
  attachment,
  operationId,
  parentTurn,
  profile,
  prompt,
  signal,
  config,
  profileStore,
  vault,
  adapterFactory,
}) {
  const noTools = { listTools: () => [], invokeTool: async () => { throw visionError("VISION_TOOL_FORBIDDEN", "Vision preprocessing cannot invoke tools."); } };
  let adapter = null;
  let unsubscribe = () => {};
  try {
    adapter = await adapterFactory({
      config,
      profileStore,
      vault,
      projectToolHost: noTools,
      profile,
      requireActive: false,
    });
    const terminal = createRuntimeTerminalWaiter();
    unsubscribe = adapter.onEvent((event) => terminal.accept(event));
    await adapter.initialize({ signal });
    throwIfAborted(signal);
    const turn = await adapter.sendTurn({
      bindingKey: `vision-child:${normalizeText(parentTurn?.id || parentTurn?.turnId) || operationId}`,
      workspaceRoot: resolveVisionWorkspace(attachment, config),
      text: prompt,
      attachments: [normalizeRuntimeAttachment(attachment)],
      metadata: {
        childOperationId: operationId,
        parentTurnId: normalizeText(parentTurn?.id || parentTurn?.turnId),
        visionProfileId: profile.id,
      },
      model: profile.modelId,
    });
    terminal.bind(turn);
    const onAbort = () => {
      terminal.cancel();
      Promise.resolve(adapter.cancelTurn?.({ ...turn })).catch(() => {});
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      return await terminal.promise;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
  } finally {
    unsubscribe();
    if (adapter) await Promise.resolve(adapter.close?.()).catch(() => {});
  }
}

function createRuntimeTerminalWaiter() {
  const buffered = [];
  let turn = null;
  let lastText = "";
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const handle = (event) => {
    if (settled || !matchesRuntimeTurn(event, turn)) return;
    if (event.type === "runtime.reply.delta") lastText += String(event.payload?.text || "");
    if (event.type === "runtime.reply.completed") lastText = normalizeText(event.payload?.text) || lastText;
    if (event.type === "runtime.turn.completed") {
      settled = true;
      resolvePromise({
        description: normalizeText(event.payload?.text) || normalizeText(lastText),
        usage: normalizeUsage(event.payload?.usage),
      });
    } else if (event.type === "runtime.turn.failed") {
      settled = true;
      rejectPromise(visionError(event.payload?.code || "VISION_PROCESSING_FAILED", event.payload?.text || "Vision preprocessing failed."));
    }
  };

  return {
    promise,
    accept(event) {
      if (!turn) buffered.push(event);
      else handle(event);
    },
    bind(value) {
      turn = { threadId: normalizeText(value?.threadId), turnId: normalizeText(value?.turnId) };
      for (const event of buffered.splice(0)) handle(event);
    },
    cancel() {
      if (settled) return;
      settled = true;
      rejectPromise(visionError("CANCELLED", "Vision preprocessing was cancelled."));
    },
  };
}

function matchesRuntimeTurn(event, turn) {
  if (!event || !turn) return false;
  const threadId = normalizeText(event.payload?.threadId);
  const turnId = normalizeText(event.payload?.turnId);
  return (!turn.threadId || !threadId || turn.threadId === threadId)
    && (!turn.turnId || !turnId || turn.turnId === turnId);
}

function resolveVisionProfile(store) {
  const active = store.getActive();
  if (!active || active.status !== "verified") {
    throw visionError("NO_ACTIVE_ENGINE", "No verified global active profile is available.");
  }
  const visionProfileId = normalizeText(active.visionProfileId);
  if (!visionProfileId) {
    throw visionError("VISION_PROFILE_NOT_CONFIGURED", "No visual fallback profile is configured.");
  }
  assertNoVisionCycle(store, active.id, visionProfileId);
  const profile = store.get(visionProfileId);
  if (!profile) throw visionError("VISION_PROFILE_NOT_FOUND", "The configured visual fallback profile was deleted.");
  return requireVisionProfile(profile);
}

function revalidateVisionProfile(store, expected) {
  const current = store.get(expected.id);
  if (!current) throw visionError("VISION_PROFILE_NOT_FOUND", "The configured visual fallback profile was deleted.");
  const verified = requireVisionProfile(current);
  if (verified.secretGeneration !== expected.secretGeneration
    || verified.runtimeId !== expected.runtimeId
    || verified.modelId !== expected.modelId) {
    throw visionError("VISION_PROFILE_CHANGED", "The visual fallback profile changed during preprocessing.");
  }
  return verified;
}

function requireVisionProfile(profile) {
  if (normalizeText(profile?.status).toLowerCase() !== "verified") {
    throw visionError("VISION_PROFILE_NOT_VERIFIED", "The visual fallback profile must be verified again.");
  }
  const capabilities = isRecord(profile.capabilities) ? profile.capabilities : {};
  if (!(capabilities.imageInput === true || capabilities.nativeImageInput === true)) {
    throw visionError("VISION_PROFILE_NOT_CAPABLE", "The selected fallback profile is not verified for image input.");
  }
  return {
    ...profile,
    id: normalizeText(profile.id),
    runtimeId: normalizeText(profile.runtimeId),
    modelId: normalizeText(profile.modelId),
    secretGeneration: normalizeGeneration(profile.secretGeneration),
  };
}

function assertNoVisionCycle(store, activeProfileId, firstVisionProfileId) {
  const seen = new Set([normalizeText(activeProfileId)]);
  let cursor = normalizeText(firstVisionProfileId);
  while (cursor) {
    if (seen.has(cursor)) throw visionError("VISION_PROFILE_CYCLE", "Visual fallback profiles cannot reference themselves or form a cycle.");
    seen.add(cursor);
    cursor = normalizeText(store.get(cursor)?.visionProfileId);
  }
}

function createChildAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let reason = "";
  const onParentAbort = () => {
    reason = "cancelled";
    controller.abort();
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    reason = "timeout";
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    controller,
    get reason() { return reason; },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    },
  };
}

function throwIfChildAborted(childAbort) {
  if (!childAbort.controller.signal.aborted) return;
  if (childAbort.reason === "timeout") throw visionError("VISION_TIMEOUT", "Vision preprocessing exceeded its 30-second time limit.");
  throw visionError("VISION_CANCELLED", "Vision preprocessing was cancelled with its parent turn.");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw visionError("CANCELLED", "Vision preprocessing was cancelled.");
}

function normalizeVisionFailure(error, childAbort) {
  if (childAbort.reason === "timeout") return visionError("VISION_TIMEOUT", "Vision preprocessing exceeded its 30-second time limit.");
  if (childAbort.reason === "cancelled") return visionError("VISION_CANCELLED", "Vision preprocessing was cancelled with its parent turn.");
  if (AUTHENTICATION_CODES.has(error?.code)) return visionError("VISION_PROFILE_AUTH_FAILED", "The visual fallback profile credentials are no longer valid.");
  if (error?.code && String(error.code).startsWith("VISION_")) return error;
  if (error?.code === "NO_ACTIVE_ENGINE") return error;
  const normalized = visionError(error?.code || "VISION_PROCESSING_FAILED", "The image could not be processed.");
  normalized.cause = error;
  return normalized;
}

function isTransientFailure(error) {
  return TRANSIENT_CODES.has(error?.code);
}

function invalidateVisionProfile(store, profileId) {
  try {
    const result = store.markUnverified?.(profileId, "invalid_credentials");
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {}
}

function aggregateParentUsage(parentTurn, attribution) {
  if (!isRecord(parentTurn)) return;
  const usage = isRecord(parentTurn.usage) ? parentTurn.usage : {};
  const total = addUsage(usage.total, attribution.tokens);
  const byProfile = { ...(isRecord(usage.byProfile) ? usage.byProfile : {}) };
  byProfile[attribution.profileId] = addUsage(byProfile[attribution.profileId], attribution.tokens);
  parentTurn.usage = {
    ...usage,
    total,
    byProfile,
    childOperations: [
      ...(Array.isArray(usage.childOperations) ? usage.childOperations : []),
      { ...attribution, tokens: { ...attribution.tokens } },
    ],
  };
}

function addUsage(left, right) {
  return {
    inputTokens: nonNegativeInteger(left?.inputTokens) + nonNegativeInteger(right?.inputTokens),
    outputTokens: nonNegativeInteger(left?.outputTokens) + nonNegativeInteger(right?.outputTokens),
  };
}

function normalizeUsage(value) {
  return {
    inputTokens: nonNegativeInteger(value?.inputTokens),
    outputTokens: nonNegativeInteger(value?.outputTokens),
  };
}

async function captureEvent({ phase, attachment, operationId, parentTurn, profile, requestText, responseText, errorCode, errorText }) {
  const bytes = Buffer.isBuffer(attachment?.bytes) ? attachment.bytes : null;
  let byteLength = bytes?.length || nonNegativeInteger(attachment?.byteLength || attachment?.sizeBytes || attachment?.size);
  let sha256 = bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : normalizeText(attachment?.sha256);
  if (!sha256) {
    const filePath = normalizeText(attachment?.filePath || attachment?.absolutePath || attachment?.path);
    if (filePath) {
      try {
        const persistedBytes = await fs.readFile(filePath);
        byteLength = persistedBytes.length;
        sha256 = crypto.createHash("sha256").update(persistedBytes).digest("hex");
      } catch {}
    }
  }
  const imageMetadata = {
    mimeType: normalizeText(attachment?.contentType || attachment?.mimeType) || "application/octet-stream",
    byteLength,
    ...(sha256 ? { sha256 } : {}),
    ...(positiveIntegerOrZero(attachment?.width) ? { width: positiveIntegerOrZero(attachment.width) } : {}),
    ...(positiveIntegerOrZero(attachment?.height) ? { height: positiveIntegerOrZero(attachment.height) } : {}),
  };
  return {
    kind: "vision",
    phase,
    operationId,
    parentTurnId: normalizeText(parentTurn?.id || parentTurn?.turnId),
    profileId: normalizeText(profile?.id),
    imageMetadata,
    ...(requestText ? { requestText } : {}),
    ...(responseText ? { responseText } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorText ? { errorText } : {}),
  };
}

async function recordCapture(capture, event) {
  try {
    const result = typeof capture === "function" ? capture(event) : capture?.record?.(event);
    await Promise.resolve(result);
  } catch {}
}

function normalizeRuntimeAttachment(attachment) {
  return {
    ...attachment,
    filePath: normalizeText(attachment.filePath || attachment.absolutePath || attachment.path),
    mimeType: normalizeText(attachment.mimeType || attachment.contentType || attachment.mime),
    name: normalizeText(attachment.name || attachment.sourceFileName),
  };
}

function resolveVisionWorkspace(attachment, config) {
  const filePath = normalizeText(attachment?.filePath || attachment?.absolutePath || attachment?.path);
  return normalizeText(config?.workspaceRoot) || (filePath ? path.dirname(filePath) : process.cwd());
}

function requireAttachment(attachment) {
  if (!isRecord(attachment) || !normalizeText(attachment.filePath || attachment.absolutePath || attachment.path)) {
    throw visionError("VISION_ATTACHMENT_INVALID", "The saved image attachment is unavailable.");
  }
}

function userFacingVisionMessage(error) {
  const repair = {
    VISION_PROFILE_NOT_CONFIGURED: "Choose a verified vision-capable profile in Control Center.",
    VISION_PROFILE_NOT_FOUND: "Choose a new vision profile in Control Center.",
    VISION_PROFILE_NOT_VERIFIED: "Verify the vision profile again in Control Center.",
    VISION_PROFILE_NOT_CAPABLE: "Choose a profile verified for image input.",
    VISION_PROFILE_AUTH_FAILED: "Re-enter and verify the vision profile credentials.",
    VISION_PROFILE_CYCLE: "Remove the circular vision-profile reference in Control Center.",
    VISION_TIMEOUT: "The vision profile timed out; try the image again.",
    VISION_CANCELLED: "Image processing was cancelled with the request.",
  }[error?.code] || "Check the vision profile in Control Center and try again.";
  return `The image could not be processed. ${repair}`;
}

function normalizeGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntegerOrZero(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function visionError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

module.exports = {
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_TIMEOUT_MS,
  VisionFallback,
  aggregateParentUsage,
  isTransientFailure,
};
