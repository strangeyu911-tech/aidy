const fs = require("fs");
const path = require("path");

const { ReportQueueStore } = require("../core/report-queue-store");

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];

class ReportScheduler {
  constructor({ stateDir, desktopStateStore, timelineIntegration, logger, now = () => new Date(), healthyDelayMs = 60_000, onGenerated = null } = {}) {
    this.stateDir = stateDir;
    this.desktopStateStore = desktopStateStore;
    this.timelineIntegration = timelineIntegration;
    this.logger = logger;
    this.now = now;
    this.healthyDelayMs = healthyDelayMs;
    this.onGenerated = onGenerated;
    this.queueStore = new ReportQueueStore({ stateDir });
    this.healthySince = 0;
    this.timer = null;
    this.running = false;
    this.currentDate = "";
    this.currentAbortController = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((error) => {
      this.logger?.error("reports.tick_failed", { code: error.code || "REPORT_TICK_FAILED" });
    }), 30_000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setRuntimeHealthy(healthy) {
    if (healthy && !this.healthySince) this.healthySince = Date.now();
    if (!healthy) this.healthySince = 0;
  }

  async tick() {
    if (this.running) return;
    const settings = this.desktopStateStore.get();
    if (!settings.reportEnabled || settings.desiredState === "stopped") return;
    this.ensureMissingJobs(this.now(), settings.reportTime);
    if (!this.healthySince || Date.now() - this.healthySince < this.healthyDelayMs) return;
    if (settings.backfillPaused) return;
    const now = this.now();
    const job = this.queueStore.list().find((item) => (
      item.status === "pending"
      && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now.getTime())
    ));
    if (!job) return;
    await this.runJob(job);
  }

  ensureMissingJobs(now, reportTime) {
    if (!isReportDue(now, reportTime)) return [];
    const dates = previousCalendarDates(now, 7);
    return dates.sort().map((date, index) => this.queueStore.ensure(date, {
      kind: index === dates.length - 1 ? "daily" : "backfill",
    }));
  }

  async runJob(job) {
    this.running = true;
    this.currentDate = job.date;
    this.currentAbortController = new AbortController();
    this.queueStore.update(job.date, { status: "running", attempt: job.attempt + 1, errorCode: "" });
    try {
      const reportsDir = path.join(this.stateDir, "reports");
      fs.mkdirSync(reportsDir, { recursive: true });
      const outputFile = path.join(reportsDir, `${job.date}.png`);
      await this.timelineIntegration.runSubcommand("build", ["--locale", "zh-CN"], { signal: this.currentAbortController.signal });
      const result = await this.timelineIntegration.runSubcommand("screenshot", [
        "--output", outputFile,
        "--selector", "main",
        "--range", "day",
        "--date", job.date,
        "--locale", "zh-CN",
      ], { signal: this.currentAbortController.signal });
      this.queueStore.update(job.date, {
        status: "generated",
        generatedAt: new Date().toISOString(),
        nextAttemptAt: "",
        filePath: result.outputFile || outputFile,
      });
      this.logger?.info("reports.generated", { date: job.date, kind: job.kind });
      try {
        await this.onGenerated?.({ date: job.date, kind: job.kind, filePath: result.outputFile || outputFile });
      } catch (backupError) {
        this.logger?.error("reports.post_generation_backup_failed", { code: backupError.code || "BACKUP_FAILED" });
      }
    } catch (error) {
      if (error?.name === "AbortError" || error?.code === "ABORTED") {
        this.queueStore.update(job.date, { status: "paused", nextAttemptAt: "", errorCode: "" });
        return;
      }
      const attempt = job.attempt + 1;
      const retryDelay = RETRY_DELAYS_MS[attempt - 1];
      this.queueStore.update(job.date, {
        status: retryDelay ? "pending" : "failed",
        nextAttemptAt: retryDelay ? new Date(Date.now() + retryDelay).toISOString() : "",
        errorCode: error.code || "REPORT_GENERATION_FAILED",
      });
      this.logger?.error("reports.generation_failed", { date: job.date, attempt, code: error.code || "REPORT_GENERATION_FAILED" });
    } finally {
      this.running = false;
      this.currentDate = "";
      this.currentAbortController = null;
    }
  }

  pauseBackfill() {
    this.desktopStateStore.patch({ backfillPaused: true });
    for (const item of this.queueStore.list().filter((job) => job.status === "pending" && job.kind === "backfill")) {
      this.queueStore.update(item.date, { status: "paused" });
    }
    this.currentAbortController?.abort();
  }

  resumeBackfill() {
    this.desktopStateStore.patch({ backfillPaused: false });
    for (const item of this.queueStore.list().filter((job) => job.status === "paused")) {
      this.queueStore.update(item.date, { status: "pending" });
    }
    this.tick().catch(() => {});
  }

  retry(date) {
    const job = this.queueStore.get(date);
    if (!job) return null;
    const updated = this.queueStore.update(date, { status: "pending", attempt: 0, nextAttemptAt: "", errorCode: "" });
    this.tick().catch(() => {});
    return updated;
  }
}

function isReportDue(now, reportTime) {
  const [hour, minute] = String(reportTime || "00:30").split(":").map(Number);
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

function previousCalendarDates(now, count) {
  const dates = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    dates.push(formatLocalDate(date));
  }
  return dates;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = { ReportScheduler, RETRY_DELAYS_MS, formatLocalDate, isReportDue, previousCalendarDates };
