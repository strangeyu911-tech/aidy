const crypto = require("crypto");
const path = require("path");

const { AtomicJsonStore } = require("./atomic-json-store");

const SOURCES = new Set(["random", "conversation", "context", "zhijiantime", "system_report"]);
const STATES = new Set(["pending", "completed", "superseded", "skipped", "failed"]);

class SupervisionPlanStore {
  constructor({ stateDir, filePath } = {}) {
    this.store = new AtomicJsonStore({
      filePath: filePath || path.join(stateDir, "supervision-plan.json"),
      defaultValue: { schemaVersion: 1, checkpoints: [] },
      normalize: normalizePlan,
    });
  }

  list({ state, includeRandom = true } = {}) {
    return this.store.read().checkpoints
      .filter((item) => !state || item.state === state)
      .filter((item) => includeRandom || item.source !== "random")
      .sort(compareCheckpoint);
  }

  add(checkpoint) {
    const normalized = normalizeCheckpoint({
      ...checkpoint,
      id: checkpoint?.id || crypto.randomUUID(),
      createdAt: checkpoint?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (!normalized) {
      throw new Error("invalid supervision checkpoint");
    }
    this.store.update((plan) => ({ ...plan, checkpoints: [...plan.checkpoints, normalized] }));
    return normalized;
  }

  update(id, patch) {
    let updated = null;
    this.store.update((plan) => ({
      ...plan,
      checkpoints: plan.checkpoints.map((checkpoint) => {
        if (checkpoint.id !== id) return checkpoint;
        updated = normalizeCheckpoint({ ...checkpoint, ...patch, id, updatedAt: new Date().toISOString() });
        return updated || checkpoint;
      }),
    }));
    return updated;
  }

  supersedeCanonical(canonicalTaskId, exceptId = "") {
    const changed = [];
    this.store.update((plan) => ({
      ...plan,
      checkpoints: plan.checkpoints.map((checkpoint) => {
        if (checkpoint.canonicalTaskId !== canonicalTaskId || checkpoint.id === exceptId || checkpoint.state !== "pending") {
          return checkpoint;
        }
        const next = { ...checkpoint, state: "superseded", outcome: "newer_arrangement", updatedAt: new Date().toISOString() };
        changed.push(next);
        return next;
      }),
    }));
    return changed;
  }

  due(now = new Date()) {
    const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(timestamp)) return [];
    return this.list({ state: "pending" }).filter((item) => Date.parse(item.dueAt) <= timestamp);
  }
}

function normalizePlan(value) {
  const checkpoints = Array.isArray(value?.checkpoints)
    ? value.checkpoints.map(normalizeCheckpoint).filter(Boolean).sort(compareCheckpoint)
    : [];
  return { schemaVersion: 1, checkpoints };
}

function normalizeCheckpoint(value) {
  if (!value || typeof value !== "object") return null;
  const id = normalizeText(value.id);
  const source = normalizeText(value.source).toLowerCase();
  const dueAt = normalizeIso(value.dueAt);
  const state = normalizeText(value.state || "pending").toLowerCase();
  if (!id || !SOURCES.has(source) || !dueAt || !STATES.has(state)) return null;
  return {
    id,
    canonicalTaskId: normalizeText(value.canonicalTaskId) || id,
    title: normalizeText(value.title) || defaultTitle(source),
    source,
    sourceRef: normalizeText(value.sourceRef),
    dueAt,
    timezone: normalizeText(value.timezone) || "Asia/Shanghai",
    state,
    outcome: normalizeText(value.outcome),
    announcedAt: normalizeIso(value.announcedAt),
    link: normalizeText(value.link),
    mutationFingerprint: normalizeText(value.mutationFingerprint),
    prompt: normalizeText(value.prompt),
    createdAt: normalizeIso(value.createdAt) || new Date().toISOString(),
    updatedAt: normalizeIso(value.updatedAt) || new Date().toISOString(),
  };
}

function compareCheckpoint(left, right) {
  return Date.parse(left?.dueAt || "") - Date.parse(right?.dueAt || "") || String(left?.id).localeCompare(String(right?.id));
}

function defaultTitle(source) {
  return source === "random" ? "随机查岗" : source === "system_report" ? "每日报表" : "跟进";
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SupervisionPlanStore, SOURCES, STATES, normalizeCheckpoint };
