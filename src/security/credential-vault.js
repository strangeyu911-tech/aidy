const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { AtomicJsonStore } = require("../core/atomic-json-store");
const windowsDpapi = require("./windows-dpapi");

const VAULT_SCHEMA_VERSION = 1;
const DEFAULT_VAULT = Object.freeze({ schemaVersion: VAULT_SCHEMA_VERSION, entries: [] });

class CredentialVault {
  constructor({ stateDir, filePath, protector = windowsDpapi, now = Date.now, logger = null, readRetryCount = 1, readRetryDelayMs = 100 } = {}) {
    const resolvedPath = filePath || (stateDir ? path.join(stateDir, "credential-vault.json") : "");
    if (!resolvedPath) throw makeError("Credential vault requires a file path.", "CREDENTIAL_VAULT_PATH_REQUIRED");
    requireProtector(protector);
    this.filePath = resolvedPath;
    this.protector = protector;
    this.now = now;
    this.logger = logger;
    this.readRetryCount = normalizeNonNegativeInteger(readRetryCount);
    this.readRetryDelayMs = normalizeNonNegativeInteger(readRetryDelayMs);
    this.corruptError = null;
    this.store = new AtomicJsonStore({
      filePath: resolvedPath,
      defaultValue: DEFAULT_VAULT,
      normalize: normalizeVault,
      onCorrupt: ({ error }) => { this.corruptError = error; },
    });
    this.mutation = Promise.resolve();
  }

  write(profileId, secrets) {
    const id = requireProfileId(profileId);
    const payload = normalizeSecrets(secrets);
    return this.#enqueue(async () => {
      const state = this.#readState();
      const previous = findEntry(state, id);
      const generation = (previous?.generation || 0) + 1;
      let ciphertext;
      try {
        ciphertext = await this.protector.protectText(JSON.stringify(payload));
      } catch (error) {
        throw wrapError(error, "Credential encryption failed.", "CREDENTIAL_ENCRYPT_FAILED");
      }
      if (typeof ciphertext !== "string" || !ciphertext) {
        throw makeError("Credential encryption returned no ciphertext.", "CREDENTIAL_ENCRYPT_FAILED");
      }
      this.store.write(replaceEntry(state, {
        profileId: id,
        generation,
        ciphertext,
        deleted: false,
        updatedAt: new Date(this.now()).toISOString(),
      }));

      const persisted = findEntry(this.#readState(), id);
      let verified;
      try {
        verified = JSON.parse(await this.protector.unprotectText(persisted.ciphertext));
      } catch (error) {
        throw wrapError(error, "Credential write verification failed.", "CREDENTIAL_WRITE_VERIFY_FAILED");
      }
      if (!sameJson(verified, payload)) {
        throw makeError("Credential write verification did not match the submitted value.", "CREDENTIAL_WRITE_VERIFY_FAILED");
      }
      return { generation };
    });
  }

  async read(profileId) {
    const id = requireProfileId(profileId);
    let lastError = null;
    for (let attempt = 0; attempt <= this.readRetryCount; attempt += 1) {
      const entry = findEntry(this.#readState(), id);
      if (!entry || entry.deleted) return null;
      try {
        const parsed = JSON.parse(await this.protector.unprotectText(entry.ciphertext));
        return normalizeSecrets(parsed);
      } catch (error) {
        lastError = error;
        this.logger?.warn?.("credential.decrypt_failed", buildDecryptDiagnostic({
          filePath: this.filePath,
          profileId: id,
          generation: entry.generation,
          ciphertext: entry.ciphertext,
          attempt,
          maxAttempts: this.readRetryCount + 1,
          error,
        }));
        if (attempt >= this.readRetryCount) break;
        await delay(this.readRetryDelayMs);
      }
    }
    throw wrapError(lastError, "Credential decryption failed.", "CREDENTIAL_DECRYPT_FAILED");
  }

  delete(profileId) {
    const id = requireProfileId(profileId);
    return this.#enqueue(async () => {
      const state = this.#readState();
      const previous = findEntry(state, id);
      const generation = (previous?.generation || 0) + 1;
      this.store.write(replaceEntry(state, {
        profileId: id,
        generation,
        ciphertext: "",
        deleted: true,
        updatedAt: new Date(this.now()).toISOString(),
      }));
      const persisted = findEntry(this.#readState(), id);
      if (!persisted?.deleted || persisted.generation !== generation || persisted.ciphertext) {
        throw makeError("Credential deletion could not be verified.", "CREDENTIAL_DELETE_VERIFY_FAILED");
      }
      return { generation };
    });
  }

  getGeneration(profileId) {
    const entry = findEntry(this.#readState(), requireProfileId(profileId));
    return entry?.generation || 0;
  }

  #readState() {
    const state = this.store.read();
    if (this.corruptError) {
      throw wrapError(this.corruptError, "Credential vault is corrupt and requires repair.", "CREDENTIAL_VAULT_CORRUPT");
    }
    return state;
  }

  #enqueue(operation) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.catch(() => {});
    return result;
  }
}

function normalizeVault(value) {
  if (!isRecord(value) || value.schemaVersion !== VAULT_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw makeError("Credential vault structure is invalid.", "CREDENTIAL_VAULT_CORRUPT");
  }
  const entries = value.entries.map(normalizeEntry);
  if (entries.some((entry) => !entry)) {
    throw makeError("Credential vault contains an invalid entry.", "CREDENTIAL_VAULT_CORRUPT");
  }
  const unique = new Map();
  for (const entry of entries) {
    if (unique.has(entry.profileId)) {
      throw makeError("Credential vault contains duplicate profile entries.", "CREDENTIAL_VAULT_CORRUPT");
    }
    unique.set(entry.profileId, entry);
  }
  return { schemaVersion: VAULT_SCHEMA_VERSION, entries: [...unique.values()] };
}

function normalizeEntry(value) {
  if (!isRecord(value)) return null;
  const profileId = normalizeText(value.profileId);
  const generation = Number.parseInt(String(value.generation ?? ""), 10);
  if (!profileId || !Number.isSafeInteger(generation) || generation < 1) return null;
  const deleted = value.deleted === true;
  const ciphertext = deleted ? "" : normalizeText(value.ciphertext);
  if (!deleted && !ciphertext) return null;
  const timestamp = Date.parse(normalizeText(value.updatedAt));
  return {
    profileId,
    generation,
    ciphertext,
    deleted,
    updatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
  };
}

function normalizeSecrets(value) {
  if (!isRecord(value)) throw makeError("Credentials must be an object.", "CREDENTIAL_INVALID");
  return clone(value);
}

function replaceEntry(state, entry) {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    entries: [...state.entries.filter((candidate) => candidate.profileId !== entry.profileId), entry],
  };
}

function findEntry(state, profileId) {
  return state.entries.find((entry) => entry.profileId === profileId) || null;
}

function requireProfileId(value) {
  const profileId = normalizeText(value);
  if (!profileId) throw makeError("Credential profile ID is required.", "CREDENTIAL_PROFILE_REQUIRED");
  return profileId;
}

function requireProtector(value) {
  if (!value || typeof value.protectText !== "function" || typeof value.unprotectText !== "function") {
    throw makeError("Credential vault requires a text protector.", "CREDENTIAL_PROTECTOR_REQUIRED");
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function buildDecryptDiagnostic({ filePath, profileId, generation, ciphertext, attempt, maxAttempts, error }) {
  let stat = null;
  try { stat = fs.statSync(filePath); } catch {}
  return {
    profileIdHash: hashDiagnosticValue(profileId),
    generation: normalizeNonNegativeInteger(generation),
    ciphertextSha256: hashDiagnosticValue(ciphertext),
    fileSize: stat?.size ?? null,
    fileMtimeMs: stat?.mtimeMs ?? null,
    attempt: normalizeNonNegativeInteger(attempt) + 1,
    maxAttempts: normalizeNonNegativeInteger(maxAttempts) || 1,
    errorClass: safeDiagnosticValue(error?.name) || "Error",
    errorCode: safeDiagnosticValue(error?.code),
    nativeErrorCode: safeDiagnosticValue(error?.nativeErrorCode) || safeDiagnosticValue(error?.cause?.nativeErrorCode),
    exceptionType: safeDiagnosticValue(error?.exceptionType) || safeDiagnosticValue(error?.cause?.exceptionType),
    fullyQualifiedErrorId: safeDiagnosticValue(error?.fullyQualifiedErrorId) || safeDiagnosticValue(error?.cause?.fullyQualifiedErrorId),
    causeClass: safeDiagnosticValue(error?.cause?.name),
    causeCode: safeDiagnosticValue(error?.cause?.code),
    processId: process.pid,
    parentProcessId: process.ppid,
    osUser: safeDiagnosticValue(process.env.USERNAME),
    userProfile: safeDiagnosticPath(process.env.USERPROFILE),
  };
}

function hashDiagnosticValue(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeDiagnosticValue(value) {
  const normalized = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^[A-Za-z0-9_.:-]{1,96}$/.test(normalized) ? normalized : null;
}

function safeDiagnosticPath(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= 260 ? normalized : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function makeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function wrapError(cause, message, code) {
  const error = makeError(message, code);
  error.cause = cause;
  return error;
}

module.exports = { CredentialVault, VAULT_SCHEMA_VERSION, normalizeVault };
