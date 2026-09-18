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
    // list() -> store.read() is served from the AtomicJsonStore read cache when the
    // file is unchanged, so repeated per-second due() polling does not re-parse the
    // whole plan. The remaining in-memory filter over pending checkpoints is O(n)
    // but cheap and acceptable; we deliberately keep it rather than maintain a
    // separate pending-only index.
    return this.list({ state: "pending" }).filter((item) => Date.parse(item.dueAt) <= timestamp);
  }

  // Remove finished (non-pending) checkpoints whose updatedAt/createdAt is older than
  // now - keepDays. Pending checkpoints are never touched when keepPending is true
  // (the default); when keepPending is false, even pending ones may be pruned if stale.
  // Returns the number of checkpoints removed.
  prune({ keepDays = 30, keepPending = true, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (!Number.isFinite(timestamp)) throw new Error("prune requires a valid now");
    const cutoff = timestamp - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    this.store.update((plan) => {
      const kept = [];
      for (const checkpoint of plan.checkpoints) {
        const isPending = checkpoint.state === "pending";
        // With keepPending, never touch pending checkpoints regardless of age.
        if (keepPending && isPending) {
          kept.push(checkpoint);
          continue;
        }
        const ts = Date.parse(checkpoint.updatedAt) || Date.parse(checkpoint.createdAt);
        const expired = Number.isFinite(ts) && ts < cutoff;
        if (!expired) {
          kept.push(checkpoint);
          continue;
        }
        removed += 1;
      }
      return { ...plan, checkpoints: kept };
    });
    return removed;
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
    // Must survive a round-trip: an explicit request ("明天23:30提醒我") is
    // honoured even inside quiet hours, and the dispatcher reads this flag back
    // from disk long after the in-memory arrangement is gone.
    exemptQuietHours: value.exemptQuietHours === true,
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
