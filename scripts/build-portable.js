"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const BROKEN_LOGIC = `            if (typeof unpackDirName === "string" || !unpackDirName) {
                defines.UNPACK_DIR_NAME = unpackDirName || (0, builder_util_1.generateKsuid)();
            }`;

const FIXED_LOGIC = `            if (typeof unpackDirName === "string") {
                defines.UNPACK_DIR_NAME = unpackDirName;
            }
            else if (unpackDirName !== false) {
                defines.UNPACK_DIR_NAME = (0, builder_util_1.generateKsuid)();
            }`;

function patchPortableUnpackLogic(source) {
  if (!source.includes(BROKEN_LOGIC)) {
    throw new Error(
      "Unsupported electron-builder portable implementation; refusing to patch an unknown version.",
    );
  }
  return source.replace(BROKEN_LOGIC, FIXED_LOGIC);
}

async function buildPortable(args = process.argv.slice(2)) {
  const targetPath = require.resolve("app-builder-lib/out/targets/nsis/NsisTarget.js");
  const builderCli = require.resolve("electron-builder/out/cli/cli.js");
  const original = fs.readFileSync(targetPath, "utf8");
  const patched = patchPortableUnpackLogic(original);
  let restored = false;

  const restore = () => {
    if (restored) {
      return;
    }
    fs.writeFileSync(targetPath, original, "utf8");
    restored = true;
  };

  fs.writeFileSync(targetPath, patched, "utf8");

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [builderCli, "--win", "portable", ...args],
        {
          cwd: path.resolve(__dirname, ".."),
          env: process.env,
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`electron-builder exited after signal ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`electron-builder exited with code ${exitCode}`);
    }
  } finally {
    restore();
  }
}

if (require.main === module) {
  buildPortable().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  BROKEN_LOGIC,
  FIXED_LOGIC,
  buildPortable,
  patchPortableUnpackLogic,
};
