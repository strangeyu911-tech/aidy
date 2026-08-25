const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { AtomicJsonStore } = require("../core/atomic-json-store");
const windowsDpapi = require("./windows-dpapi");

const CAPTURE_SCHEMA_VERSION = 1;
const MAX_DURATION_MS = 15 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_PLAINTEXT_BYTES = 1024 * 1024;
const EMPTY_CAPTURE = Object.freeze({ schemaVersion: CAPTURE_SCHEMA_VERSION, capture: null });
const SECRET_KEY = /^(?:authorization|proxyAuthorization|apiKey|servicePassword|password|token|secret|ciphertext|sensitiveHeaders)$/i;
const HEADER_CONTAINER_KEY = /headers$/i;
const IMAGE_PAYLOAD_KEY = /^(?:bytes|base64|imageBytes|imageBase64|imageData)$/i;

class DiagnosticCapture {
  constructor({
    stateDir,
    filePath,
    protector = windowsDpapi,
    now = Date.now,
    maxPlaintextBytes = MAX_PLAINTEXT_BYTES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    const resolvedPath = filePath || (stateDir ? path.join(stateDir, "diagnostic-capture.json") : "");
    if (!resolvedPath) throw makeError("Diagnostic capture requires a file path.", "DIAGNOSTIC_CAPTURE_PATH_REQUIRED");
    requireProtector(protector);
    this.filePath = resolvedPath;
    this.protector = protector;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.expiryTimer = null;
    this.maxPlaintextBytes = Math.max(1, Math.min(MAX_PLAINTEXT_BYTES, Number(maxPlaintextBytes) || MAX_PLAINTEXT_BYTES));
    this.corruptError = null;
    this.store = new AtomicJsonStore({
      filePath: resolvedPath,
      defaultValue: EMPTY_CAPTURE,
      normalize: normalizeCaptureState,
      onCorrupt: ({ error }) => { this.corruptError = error; },
    });
    this.mutation = Promise.resolve();
    try { this.#schedule(this.#readState().capture); } catch { /* Operations expose corruption explicitly. */ }
  }

  enable({ scope, durationMs } = {}) {
    const normalizedScope = normalizeText(scope);
    if (!normalizedScope) throw makeError("Diagnostic capture scope is required.", "DIAGNOSTIC_CAPTURE_SCOPE_REQUIRED");
    const requestedDuration = Number(durationMs);
    if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
      throw makeError("Diagnostic capture duration must be positive.", "DIAGNOSTIC_CAPTURE_DURATION_INVALID");
    }
    return this.#enqueue(async () => {
      const startedAtMs = Number(this.now());
      const expiresAtMs = startedAtMs + Math.min(requestedDuration, MAX_DURATION_MS);
      const capture = {
        scope: normalizedScope,
        startedAt: new Date(startedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        deleteAt: new Date(startedAtMs + RETENTION_MS).toISOString(),
        active: true,
        ciphertext: await this.#protectRecords([]),
      };
      this.store.write({ schemaVersion: CAPTURE_SCHEMA_VERSION, capture });
      await this.#verifyPersisted([]);
      this.#schedule(capture);
      return publicStatus(capture);
    });
  }

  record(event) {
    return this.#enqueue(async () => {
      const state = this.#readState();
      const capture = state.capture;
      if (!capture) return false;
      const now = this.now();
      if (now >= Date.parse(capture.deleteAt)) {
        this.#removeFile();
        return false;
      }
      if (!capture.active || now >= Date.parse(capture.expiresAt)) {
        if (capture.active) {
          const disabled = { ...capture, active: false };
          this.store.write({ ...state, capture: disabled });
          this.#schedule(disabled);
        }
        return false;
      }

      const records = await this.#decryptRecords(capture.ciphertext);
      const sanitized = sanitizeEvent(event);
      const next = [...records, sanitized];
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > this.maxPlaintextBytes) return false;
      const updated = { ...capture, ciphertext: await this.#protectRecords(next) };
      this.store.write({ schemaVersion: CAPTURE_SCHEMA_VERSION, capture: updated });
      await this.#verifyPersisted(next);
      this.#schedule(updated);
      return true;
    });
  }

  async read() {
    const state = this.#readState();
    const capture = state.capture;
    if (!capture) return [];
    if (this.now() >= Date.parse(capture.deleteAt)) {
      this.#removeFile();
      return [];
    }
    return this.#decryptRecords(capture.ciphertext);
  }

  disable() {
    return this.#enqueue(async () => {
      const state = this.#readState();
      if (!state.capture || !state.capture.active) return false;
      const disabled = { ...state.capture, active: false };
      this.store.write({ ...state, capture: disabled });
      this.#schedule(disabled);
      return true;
    });
  }

  delete() {
    return this.#enqueue(async () => {
      const existed = fs.existsSync(this.filePath);
      this.#removeFile();
      return existed;
    });
  }

  cleanupExpired() {
    return this.#enqueue(async () => {
      const state = this.#readState();
      if (!state.capture) return false;
      const now = this.now();
      if (now >= Date.parse(state.capture.deleteAt)) {
        this.#removeFile();
        return true;
      }
      if (state.capture.active && now >= Date.parse(state.capture.expiresAt)) {
        const disabled = { ...state.capture, active: false };
        this.store.write({ ...state, capture: disabled });
        this.#schedule(disabled);
      } else {
        this.#schedule(state.capture);
      }
      return false;
    });
  }

  async #protectRecords(records) {
    try {
      const ciphertext = await this.protector.protectText(JSON.stringify(records));
      if (typeof ciphertext !== "string" || !ciphertext) throw new Error("empty ciphertext");
      return ciphertext;
    } catch (error) {
      throw wrapError(error, "Diagnostic capture encryption failed.", "DIAGNOSTIC_CAPTURE_ENCRYPT_FAILED");
    }
  }

  async #decryptRecords(ciphertext) {
    try {
      const plaintext = await this.protector.unprotectText(ciphertext);
      if (Buffer.byteLength(plaintext, "utf8") > this.maxPlaintextBytes) throw new Error("capture exceeds plaintext limit");
      const records = JSON.parse(plaintext);
      if (!Array.isArray(records)) throw new Error("capture payload is not a list");
      return records;
    } catch (error) {
      throw wrapError(error, "Diagnostic capture decryption failed.", "DIAGNOSTIC_CAPTURE_DECRYPT_FAILED");
    }
  }

  async #verifyPersisted(expected) {
    const persisted = this.#readState().capture;
    if (!persisted) throw makeError("Diagnostic capture write could not be verified.", "DIAGNOSTIC_CAPTURE_WRITE_VERIFY_FAILED");
    const actual = await this.#decryptRecords(persisted.ciphertext);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw makeError("Diagnostic capture write verification did not match.", "DIAGNOSTIC_CAPTURE_WRITE_VERIFY_FAILED");
    }
  }

  #readState() {
    const state = this.store.read();
    if (this.corruptError) {
      throw wrapError(this.corruptError, "Diagnostic capture is corrupt.", "DIAGNOSTIC_CAPTURE_CORRUPT");
    }
    return state;
  }

  #removeFile() {
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    fs.rmSync(this.filePath, { force: true });
    this.corruptError = null;
  }

  #schedule(capture) {
    if (this.expiryTimer !== null) this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    if (!capture) return;
    const boundary = capture.active ? Math.min(Date.parse(capture.expiresAt), Date.parse(capture.deleteAt)) : Date.parse(capture.deleteAt);
    const delay = Math.max(0, boundary - this.now());
    this.expiryTimer = this.setTimer(async () => {
      this.expiryTimer = null;
      try { await this.cleanupExpired(); } catch { /* Fail closed; the next operation reports the error. */ }
    }, delay);
    this.expiryTimer?.unref?.();
  }

  #enqueue(operation) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.catch(() => {});
    return result;
  }
}

function sanitizeEvent(value) {
  const source = isRecord(value) ? value : { value };
  if (normalizeText(source.kind).toLowerCase() !== "vision") return sanitizeValue(source);
  const bytes = findImageBytes(source);
  const sanitized = Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => !IMAGE_PAYLOAD_KEY.test(key))
      .map(([key, item]) => [key, sanitizeValue(item, key)]),
  );
  const suppliedMetadata = normalizeImageMetadata(source.imageMetadata);
  delete sanitized.imageMetadata;
  sanitized.image = bytes.length ? {
      mimeType: normalizeText(source.mimeType) || suppliedMetadata.mimeType || "application/octet-stream",
      byteLength: bytes.length,
      ...(positiveInteger(source.width) ? { width: positiveInteger(source.width) } : {}),
      ...(positiveInteger(source.height) ? { height: positiveInteger(source.height) } : {}),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    } : suppliedMetadata;
  return sanitized;
}

function normalizeImageMetadata(value) {
  const source = isRecord(value) ? value : {};
  const sha256 = normalizeText(source.sha256).toLowerCase();
  return {
    mimeType: normalizeText(source.mimeType) || "application/octet-stream",
    byteLength: positiveInteger(source.byteLength),
    ...(positiveInteger(source.width) ? { width: positiveInteger(source.width) } : {}),
    ...(positiveInteger(source.height) ? { height: positiveInteger(source.height) } : {}),
    ...(sha256 && /^[a-f0-9]{64}$/.test(sha256) ? { sha256 } : {}),
  };
}

function sanitizeValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (HEADER_CONTAINER_KEY.test(key)) return "[REDACTED]";
  if (Buffer.isBuffer(value)) {
    return { byteLength: value.length, sha256: crypto.createHash("sha256").update(value).digest("hex") };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]));
  }
  if (typeof value === "string") {
    const dataImage = describeDataImage(value);
    return dataImage || redactSecretStrings(value);
  }
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value ?? "");
}

function findImageBytes(event) {
  for (const key of ["bytes", "imageBytes", "imageData"]) {
    if (Buffer.isBuffer(event[key])) return event[key];
  }
  for (const key of ["base64", "imageBase64"]) {
    if (typeof event[key] === "string") {
      try { return Buffer.from(event[key], "base64"); } catch { return Buffer.alloc(0); }
    }
  }
  return Buffer.alloc(0);
}

function describeDataImage(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  return {
    mimeType: match[1].toLowerCase(),
    byteLength: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

function redactSecretStrings(value) {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function normalizeCaptureState(value) {
  if (!isRecord(value) || value.schemaVersion !== CAPTURE_SCHEMA_VERSION || !(value.capture === null || isRecord(value.capture))) {
    throw makeError("Diagnostic capture structure is invalid.", "DIAGNOSTIC_CAPTURE_CORRUPT");
  }
  const capture = normalizeCapture(value.capture);
  if (value.capture !== null && !capture) {
    throw makeError("Diagnostic capture metadata is invalid.", "DIAGNOSTIC_CAPTURE_CORRUPT");
  }
  return { schemaVersion: CAPTURE_SCHEMA_VERSION, capture };
}

function normalizeCapture(value) {
  if (!isRecord(value)) return null;
  const scope = normalizeText(value.scope);
  const startedAt = normalizeIso(value.startedAt);
  const expiresAt = normalizeIso(value.expiresAt);
  const deleteAt = normalizeIso(value.deleteAt);
  const ciphertext = normalizeText(value.ciphertext);
  if (!scope || !startedAt || !expiresAt || !deleteAt || !ciphertext) return null;
  return { scope, startedAt, expiresAt, deleteAt, active: value.active === true, ciphertext };
}

function publicStatus(capture) {
  const { ciphertext, ...status } = capture;
  return status;
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function requireProtector(value) {
  if (!value || typeof value.protectText !== "function" || typeof value.unprotectText !== "function") {
    throw makeError("Diagnostic capture requires a text protector.", "DIAGNOSTIC_CAPTURE_PROTECTOR_REQUIRED");
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function makeError(message, code) {
  return Object.assign(new Error(message), { code });
}

function wrapError(cause, message, code) {
  const error = makeError(message, code);
  error.cause = cause;
  return error;
}

module.exports = {
  CAPTURE_SCHEMA_VERSION,
  DiagnosticCapture,
  MAX_DURATION_MS,
  MAX_PLAINTEXT_BYTES,
  RETENTION_MS,
  sanitizeEvent,
};
