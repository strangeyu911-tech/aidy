const fs = require("fs");
const path = require("path");

const ELECTRON_WORKING_DIRECTORY_NAME = "electron-runtime";

function prepareElectronWorkingDirectory(stateDir, { platform = process.platform } = {}) {
  if (platform !== "win32") return process.cwd();

  const resolvedStateDir = path.resolve(String(stateDir || ""));
  if (!resolvedStateDir || resolvedStateDir === path.parse(resolvedStateDir).root) {
    throw new Error("A non-root Aidy state directory is required for Electron runtime isolation.");
  }

  const workingDirectory = path.join(resolvedStateDir, ELECTRON_WORKING_DIRECTORY_NAME);
  fs.mkdirSync(workingDirectory, { recursive: true });
  process.chdir(workingDirectory);
  return workingDirectory;
}

module.exports = {
  ELECTRON_WORKING_DIRECTORY_NAME,
  prepareElectronWorkingDirectory,
};
