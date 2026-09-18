const fs = require("fs");
const path = require("path");

// Three presets instead of one wide 3-60 minute band. A band that wide made the
// product unpredictable: the user could not tell Aidy "check on me about every
// half hour" and get half-hour behaviour. Users pick a preset; the exact moment
// inside the band stays random so the check-in never feels like a fixed alarm.
const CHECKIN_PRESETS = Object.freeze([
  Object.freeze({
    id: "light",
    label: "轻陪伴",
    description: "大约每半小时到一小时半来一次，适合不想被频繁打断的人。",
    minMinutes: 30,
    maxMinutes: 90,
  }),
  Object.freeze({
    id: "standard",
    label: "标准",
    description: "大约每一刻钟到三刻钟来一次，默认档。",
    minMinutes: 15,
    maxMinutes: 45,
  }),
  Object.freeze({
    id: "close",
    label: "紧密",
    description: "大约每五分钟到二十分钟来一次，适合正在冲刺或严重拖延时。",
    minMinutes: 5,
    maxMinutes: 20,
  }),
]);

const DEFAULT_PRESET_ID = "standard";

// Kept as named constants for backwards compatibility. These now mirror the
// default preset (standard) rather than the old 3-60 minute band.
const DEFAULT_MIN_INTERVAL_MS = 15 * 60_000;
const DEFAULT_MAX_INTERVAL_MS = 45 * 60_000;

class CheckinConfigStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = normalizePersistedConfig(parsed);
    } catch {
      this.state = {};
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getRange(fallbackRange = resolveDefaultCheckinRange()) {
    this.load();
    return normalizeIntervalRange(this.state, fallbackRange);
  }

  setRange(range) {
    const normalized = normalizeIntervalRange(range);
    this.state = { ...normalized, presetId: detectCheckinPresetId(normalized) };
    this.save();
    return { ...normalized };
  }

  /**
   * Returns the active preset id. Falls back to matching the persisted range
   * against the preset table so existing users without `presetId` still get a
   * meaningful answer, and finally to a "custom" marker.
   */
  getPresetId() {
    this.load();
    const declared = normalizeText(this.state.presetId);
    if (declared === CUSTOM_PRESET_ID || resolveCheckinPreset(declared)) {
      return declared;
    }
    return detectCheckinPresetId(this.getRange()) || CUSTOM_PRESET_ID;
  }

  setPreset(presetId) {
    const preset = resolveCheckinPreset(presetId);
    if (!preset) {
      throw Object.assign(new Error(`未知的查岗频率档位：${presetId}`), { code: "CHECKIN_PRESET_UNKNOWN" });
    }
    return this.setRange({
      minIntervalMs: preset.minMinutes * 60_000,
      maxIntervalMs: preset.maxMinutes * 60_000,
    });
  }
}

const CUSTOM_PRESET_ID = "custom";

function listCheckinPresets() {
  return CHECKIN_PRESETS.map((preset) => ({ ...preset }));
}

const CHECKIN_PRESET_ALIASES = Object.freeze({
  少: "light",
  轻松: "light",
  轻: "light",
  中: "standard",
  适中: "standard",
  正常: "standard",
  多: "close",
  频繁: "close",
  密: "close",
  严格: "close",
});

/**
 * Resolves a preset from an id ("standard"), the Chinese label ("标准"), a
 * prefix of it ("紧"), or a common alias ("频繁"). The WeChat help advertises
 * the Chinese labels, so label matching is part of the contract, not a nicety.
 */
function resolveCheckinPreset(presetId) {
  const normalized = normalizeText(presetId).toLowerCase();
  if (!normalized) return null;

  const exact = CHECKIN_PRESETS.find((preset) => (
    preset.id === normalized || preset.label.toLowerCase() === normalized
  ));
  if (exact) return exact;

  const aliased = CHECKIN_PRESET_ALIASES[normalized];
  if (aliased) {
    return CHECKIN_PRESETS.find((preset) => preset.id === aliased) || null;
  }

  const prefixes = CHECKIN_PRESETS.filter((preset) => preset.label.startsWith(normalized));
  return prefixes.length === 1 ? prefixes[0] : null;
}

function detectCheckinPresetId(range) {
  const normalized = normalizePersistedRange(range);
  if (!normalized) return "";
  const match = CHECKIN_PRESETS.find((preset) => (
    preset.minMinutes * 60_000 === normalized.minIntervalMs
    && preset.maxMinutes * 60_000 === normalized.maxIntervalMs
  ));
  return match ? match.id : CUSTOM_PRESET_ID;
}

function resolveDefaultPreset() {
  return resolveCheckinPreset(DEFAULT_PRESET_ID);
}

function resolveDefaultCheckinRange(env = process.env) {
  const preset = resolveDefaultPreset();
  const minIntervalMs = readIntervalMs(env?.CYBERBOSS_CHECKIN_MIN_INTERVAL_MS, preset.minMinutes * 60_000);
  const maxIntervalMs = Math.max(
    minIntervalMs,
    readIntervalMs(env?.CYBERBOSS_CHECKIN_MAX_INTERVAL_MS, preset.maxMinutes * 60_000)
  );
  return { minIntervalMs, maxIntervalMs };
}

function parseCheckinRangeMinutes(input) {
  const normalized = typeof input === "string" ? input.trim() : "";
  const match = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return null;
  }
  const minMinutes = Number.parseInt(match[1], 10);
  const maxMinutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes) || minMinutes <= 0 || maxMinutes <= 0 || maxMinutes < minMinutes) {
    return null;
  }
  return { minMinutes, maxMinutes };
}

function normalizePersistedConfig(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  const range = normalizePersistedRange(value);
  if (!range) {
    return {};
  }
  const presetId = normalizeText(value.presetId).toLowerCase();
  return presetId ? { ...range, presetId } : { ...range };
}

function normalizePersistedRange(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const minIntervalMs = normalizePositiveInteger(value.minIntervalMs);
  const maxIntervalMs = normalizePositiveInteger(value.maxIntervalMs);
  if (!minIntervalMs || !maxIntervalMs) {
    return null;
  }
  return {
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, maxIntervalMs),
  };
}

function normalizeIntervalRange(value, fallbackRange = resolveDefaultCheckinRange()) {
  const fallback = normalizePersistedRange(fallbackRange) || {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  };
  const normalized = normalizePersistedRange(value);
  return normalized || fallback;
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readIntervalMs(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CHECKIN_PRESETS,
  CUSTOM_PRESET_ID,
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_PRESET_ID,
  detectCheckinPresetId,
  listCheckinPresets,
  parseCheckinRangeMinutes,
  resolveCheckinPreset,
  resolveDefaultCheckinRange,
  resolveDefaultPreset,
};
