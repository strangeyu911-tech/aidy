"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { AtomicJsonStore } = require("./atomic-json-store");

const DEFAULT_PERSONA_PACK_STATE = Object.freeze({
  schemaVersion: 1,
  activeId: "",
  updatedAt: "",
});

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

class PersonaPackStore {
  constructor({ stateDir = "", filePath = "", packsDirs = [] } = {}) {
    this.stateDir = normalizeText(stateDir);
    this.packsDirs = (Array.isArray(packsDirs) ? packsDirs : [])
      .map((item) => normalizeText(item))
      .filter(Boolean);
    this.store = new AtomicJsonStore({
      filePath: normalizeText(filePath) || path.join(this.stateDir, "persona-pack.json"),
      defaultValue: DEFAULT_PERSONA_PACK_STATE,
      normalize: normalizePersonaPackState,
    });
  }

  getActiveId() {
    return this.store.read().activeId;
  }

  listPackages() {
    const byId = new Map();
    for (const dir of this.packsDirs) {
      for (const pack of readPackagesFromDir(dir)) {
        byId.set(pack.id, pack);
      }
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  setActiveId(id) {
    const raw = normalizeText(id);
    const normalized = normalizePackId(raw);
    if (raw && !normalized) {
      throw Object.assign(new Error(`Invalid persona pack id: ${raw}`), {
        code: "PERSONA_PACK_INVALID",
      });
    }
    if (normalized && !this.listPackages().some((pack) => pack.id === normalized)) {
      throw Object.assign(new Error(`Unknown persona pack: ${normalized}`), {
        code: "PERSONA_PACK_UNKNOWN",
      });
    }
    return this.store.update((state) => ({
      ...state,
      activeId: normalized,
      updatedAt: new Date().toISOString(),
    }));
  }

  resolveActiveFile() {
    const activeId = this.getActiveId();
    if (!activeId) {
      return "";
    }
    const pack = this.listPackages().find((item) => item.id === activeId);
    return pack ? pack.filePath : "";
  }

  snapshot() {
    return {
      activeId: this.getActiveId(),
      packages: this.listPackages().map((pack) => ({
        id: pack.id,
        name: pack.name,
        description: pack.description,
      })),
    };
  }
}

function normalizePersonaPackState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: 1,
    activeId: normalizePackId(input.activeId),
    updatedAt: normalizeIsoTime(input.updatedAt),
  };
}

function normalizePackId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  return PACK_ID_PATTERN.test(normalized) ? normalized : "";
}

function readPackagesFromDir(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) {
      continue;
    }
    const id = normalizePackId(entry.name.replace(/\.md$/i, ""));
    if (!id) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    packs.push({ id, filePath, ...readPackMetadata(filePath, id) });
  }
  return packs;
}

function readPackMetadata(filePath, fallbackName) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const front = parseFrontMatter(raw);
  const heading = raw.match(/^#\s+(.+)$/m);
  return {
    name: normalizeText(front.name) || normalizeText(heading?.[1]) || fallbackName,
    description: normalizeText(front.description),
  };
}

function parseFrontMatter(raw) {
  const match = String(raw || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!pair) {
      continue;
    }
    result[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

function normalizeIsoTime(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_PERSONA_PACK_STATE,
  PACK_ID_PATTERN,
  PersonaPackStore,
  normalizePersonaPackState,
  normalizePackId,
  parseFrontMatter,
  readPackagesFromDir,
};
