"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertElectronNodeRuntimeAvailable,
  friendlyProcessError,
  resolveOwnedSpawnSpec,
} = require("../src/desktop/runtime-supervisor");

test("missing WeChat account becomes an actionable desktop error", () => {
  const result = friendlyProcessError(Object.assign(new Error("raw account error"), {
    code: "WECHAT_LOGIN_REQUIRED",
    capability: "wechat",
  }));

  assert.deepEqual(
    { code: result.code, capability: result.capability, summary: result.summary, repairAction: result.repairAction },
    { code: "WECHAT_LOGIN_REQUIRED", capability: "wechat", summary: "微信登录信息不可用。", repairAction: "点击“连接微信”，重新扫码登录。" },
  );
});

test("missing packaged Electron ICU data is diagnosed before spawning the bridge", () => {
  assert.throws(() => assertElectronNodeRuntimeAvailable({
    executable: "C:\\portable\\CyberBoss.exe",
    platform: "win32",
    electronVersion: "43.4.1",
    existsSync: () => false,
  }), (error) => error.code === "BRIDGE_RUNTIME_FILES_MISSING" && error.capability === "bridge");

  assert.doesNotThrow(() => assertElectronNodeRuntimeAvailable({
    executable: "C:\\portable\\CyberBoss.exe",
    platform: "win32",
    electronVersion: "43.4.1",
    existsSync: (filePath) => filePath.endsWith("icudtl.dat"),
  }));
});

test("packaged app.asar bridge falls back to Electron Node with a real cwd", () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-resources-"));
  try {
    const rootDir = path.join(resourcesPath, "app.asar");
    const command = path.join(resourcesPath, "CyberBoss.exe");
    const entry = path.join(rootDir, "bin", "cyberboss.js");
    const spec = resolveOwnedSpawnSpec({
      rootDir,
      command,
      args: [entry, "start"],
      platform: "win32",
      resourcesPath,
      processHostAvailable: true,
    });

    assert.equal(spec.packagedAsar, true);
    assert.equal(spec.useProcessHost, false);
    assert.equal(spec.command, command);
    assert.deepEqual(spec.args, [entry, "start"]);
    assert.equal(spec.cwd, resourcesPath);
    assert.match(spec.processHost, /app\.asar[\\/]native[\\/]win32[\\/]CyberBoss\.ProcessHost\.exe$/i);
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test("source runtime keeps the Windows ProcessHost and project cwd", () => {
  const rootDir = path.join(os.tmpdir(), "cyberboss-source");
  const command = path.join(rootDir, "node.exe");
  const entry = path.join(rootDir, "bin", "cyberboss.js");
  const spec = resolveOwnedSpawnSpec({
    rootDir,
    command,
    args: [entry, "start"],
    platform: "win32",
    processHostAvailable: true,
  });

  assert.equal(spec.packagedAsar, false);
  assert.equal(spec.useProcessHost, true);
  assert.match(spec.command, /native[\\/]win32[\\/]CyberBoss\.ProcessHost\.exe$/i);
  assert.deepEqual(spec.args.slice(1), [command, entry, "start"]);
  assert.equal(spec.cwd, rootDir);
});

test("packaged cwd falls back to the real resources parent when resourcesPath is unavailable", () => {
  const rootDir = path.join(os.tmpdir(), "cyberboss", "resources", "app.asar");
  const spec = resolveOwnedSpawnSpec({
    rootDir,
    command: "CyberBoss.exe",
    args: [path.join(rootDir, "bin", "cyberboss.js"), "start"],
    platform: "win32",
    resourcesPath: path.join(os.tmpdir(), "missing-cyberboss-resources"),
    processHostAvailable: true,
  });

  assert.equal(spec.useProcessHost, false);
  assert.equal(spec.cwd, path.dirname(rootDir));
});
