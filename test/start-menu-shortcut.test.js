"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const scriptPath = path.join(rootDir, "scripts", "sync-start-menu-shortcut.ps1");

test("start menu sync points to the verified unpacked artifact", { skip: process.platform !== "win32" }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-start-menu-"));
  const artifactPath = path.join(temporaryRoot, "dist", "win-unpacked", "Aidy.exe");
  const shortcutPath = path.join(temporaryRoot, "Aidy.lnk");
  const legacyShortcutPath = path.join(temporaryRoot, "CyberBoss.lnk");
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, "verified-artifact");
  fs.writeFileSync(legacyShortcutPath, "legacy-shortcut");

  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ArtifactPath",
      artifactPath,
      "-ShortcutPath",
      shortcutPath,
    ], { cwd: rootDir, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Target\\s+: ${escapeRegExp(artifactPath)}`));
    assert.match(result.stdout, new RegExp(`StartIn\\s+: ${escapeRegExp(path.dirname(artifactPath))}`));
    assert.equal(fs.existsSync(legacyShortcutPath), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
