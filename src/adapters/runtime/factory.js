"use strict";

const { createApiRuntimeAdapter } = require("./api");
const { createOpenCodeRuntimeAdapter } = require("./opencode");
const { createCodexRuntimeAdapter } = require("./codex");
const { createClaudeCodeRuntimeAdapter } = require("./claudecode");
const { createCodeBuddyRuntimeAdapter } = require("./codebuddy");
const { getRuntimeDefinition } = require("../../core/runtime-registry");

const DEFAULT_ADAPTER_FACTORIES = Object.freeze({
  "builtin-api": (options) => createApiRuntimeAdapter(options),
  opencode: (options) => createOpenCodeRuntimeAdapter(options),
  codex: (options) => createCodexRuntimeAdapter(options.config),
  claudecode: (options) => createClaudeCodeRuntimeAdapter(options.config),
  codebuddy: (options) => createCodeBuddyRuntimeAdapter(options),
});

function createRuntimeAdapter(options = {}) {
  const profileStore = requireProfileStore(options.profileStore);
  const profile = profileStore.getActive();
  if (!profile) {
    throw runtimeError("NO_ACTIVE_ENGINE", "No active model profile is configured. Open Control Center to verify and activate one.");
  }
  return createRuntimeAdapterForProfile({ ...options, profile, requireActive: true });
}

function createRuntimeAdapterForProfile({
  config = {},
  profileStore,
  vault,
  projectToolHost,
  profile,
  requireActive = false,
  adapterFactories = DEFAULT_ADAPTER_FACTORIES,
} = {}) {
  const store = requireProfileStore(profileStore);
  const selected = requireVerifiedProfile(profile);
  getRuntimeDefinition(selected.runtimeId);
  assertSelectedProfileStillValid(store, selected, requireActive);
  requireVault(vault);

  const actualGeneration = vault.getGeneration(selected.id);
  if (actualGeneration !== selected.secretGeneration) {
    invalidateProfile(store, selected.id, "credential_generation_changed");
    throw runtimeError("PROFILE_NOT_VERIFIED", "The selected profile credentials changed and must be verified again.");
  }

  let pendingSecrets;
  try {
    pendingSecrets = vault.read(selected.id);
  } catch (error) {
    invalidateProfile(store, selected.id, "credential_unavailable");
    throw error;
  }

  const construct = (secrets) => {
    assertSelectedProfileStillValid(store, selected, requireActive);
    if (vault.getGeneration(selected.id) !== selected.secretGeneration) {
      invalidateProfile(store, selected.id, "credential_generation_changed");
      throw runtimeError("PROFILE_NOT_VERIFIED", "The selected profile credentials changed and must be verified again.");
    }
    const factory = adapterFactories?.[selected.runtimeId];
    if (typeof factory !== "function") {
      throw runtimeError("INVALID_RUNTIME", "The selected runtime has no registered adapter factory.");
    }
    return factory({
      config: withProfile(config, selected),
      profile: { ...selected },
      secrets: isRecord(secrets) ? { ...secrets } : {},
      projectToolHost,
      profileStore: store,
    });
  };

  if (!isThenable(pendingSecrets)) return construct(pendingSecrets);
  return Promise.resolve(pendingSecrets).then(construct, (error) => {
    invalidateProfile(store, selected.id, "credential_unavailable");
    throw error;
  });
}

function withProfile(config, profile) {
  const source = isRecord(config) ? config : {};
  const provider = normalizeText(profile.options?.modelProvider)
    || (profile.providerId === "compatibility" ? "" : normalizeText(profile.providerId));
  return {
    ...source,
    runtime: profile.runtimeId,
    activeProfileId: profile.id,
    activeProviderProfile: { ...profile },
    codexModel: profile.modelId,
    codexModelProvider: provider,
    claudeModel: profile.modelId,
    codebuddyModel: profile.modelId,
  };
}

function assertSelectedProfileStillValid(store, selected, requireActive) {
  const current = typeof store.get === "function" ? store.get(selected.id) : selected;
  if (!current || current.status !== "verified") {
    throw runtimeError("PROFILE_NOT_VERIFIED", "The selected profile is no longer verified.");
  }
  if (current.runtimeId !== selected.runtimeId
    || current.modelId !== selected.modelId
    || current.secretGeneration !== selected.secretGeneration) {
    throw runtimeError("PROFILE_CHANGED", "The selected profile changed while its runtime was being created.");
  }
  if (requireActive && store.getActive()?.id !== selected.id) {
    throw runtimeError("ACTIVE_PROFILE_CHANGED", "The global active profile changed while its runtime was being created.");
  }
}

function requireVerifiedProfile(profile) {
  if (!isRecord(profile) || !normalizeText(profile.id)) {
    throw runtimeError("NO_ACTIVE_ENGINE", "No active model profile is configured. Open Control Center to verify and activate one.");
  }
  if (normalizeText(profile.status).toLowerCase() !== "verified") {
    throw runtimeError("PROFILE_NOT_VERIFIED", "The selected profile must be verified before it can run.");
  }
  return {
    ...profile,
    id: normalizeText(profile.id),
    runtimeId: normalizeText(profile.runtimeId).toLowerCase(),
    modelId: normalizeText(profile.modelId),
    providerId: normalizeText(profile.providerId).toLowerCase(),
    secretGeneration: normalizeGeneration(profile.secretGeneration),
  };
}

function requireProfileStore(value) {
  if (!value || typeof value.getActive !== "function") {
    throw new TypeError("createRuntimeAdapter requires a provider profile store.");
  }
  return value;
}

function requireVault(value) {
  if (!value || typeof value.read !== "function" || typeof value.getGeneration !== "function") {
    throw new TypeError("createRuntimeAdapter requires a credential vault.");
  }
}

function invalidateProfile(store, profileId, reason) {
  try {
    const result = store.markUnverified?.(profileId, reason);
    if (isThenable(result)) Promise.resolve(result).catch(() => {});
  } catch {}
}

function normalizeGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function isThenable(value) {
  return Boolean(value) && typeof value.then === "function";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimeError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

module.exports = {
  createRuntimeAdapter,
  createRuntimeAdapterForProfile,
  withProfile,
};
