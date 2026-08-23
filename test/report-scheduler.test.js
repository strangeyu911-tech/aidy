const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesktopStateStore } = require("../src/core/desktop-state-store");
const { ReportScheduler, isReportDue, previousCalendarDates } = require("../src/desktop/report-scheduler");

function createScheduler({ now, runSubcommand } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-report-test-"));
  const desktopStateStore = new DesktopStateStore({ stateDir });
  desktopStateStore.patch({ desiredState: "running", reportEnabled: true });
  const calls = [];
  const scheduler = new ReportScheduler({
    stateDir,
    desktopStateStore,
    healthyDelayMs: 0,
    now: () => now,
    timelineIntegration: { async runSubcommand(command, args) { calls.push({ command, args }); return runSubcommand ? runSubcommand(command, args) : { outputFile: path.join(stateDir, "reports", "shot.png") }; } },
  });
  scheduler.setRuntimeHealthy(true);
  return { scheduler, calls, desktopStateStore };
}

test("daily reports become due at configured local time", () => {
  assert.equal(isReportDue(new Date(2026, 7, 23, 0, 29), "00:30"), false);
  assert.equal(isReportDue(new Date(2026, 7, 23, 0, 30), "00:30"), true);
});

test("backfill dates are deterministic oldest to newest", () => {
  assert.deepEqual(previousCalendarDates(new Date(2026, 7, 23, 8, 0), 3), ["2026-08-20", "2026-08-21", "2026-08-22"]);
});

test("report scheduler generates one oldest missing date at a time", async () => {
  const { scheduler, calls } = createScheduler({ now: new Date(2026, 7, 23, 8, 0) });
  scheduler.ensureMissingJobs(new Date(2026, 7, 23, 8, 0), "00:30");
  await scheduler.tick();
  const generated = scheduler.queueStore.list().filter((item) => item.status === "generated");
  assert.equal(generated.length, 1);
  assert.equal(generated[0].date, "2026-08-16");
  assert.deepEqual(calls.map((item) => item.command), ["build", "screenshot"]);
});

test("quiet keeps report generation active while stopped pauses it", async () => {
  const { scheduler, calls, desktopStateStore } = createScheduler({ now: new Date(2026, 7, 23, 8, 0) });
  desktopStateStore.setDesiredState("quiet");
  await scheduler.tick();
  assert.equal(calls.length, 2);
  desktopStateStore.setDesiredState("stopped");
  await scheduler.tick();
  assert.equal(calls.length, 2);
});

test("backfill pause persists and prevents another job", async () => {
  const { scheduler, calls } = createScheduler({ now: new Date(2026, 7, 23, 8, 0) });
  scheduler.ensureMissingJobs(new Date(2026, 7, 23, 8, 0), "00:30");
  scheduler.pauseBackfill();
  await scheduler.tick();
  assert.equal(calls.length, 0);
  scheduler.resumeBackfill();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
});

test("pausing backfill cancels the current cancellable child and preserves it as paused", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-report-cancel-"));
  const desktopStateStore = new DesktopStateStore({ stateDir });
  desktopStateStore.patch({ desiredState: "running", reportEnabled: true });
  const scheduler = new ReportScheduler({
    stateDir,
    desktopStateStore,
    healthyDelayMs: 0,
    now: () => new Date(2026, 7, 23, 8, 0),
    timelineIntegration: {
      runSubcommand(_command, _args, { signal }) {
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          const error = new Error("cancelled"); error.name = "AbortError"; reject(error);
        }, { once: true }));
      },
    },
  });
  scheduler.setRuntimeHealthy(true);
  scheduler.ensureMissingJobs(new Date(2026, 7, 23, 8, 0), "00:30");
  const running = scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.pauseBackfill();
  await running;
  assert.equal(scheduler.queueStore.get("2026-08-16").status, "paused");
});
