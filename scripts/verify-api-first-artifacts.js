"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DesktopStateStore } = require("../src/core/desktop-state-store");
const { ProviderProfileStore } = require("../src/core/provider-profile-store");
const { BackupService } = require("../src/services/backup-service");
const { CredentialVault } = require("../src/security/credential-vault");
const { DiagnosticCapture } = require("../src/security/diagnostic-capture");

const rootDir = path.resolve(__dirname, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-artifact-"));
const stateDir = path.join(temporaryRoot, "state");
const launchStateDir = path.join(temporaryRoot, "packaged-state");
const extractDir = path.join(temporaryRoot, "backup-open");
const secret = `sk-artifact-${process.pid}-${Date.now()}`;

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  removeTemporaryRoot(temporaryRoot);
});

async function main() {
  const profileStore = new ProviderProfileStore({ stateDir, randomUUID: () => "artifact-profile" });
  const profile = profileStore.upsertDraft({
    name: "Artifact OpenRouter",
    runtimeId: "builtin-api",
    providerId: "openrouter",
    protocolId: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "openai/synthetic-artifact-model",
  });
  const vault = new CredentialVault({ stateDir });
  const written = await vault.write(profile.id, { apiKey: secret, sensitiveHeaders: { "x-artifact-secret": secret } });
  profileStore.markSecretWritten(profile.id, { generation: written.generation, secretRefs: { apiKey: "vault:apiKey", sensitiveHeaders: { "x-artifact-secret": "vault:sensitiveHeaders:x-artifact-secret" } } });

  const profilePath = path.join(stateDir, "provider-profiles.json");
  const vaultPath = path.join(stateDir, "credential-vault.json");
  assertExistingNonEmpty(profilePath);
  assertExistingNonEmpty(vaultPath);
  const vaultText = fs.readFileSync(vaultPath, "utf8");
  assert.equal(vaultText.includes(secret), false);

  const reopenedProfiles = new ProviderProfileStore({ stateDir });
  const reopenedVault = new CredentialVault({ stateDir });
  assert.equal(reopenedProfiles.get(profile.id)?.modelId, profile.modelId);
  assert.deepEqual(await reopenedVault.read(profile.id), { apiKey: secret, sensitiveHeaders: { "x-artifact-secret": secret } });

  const diagnosticCapture = new DiagnosticCapture({ stateDir });
  await diagnosticCapture.enable({ scope: "artifact-verification", durationMs: 60_000 });
  await diagnosticCapture.record({ kind: "response", responseText: "artifact-private-response", authorization: `Bearer ${secret}` });
  const capturePath = path.join(stateDir, "diagnostic-capture.json");
  assertExistingNonEmpty(capturePath);

  const archivePath = path.join(stateDir, "backups", "artifact-settings.zip");
  await new BackupService({ stateDir }).createBackup({ targetPath: archivePath, classes: ["settings"] });
  assertExistingNonEmpty(archivePath);
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar.exe", ["-x", "-f", archivePath, "-C", extractDir]);
  const archiveEntries = run("tar.exe", ["-t", "-f", archivePath]).stdout
    .split(/\r?\n/).map((entry) => entry.replace(/^\.\//, "").trim()).filter(Boolean);
  const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "cyberboss-backup");
  assert.equal(archiveEntries.includes("provider-profiles.json"), true);
  assert.equal(archiveEntries.some((entry) => /credential-vault|diagnostic-capture|opencode(?:\/|$)/i.test(entry)), false);
  const archiveText = listFiles(extractDir).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
  assert.equal(archiveText.includes(secret), false);
  assert.equal(archiveText.includes(vaultText.match(/"ciphertext"\s*:\s*"([^"]+)"/)?.[1] || secret), false);
  assert.equal(archiveText.includes("artifact-private-response"), false);

  const packagedExe = path.join(rootDir, "dist", "win-unpacked", "CyberBoss.exe");
  assertExistingNonEmpty(packagedExe);
  const resourcesDir = path.join(rootDir, "dist", "win-unpacked", "resources");
  const resourceEntries = inspectPackagedResources(resourcesDir);
  assert.equal(resourceEntries.some((entry) => /src\/desktop\/main\.js$/i.test(entry)), true);
  assert.equal(resourceEntries.some((entry) => /(?:credential-vault|diagnostic-capture)\.json$/i.test(entry)), false);

  const exitCode = await launchPackaged(packagedExe, launchStateDir);
  assert.equal(exitCode, 0);
  const desktopStatePath = path.join(launchStateDir, "desktop-state.json");
  assertExistingNonEmpty(desktopStatePath);
  const desktopState = new DesktopStateStore({ stateDir: launchStateDir }).get();
  assert.equal(desktopState.desiredState, "stopped");
  assert.equal(new ProviderProfileStore({ stateDir: launchStateDir }).getActive(), null);

  const portableArtifact = findPortableArtifact(path.join(rootDir, "dist"));
  assertExistingNonEmpty(portableArtifact);
  process.stdout.write([
    `profilePath=${profilePath}`,
    "profileExists=true",
    `vaultPath=${vaultPath}`,
    "vaultExists=true",
    "reopened=true",
    `archivePath=${archivePath}`,
    `archiveEntries=${archiveEntries.length}`,
    "secretFree=true",
    `packagedExe=${packagedExe}`,
    `packagedBytes=${fs.statSync(packagedExe).size}`,
    `portableArtifact=${portableArtifact}`,
    `portableBytes=${fs.statSync(portableArtifact).size}`,
    `packagedResourceEntries=${resourceEntries.length}`,
    "packagedStateReopened=true",
    "packaged=true",
  ].join("\n") + "\n");
}

function inspectPackagedResources(resourcesDir) {
  const unpackedApp = path.join(resourcesDir, "app");
  if (fs.existsSync(unpackedApp)) return listFiles(unpackedApp).map((filePath) => path.relative(unpackedApp, filePath).replace(/\\/g, "/"));
  const asarPath = path.join(resourcesDir, "app.asar");
  assertExistingNonEmpty(asarPath);
  const asar = require("@electron/asar");
  return asar.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]/, "").replace(/\\/g, "/"));
}

function findPortableArtifact(distDir) {
  const candidates = fs.readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^CyberBoss.*\.exe$/i.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .filter((filePath) => fs.statSync(filePath).size > 0)
    .sort();
  assert.ok(candidates.length > 0, "No portable CyberBoss artifact was generated.");
  return candidates[0];
}

function launchPackaged(executable, packagedStateDir) {
  fs.mkdirSync(packagedStateDir, { recursive: true });
  const electronUserDataDir = path.join(path.dirname(packagedStateDir), "electron-user-data");
  fs.mkdirSync(electronUserDataDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--disable-gpu", `--user-data-dir=${electronUserDataDir}`], {
      env: {
        ...process.env,
        CYBERBOSS_STATE_DIR: packagedStateDir,
        CYBERBOSS_ARTIFACT_SMOKE_EXIT_MS: "2500",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Packaged CyberBoss did not exit after the artifact smoke timeout."));
    }, 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr.trim() || `Packaged CyberBoss exited with ${code}`));
      else resolve(code);
    });
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  return result;
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function assertExistingNonEmpty(filePath) {
  assert.equal(fs.existsSync(filePath), true, `${filePath} does not exist`);
  assert.ok(fs.statSync(filePath).size > 0, `${filePath} is empty`);
  const descriptor = fs.openSync(filePath, "r");
  fs.closeSync(descriptor);
}

function removeTemporaryRoot(target) {
  const resolved = path.resolve(target);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("cyberboss-artifact-")) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}
