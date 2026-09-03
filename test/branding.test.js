"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");
const { BRAND, configureElectronBranding } = require("../src/desktop/brand");

test("Aidy branding changes display identity while preserving legacy runtime identity", () => {
  assert.deepEqual(BRAND, {
    english: "Aidy",
    chinese: "艾迪",
    legacyEnglish: "CyberBoss",
    executableName: "Aidy.exe",
    legacyAppId: "com.cyberboss.desktop",
    legacyAppUserModelId: "CyberBoss.Desktop",
    legacyUserDataDirectory: "CyberBoss",
  });

  const calls = [];
  const electronApp = {
    setName(value) { calls.push(["name", value]); },
    setPath(kind, value) { calls.push(["path", kind, value]); },
    setAppUserModelId(value) { calls.push(["appUserModelId", value]); },
    getPath(kind) { assert.equal(kind, "appData"); return "C:\\Users\\test\\AppData\\Roaming"; },
  };
  configureElectronBranding(electronApp, path);
  assert.deepEqual(calls, [
    ["name", "Aidy"],
    ["path", "userData", path.join("C:\\Users\\test\\AppData\\Roaming", "CyberBoss")],
    ["appUserModelId", "CyberBoss.Desktop"],
  ]);

  const isolatedCalls = [];
  configureElectronBranding({
    setName(value) { isolatedCalls.push(["name", value]); },
    setPath() { isolatedCalls.push(["path"]); },
    setAppUserModelId(value) { isolatedCalls.push(["appUserModelId", value]); },
    getPath() { return "C:\\Users\\test\\AppData\\Roaming"; },
  }, path, ["app.exe", "--user-data-dir=C:\\temp\\Aidy"]);
  assert.deepEqual(isolatedCalls, [["name", "Aidy"], ["appUserModelId", "CyberBoss.Desktop"]]);
});

test("Windows packaging and shortcut surfaces use Aidy while npm CLI compatibility remains", () => {
  assert.equal(packageJson.name, "cyberboss");
  assert.equal(packageJson.bin.cyberboss, "./bin/cyberboss.js");
  assert.equal(packageJson.build.productName, "Aidy");
  assert.equal(packageJson.build.artifactName, "Aidy-${version}-${arch}.${ext}");
  assert.equal(packageJson.build.win.executableName, "Aidy");
  assert.equal(packageJson.build.nsis.artifactName, "Aidy-Setup-v${version}.${ext}");
  assert.equal(packageJson.build.nsis.shortcutName, "Aidy");

  const startMenuScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "sync-start-menu-shortcut.ps1"), "utf8");
  const desktopScript = fs.readFileSync(path.join(__dirname, "..", "scripts", "install-desktop-shortcut.ps1"), "utf8");
  assert.match(startMenuScript, /win-unpacked\\Aidy\.exe/);
  assert.match(startMenuScript, /CyberBoss\.lnk/);
  assert.match(desktopScript, /win-unpacked\\Aidy\.exe/);
  assert.match(desktopScript, /艾迪\.lnk/);
});
