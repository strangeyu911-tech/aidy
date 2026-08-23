const path = require("path");

const { AtomicJsonStore } = require("./atomic-json-store");

const JOB_STATES = new Set(["pending", "running", "generated", "failed", "paused"]);

class ReportQueueStore {
  constructor({ stateDir, filePath } = {}) {
    this.store = new AtomicJsonStore({
      filePath: filePath || path.join(stateDir, "reports", "index.json"),
      defaultValue: { schemaVersion: 1, reports: [] },
      normalize: normalizeReportIndex,
    });
  }

  list() {
    return this.store.read().reports.sort((left, right) => left.date.localeCompare(right.date));
  }

  get(date) {
    return this.list().find((item) => item.date === date) || null;
  }

  ensure(date, fields = {}) {
    const existing = this.get(date);
    if (existing) return existing;
    const report = normalizeReport({ date, status: "pending", ...fields });
    if (!report) throw new Error("invalid report date");
    this.store.update((index) => ({ ...index, reports: [...index.reports, report] }));
    return report;
  }

  update(date, patch) {
    let updated = null;
    this.store.update((index) => ({
      ...index,
      reports: index.reports.map((item) => {
        if (item.date !== date) return item;
        updated = normalizeReport({ ...item, ...patch, date, updatedAt: new Date().toISOString() });
        return updated || item;
      }),
    }));
    return updated;
  }
}

function normalizeReportIndex(value) {
  const reports = Array.isArray(value?.reports) ? value.reports.map(normalizeReport).filter(Boolean) : [];
  const deduped = [...new Map(reports.map((item) => [item.date, item])).values()];
  return { schemaVersion: 1, reports: deduped.sort((left, right) => left.date.localeCompare(right.date)) };
}

function normalizeReport(value) {
  const date = normalizeText(value?.date);
  const status = normalizeText(value?.status || "pending").toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !JOB_STATES.has(status)) return null;
  return {
    date,
    status,
    kind: normalizeText(value.kind) || "backfill",
    attempt: normalizeInteger(value.attempt),
    nextAttemptAt: normalizeIso(value.nextAttemptAt),
    generatedAt: normalizeIso(value.generatedAt),
    updatedAt: normalizeIso(value.updatedAt) || new Date().toISOString(),
    filePath: normalizeText(value.filePath),
    errorCode: normalizeText(value.errorCode),
  };
}

function normalizeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function normalizeIso(value) { const parsed = Date.parse(normalizeText(value)); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { JOB_STATES, ReportQueueStore, normalizeReport };
