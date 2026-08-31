const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  ELECTRON_WORKING_DIRECTORY_NAME,
  prepareElectronWorkingDirectory,
} = require("../src/desktop/electron-working-directory");

test("Windows Electron working directory is isolated under the CyberBoss state directory", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-electron-cwd-"));
  const originalCwd = process.cwd();
  try {
    const workingDirectory = prepareElectronWorkingDirectory(stateDir, { platform: "win32" });
    assert.equal(workingDirectory, path.join(stateDir, ELECTRON_WORKING_DIRECTORY_NAME));
    assert.equal(process.cwd(), workingDirectory);
    assert.equal(path.dirname(workingDirectory), stateDir);
    assert.equal(workingDirectory.startsWith(`${path.resolve(originalCwd)}${path.sep}`), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("non-Windows Electron working directory is unchanged", () => {
  const originalCwd = process.cwd();
  assert.equal(prepareElectronWorkingDirectory("relative-state", { platform: "linux" }), originalCwd);
  assert.equal(process.cwd(), originalCwd);
});
