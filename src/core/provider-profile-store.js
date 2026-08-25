"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { AtomicJsonStore } = require("./atomic-json-store");
const { getRuntimeDefinition } = require("./runtime-registry");

const PROFILE_SCHEMA_VERSION = 1;
const DEFAULT_PROVIDER_PROFILES = Object.freeze({
  schemaVersion: PROFILE_SCHEMA_VERSION,
  activeProfileId: "",
  profiles: [],
});
const PROFILE_STATUSES = new Set(["draft", "verified", "unverified"]);
const DRAFT_FIELDS = Object.freeze([
  "name",
  "runtimeId",
  "ownershipMode",
  "providerId",
  "protocolId",
  "baseUrl",
  "options",
  "modelId",
  "modelVariant",
  "visionProfileId",
  "secretRefs",
  "catalogMetadata",
]);
const FINGERPRINT_FIELDS = Object.freeze([
  "runtimeId",
  "ownershipMode",
  "providerId",
  "protocolId",
  "baseUrl",
  "options",
  "modelId",
  "modelVariant",
  "visionProfileId",
  "secretGeneration",
]);
const SENSITIVE_FIELD_NAMES = new Set([
  "apikey",
  "authorization",
  "ciphertext",
  "password",
  "secret",
  "servicepassword",
  "sensitiveheaders",
]);

class ProviderProfileStore {
  constructor({ stateDir, filePath, onCorrupt, now = () => new Date(), randomUUID = crypto.randomUUID } = {}) {
    const resolvedFilePath = normalizeText(filePath)
      || (normalizeText(stateDir) ? path.join(stateDir, "provider-profiles.json") : "");
    if (!resolvedFilePath) {
      throw new TypeError("ProviderProfileStore requires stateDir or filePath.");
    }
    this.now = now;
    this.randomUUID = randomUUID;
    this.store = new AtomicJsonStore({
      filePath: resolvedFilePath,
      defaultValue: DEFAULT_PROVIDER_PROFILES,
      normalize: normalizeProviderProfiles,
      onCorrupt,
    });
  }

  get(id) {
    const normalizedId = normalizeText(id);
    return this.store.read().profiles.find((profile) => profile.id === normalizedId) || null;
  }

  listMasked() {
    return this.store.read().profiles.map(maskProfile);
  }

  upsertDraft(input) {
    const source = isRecord(input) ? input : {};
    const requestedId = normalizeText(source.id);
    const profileId = requestedId || this.randomUUID();
    const now = this.nowIso();
    let updated = null;

    this.store.update((state) => {
      const existing = state.profiles.find((profile) => profile.id === profileId) || null;
      const draftFields = pickDraftFields(source);
      const candidate = normalizeProviderProfile({
        ...(existing || {}),
        ...draftFields,
        id: profileId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });
      if (!candidate) {
        throw Object.assign(new Error("A valid registered runtime is required for a provider profile."), {
          code: "INVALID_PROFILE",
        });
      }

      const verificationStillMatches = existing?.status === "verified"
        && existing.verifiedFingerprint
        && existing.verifiedFingerprint === computeVerificationFingerprint(candidate);
      updated = verificationStillMatches
        ? { ...candidate, status: "verified", verificationError: "" }
        : clearVerification(candidate, "draft", "");

      const profiles = existing
        ? state.profiles.map((profile) => (profile.id === profileId ? updated : profile))
        : [...state.profiles, updated];
      return {
        ...state,
        activeProfileId: verificationStillMatches ? state.activeProfileId : clearIfEqual(state.activeProfileId, profileId),
        profiles,
      };
    });
    return updated;
  }

  markVerified(id, result = {}) {
    const profileId = normalizeText(id);
    const secretGeneration = normalizeNonNegativeInteger(result.secretGeneration);
    let updated = null;

    this.store.update((state) => {
      const existing = requireProfile(state, profileId);
      const candidate = normalizeProviderProfile({
        ...existing,
        secretGeneration,
        capabilities: sanitizeNonSecretValue(result.capabilities),
        verifiedAt: normalizeIso(result.verifiedAt) || this.nowIso(),
        updatedAt: this.nowIso(),
      });
      const fingerprint = computeVerificationFingerprint(candidate);
      const suppliedFingerprint = normalizeFingerprint(result.fingerprint);
      if (suppliedFingerprint && suppliedFingerprint !== fingerprint) {
        throw Object.assign(new Error("Verification result does not match the current profile."), {
          code: "VERIFICATION_MISMATCH",
        });
      }
      updated = {
        ...candidate,
        status: "verified",
        verifiedFingerprint: fingerprint,
        verificationError: "",
      };
      return replaceProfile(state, updated);
    });
    return updated;
  }

  markUnverified(id, reason = "") {
    const profileId = normalizeText(id);
    let updated = null;
    this.store.update((state) => {
      const existing = requireProfile(state, profileId);
      updated = clearVerification({ ...existing, updatedAt: this.nowIso() }, "unverified", normalizeText(reason));
      return {
        ...replaceProfile(state, updated),
        activeProfileId: clearIfEqual(state.activeProfileId, profileId),
      };
    });
    return updated;
  }

  activate(id) {
    const profileId = normalizeText(id);
    let active = null;
    this.store.update((state) => {
      const profile = requireProfile(state, profileId);
      const fingerprintMatches = profile.verifiedFingerprint
        && profile.verifiedFingerprint === computeVerificationFingerprint(profile);
      if (profile.status !== "verified" || !fingerprintMatches) {
        throw Object.assign(new Error("Provider profile must be verified before activation."), {
          code: "PROFILE_NOT_VERIFIED",
        });
      }
      active = profile;
      return { ...state, activeProfileId: profileId };
    });
    return active;
  }

  delete(id) {
    const profileId = normalizeText(id);
    let deleted = false;
    this.store.update((state) => {
      deleted = state.profiles.some((profile) => profile.id === profileId);
      if (!deleted) return state;
      return {
        ...state,
        activeProfileId: clearIfEqual(state.activeProfileId, profileId),
        profiles: state.profiles.filter((profile) => profile.id !== profileId),
      };
    });
    return deleted;
  }

  getActive() {
    const state = this.store.read();
    if (!state.activeProfileId) return null;
    return state.profiles.find((profile) => profile.id === state.activeProfileId) || null;
  }

  nowIso() {
    const value = this.now();
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }
}

function normalizeProviderProfiles(value) {
  const source = isRecord(value) ? value : {};
  const candidates = Array.isArray(source.profiles) ? source.profiles : [];
  const profilesById = new Map();
  for (const candidate of candidates) {
    const profile = normalizeProviderProfile(candidate);
    if (!profile) continue;
    const fingerprintMatches = profile.verifiedFingerprint
      && profile.verifiedFingerprint === computeVerificationFingerprint(profile);
    profilesById.set(
      profile.id,
      profile.status === "verified" && fingerprintMatches
        ? profile
        : profile.status === "verified"
          ? clearVerification(profile, "draft", "")
          : profile,
    );
  }
  const profiles = [...profilesById.values()];
  const activeProfileId = normalizeText(source.activeProfileId);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    activeProfileId: activeProfile?.status === "verified" ? activeProfileId : "",
    profiles,
  };
}

function normalizeProviderProfile(value) {
  if (!isRecord(value)) return null;
  const id = normalizeText(value.id);
  if (!id) return null;

  let runtimeId;
  try {
    runtimeId = getRuntimeDefinition(value.runtimeId).id;
  } catch {
    return null;
  }
  const status = normalizeStatus(value.status);
  return {
    id,
    name: normalizeText(value.name),
    runtimeId,
    ownershipMode: normalizeText(value.ownershipMode).toLowerCase(),
    providerId: normalizeText(value.providerId).toLowerCase(),
    protocolId: normalizeText(value.protocolId).toLowerCase(),
    baseUrl: normalizeText(value.baseUrl),
    options: sanitizeNonSecretValue(value.options),
    modelId: normalizeText(value.modelId),
    modelVariant: normalizeText(value.modelVariant),
    visionProfileId: normalizeText(value.visionProfileId),
    secretRefs: normalizeSecretRefs(value.secretRefs),
    secretGeneration: normalizeNonNegativeInteger(value.secretGeneration),
    status,
    verifiedFingerprint: normalizeFingerprint(value.verifiedFingerprint),
    capabilities: sanitizeNonSecretValue(value.capabilities),
    verificationError: normalizeText(value.verificationError),
    catalogMetadata: sanitizeNonSecretValue(value.catalogMetadata),
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt),
    verifiedAt: normalizeIso(value.verifiedAt),
  };
}

function computeVerificationFingerprint(profile) {
  const normalized = normalizeProviderProfile({
    ...(isRecord(profile) ? profile : {}),
    id: normalizeText(profile?.id) || "fingerprint",
  });
  if (!normalized) {
    throw Object.assign(new Error("Cannot fingerprint an invalid provider profile."), {
      code: "INVALID_PROFILE",
    });
  }
  const covered = Object.fromEntries(FINGERPRINT_FIELDS.map((field) => [field, normalized[field]]));
  return crypto.createHash("sha256").update(stableStringify(covered)).digest("hex");
}

function maskProfile(profile) {
  const { secretRefs, ...masked } = profile;
  return {
    ...masked,
    hasApiKey: Boolean(secretRefs.apiKey),
    hasSensitiveHeaders: Object.keys(secretRefs.sensitiveHeaders).length > 0,
  };
}

function pickDraftFields(source) {
  return Object.fromEntries(DRAFT_FIELDS.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]));
}

function normalizeSecretRefs(value) {
  const source = isRecord(value) ? value : {};
  const headerSource = isRecord(source.sensitiveHeaders) ? source.sensitiveHeaders : {};
  const sensitiveHeaders = Object.fromEntries(
    Object.entries(headerSource)
      .map(([name, reference]) => [normalizeText(name), normalizeText(reference)])
      .filter(([name, reference]) => name && reference),
  );
  return {
    apiKey: normalizeText(source.apiKey),
    servicePassword: normalizeText(source.servicePassword),
    sensitiveHeaders,
  };
}

function sanitizeNonSecretValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeNonSecretValue);
  if (!isRecord(value)) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
      ? value
      : null;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD_NAMES.has(key.replace(/[-_\s]/g, "").toLowerCase()))
      .map(([key, item]) => [key, sanitizeNonSecretValue(item)]),
  );
}

function clearVerification(profile, status, reason) {
  return {
    ...profile,
    status,
    verifiedFingerprint: "",
    capabilities: {},
    verificationError: reason,
    verifiedAt: "",
  };
}

function replaceProfile(state, updated) {
  return {
    ...state,
    profiles: state.profiles.map((profile) => (profile.id === updated.id ? updated : profile)),
  };
}

function requireProfile(state, profileId) {
  const profile = state.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw Object.assign(new Error("Provider profile was not found."), { code: "PROFILE_NOT_FOUND" });
  }
  return profile;
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  return PROFILE_STATUSES.has(status) ? status : "draft";
}

function normalizeFingerprint(value) {
  const fingerprint = normalizeText(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : "";
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clearIfEqual(value, expected) {
  return value === expected ? "" : value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

module.exports = {
  DEFAULT_PROVIDER_PROFILES,
  PROFILE_SCHEMA_VERSION,
  ProviderProfileStore,
  computeVerificationFingerprint,
  normalizeProviderProfiles,
};
