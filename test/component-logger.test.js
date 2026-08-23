const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ComponentLogger, queryLogs } = require("../src/core/component-logger");

test("component logger redacts sensitive fields and supports filtering", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-logs-"));
  const logger = new ComponentLogger({ logDir, component: "desktop", maxBytes: 1024 });
  logger.info("controller.ready", { status: "ok", token: "secret", messageBody: "private" });
  logger.warn("controller.retry", { attempt: 1 });
  const records = queryLogs({ logDir, component: "desktop", level: "INFO" });
  assert.equal(records.length, 1);
  assert.equal(records[0].data.token, "[REDACTED]");
  assert.equal(records[0].data.messageBody, "[REDACTED]");
  assert.equal(records[0].data.status, "ok");
});

test("component logger rotates bounded files", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-log-rotation-"));
  const logger = new ComponentLogger({ logDir, component: "bridge", maxBytes: 80, maxRotated: 2 });
  for (let index = 0; index < 10; index += 1) logger.info("bridge.event", { index });
  const files = fs.readdirSync(logDir).filter((name) => name.startsWith("bridge.jsonl"));
  assert.ok(files.length <= 3);
  assert.ok(files.includes("bridge.jsonl"));
});

test("component logger removes expired rotated logs but keeps active files", () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-log-retention-"));
  const logger = new ComponentLogger({ logDir, component: "reports", maxAgeDays: 14 });
  fs.writeFileSync(path.join(logDir, "reports.jsonl"), "active", "utf8");
  fs.writeFileSync(path.join(logDir, "reports.jsonl.1"), "old", "utf8");
  const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
  fs.utimesSync(path.join(logDir, "reports.jsonl.1"), old, old);
  logger.cleanupRetention();
  assert.equal(fs.existsSync(path.join(logDir, "reports.jsonl")), true);
  assert.equal(fs.existsSync(path.join(logDir, "reports.jsonl.1")), false);
});
