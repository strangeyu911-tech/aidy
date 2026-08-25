const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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

function reopenArchive(archivePath) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-backup-open-"));
  const listed = spawnSync("tar.exe", ["-t", "-f", archivePath], { encoding: "utf8", windowsHide: true });
  assert.equal(listed.status, 0, listed.stderr);
  const extracted = spawnSync("tar.exe", ["-x", "-f", archivePath, "-C", extractDir], { encoding: "utf8", windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const entries = listed.stdout.split(/\r?\n/).map((value) => value.replace(/^\.\//, "").trim()).filter(Boolean);
  const texts = entries
    .filter((entry) => entry !== "manifest.json" && fs.statSync(path.join(extractDir, entry)).isFile())
    .map((entry) => fs.readFileSync(path.join(extractDir, entry), "utf8"));
  return { entries, extractDir, text: texts.join("\n") };
}

test("backup archive rejects absolute and traversal paths", () => {
  assert.throws(() => validateArchiveEntries(["../secret.txt"]), /不安全/);
  assert.throws(() => validateArchiveEntries(["C:/secret.txt"]), /不安全/);
  assert.throws(() => validateArchiveEntries(["credentials.json"]), /不认识/);
  assert.throws(() => validateArchiveEntries(["credential-vault.json"]), /敏感数据/);
  assert.throws(() => validateArchiveEntries(["diagnostic-capture.json"]), /敏感数据/);
  assert.throws(() => validateArchiveEntries(["opencode/auth.json"]), /敏感数据/);
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

test("settings export reopens with non-secret draft profiles and excludes vault and diagnostic capture", async () => {
  const stateDir = makeStateDir();
  const synthetic = {
    apiKey: "sk-export-secret",
    authorization: "Bearer export-auth-secret",
    sensitiveHeader: "export-sensitive-header",
    ciphertext: "export-vault-ciphertext",
    requestRaw: "export-request-raw",
    responseRaw: "export-response-raw",
  };
  fs.writeFileSync(path.join(stateDir, "provider-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    activeProfileId: "profile-export",
    profiles: [{
      id: "profile-export",
      name: "OpenRouter",
      runtimeId: "builtin-api",
      providerId: "openrouter",
      protocolId: "openai-chat",
      baseUrl: "https://user:password@example.invalid/v1",
      options: {
        apiKey: synthetic.apiKey,
        authorization: synthetic.authorization,
        headers: { Authorization: synthetic.authorization, "X-Sensitive": synthetic.sensitiveHeader },
        requestRaw: synthetic.requestRaw,
        responseRaw: synthetic.responseRaw,
        safeOption: true,
      },
      modelId: "openai/gpt-test",
      secretRefs: { apiKey: synthetic.apiKey, sensitiveHeaders: { "X-Sensitive": synthetic.sensitiveHeader } },
      secretGeneration: 7,
      status: "verified",
      verifiedFingerprint: "a".repeat(64),
      capabilities: { streaming: true, rawResponse: synthetic.responseRaw },
      catalogMetadata: { fetchedAt: "2026-08-25T00:00:00.000Z", rawResponse: synthetic.responseRaw },
    }],
  }), "utf8");
  fs.writeFileSync(path.join(stateDir, "credential-vault.json"), synthetic.ciphertext, "utf8");
  fs.writeFileSync(path.join(stateDir, "diagnostic-capture.json"), synthetic.responseRaw, "utf8");
  fs.mkdirSync(path.join(stateDir, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "opencode", "auth.json"), synthetic.apiKey, "utf8");

  const service = new BackupService({ stateDir });
  const targetPath = path.join(stateDir, "backups", "settings-export.zip");
  await service.createBackup({ targetPath, classes: ["settings"] });

  assert.equal(fs.existsSync(targetPath), true);
  assert.ok(fs.statSync(targetPath).size > 0);
  const reopened = reopenArchive(targetPath);
  assert.equal(reopened.entries.includes("provider-profiles.json"), true);
  assert.equal(reopened.entries.some((name) => /credential-vault|diagnostic-capture|opencode\/auth/i.test(name)), false);
  for (const value of Object.values(synthetic)) assert.equal(reopened.text.includes(value), false, value);

  const archivedProfiles = JSON.parse(fs.readFileSync(path.join(reopened.extractDir, "provider-profiles.json"), "utf8"));
  assert.equal(archivedProfiles.activeProfileId, "");
  assert.equal(archivedProfiles.profiles[0].status, "draft");
  assert.equal(archivedProfiles.profiles[0].verifiedFingerprint, "");
  assert.deepEqual(archivedProfiles.profiles[0].capabilities, {});
  assert.deepEqual(archivedProfiles.profiles[0].secretRefs, { apiKey: "", servicePassword: "", sensitiveHeaders: {} });
  assert.equal(archivedProfiles.profiles[0].secretGeneration, 0);
  assert.equal(archivedProfiles.profiles[0].options.safeOption, true);

  const restoredStateDir = makeStateDir();
  const preservedVault = "target-vault-must-remain";
  const preservedCapture = "target-capture-must-remain";
  fs.writeFileSync(path.join(restoredStateDir, "credential-vault.json"), preservedVault, "utf8");
  fs.writeFileSync(path.join(restoredStateDir, "diagnostic-capture.json"), preservedCapture, "utf8");
  await new BackupService({ stateDir: restoredStateDir }).restore({ archivePath: targetPath, createPreRestoreBackup: false });
  const restoredProfiles = JSON.parse(fs.readFileSync(path.join(restoredStateDir, "provider-profiles.json"), "utf8"));
  assert.equal(restoredProfiles.activeProfileId, "");
  assert.equal(restoredProfiles.profiles[0].status, "draft");
  assert.equal(fs.readFileSync(path.join(restoredStateDir, "credential-vault.json"), "utf8"), preservedVault);
  assert.equal(fs.readFileSync(path.join(restoredStateDir, "diagnostic-capture.json"), "utf8"), preservedCapture);
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
