const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BackupService, validateArchiveEntries } = require("../src/services/backup-service");

function makeStateDir() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-backup-test-"));
  fs.mkdirSync(path.join(stateDir, "diary"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "desktop-state.json"), JSON.stringify({ desiredState: "stopped" }), "utf8");
  fs.writeFileSync(path.join(stateDir, "supervision-plan.json"), JSON.stringify({ checkpoints: [] }), "utf8");
  fs.writeFileSync(path.join(stateDir, "diary", "2026-08-23.md"), "## 00:43\n\nhello", "utf8");
  return stateDir;
}

test("backup archive rejects absolute and traversal paths", () => {
  assert.throws(() => validateArchiveEntries(["../secret.txt"]), /不安全/);
  assert.throws(() => validateArchiveEntries(["C:/secret.txt"]), /不安全/);
  assert.throws(() => validateArchiveEntries(["credentials.json"]), /不认识/);
  assert.doesNotThrow(() => validateArchiveEntries(["./manifest.json", "./diary/2026-08-23.md"]));
});

test("manual backup includes settings and diary but excludes credentials", async () => {
  const stateDir = makeStateDir();
  fs.writeFileSync(path.join(stateDir, "credentials.json"), "secret", "utf8");
  const service = new BackupService({ stateDir });
  const targetPath = path.join(stateDir, "backups", "manual-test.zip");
  const result = await service.createBackup({ targetPath, classes: ["settings", "diary"] });
  assert.equal(result.filePath, targetPath);
  assert.ok(fs.existsSync(targetPath));
  assert.deepEqual(result.manifest.dataClasses, ["settings", "diary"]);
  assert.equal(result.manifest.files.some((item) => item.path.includes("credentials")), false);
});

test("validated restore replaces selected records and preserves credentials", async () => {
  const sourceDir = makeStateDir();
  const archivePath = path.join(sourceDir, "backups", "restore-source.zip");
  const sourceService = new BackupService({ stateDir: sourceDir });
  await sourceService.createBackup({ targetPath: archivePath, classes: ["diary"] });

  const targetDir = makeStateDir();
  fs.writeFileSync(path.join(targetDir, "credentials.json"), "keep-me", "utf8");
  fs.writeFileSync(path.join(targetDir, "diary", "2026-08-23.md"), "old", "utf8");
  const targetService = new BackupService({ stateDir: targetDir });
  await targetService.restore({ archivePath, createPreRestoreBackup: false });
  assert.match(fs.readFileSync(path.join(targetDir, "diary", "2026-08-23.md"), "utf8"), /hello/);
  assert.equal(fs.readFileSync(path.join(targetDir, "credentials.json"), "utf8"), "keep-me");
});
