"use strict";

// Boots the real Electron desktop process against a throwaway state directory.
//
// This exists because `npm run check` only parses files: it cannot see a typo in
// a call site. During the 2026-09-18 remediation a rename in renderer.js left
// `renderWechatLogin` undefined at its call site; every unit test passed, the
// syntax check passed, and only actually starting the app surfaced it. Failures
// inside the renderer never crash the main process, so without this the bug would
// have shipped as "the control center opens but stays blank".
//
// It never touches the real ~/.cyberboss: CYBERBOSS_STATE_DIR points at a temp
// directory and CYBERBOSS_ARTIFACT_SMOKE_EXIT_MS makes the app exit on its own.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const electron = require("electron");
const SMOKE_EXIT_MS = 6000;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aidy-desktop-smoke-"));
const stateDir = path.join(tempRoot, "state");
const userDataDir = path.join(tempRoot, "user-data");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

// Seed a stale heartbeat so the channel-health path is really exercised rather
// than short-circuiting on a missing file.
const seededHeartbeat = {
  schemaVersion: 1,
  state: "degraded",
  reason: "timeout",
  consecutiveTimeouts: 9,
  consecutiveFailures: 0,
  lastSuccessAt: new Date(Date.now() - 95 * 60_000).toISOString(),
  lastSuccessLatencyMs: null,
  degradedSince: new Date(Date.now() - 90 * 60_000).toISOString(),
  recordedAt: new Date(Date.now() - 60_000).toISOString(),
  lastOutcome: "timeout",
  lastErrorClass: "timeout",
};
fs.writeFileSync(path.join(stateDir, "wechat-activity.json"), `${JSON.stringify(seededHeartbeat, null, 2)}\n`, "utf8");

// A host that itself runs Electron sets ELECTRON_RUN_AS_NODE=1, which makes
// electron.exe behave as plain Node and crash on first use of the `app` module.
const env = { ...process.env, CYBERBOSS_STATE_DIR: stateDir, CYBERBOSS_ARTIFACT_SMOKE_EXIT_MS: String(SMOKE_EXIT_MS) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, [
  path.join(rootDir, "src", "desktop", "main.js"),
  "--disable-gpu",
  // Without this, renderer console errors never reach stderr and the check is blind.
  "--enable-logging",
  `--user-data-dir=${userDataDir}`,
], {
  cwd: rootDir,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

const killTimer = setTimeout(() => {
  child.kill();
  finish({ timedOut: true, code: null });
}, SMOKE_EXIT_MS + 40_000);

child.once("error", (error) => {
  clearTimeout(killTimer);
  process.stderr.write(`[desktop-smoke] could not start Electron: ${error.message}\n`);
  process.exitCode = 1;
  cleanup();
});

child.once("exit", (code) => {
  clearTimeout(killTimer);
  finish({ timedOut: false, code });
});

function finish({ timedOut, code }) {
  const problems = [];
  if (timedOut) problems.push(`the app ignored CYBERBOSS_ARTIFACT_SMOKE_EXIT_MS and had to be killed`);
  else if (code !== 0) problems.push(`the app exited with code ${code}`);

  // Any renderer or main-process console error counts: this check is about the
  // app coming up clean, not about a curated allowlist.
  const errors = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .filter((line) => /Error:|TypeError|ReferenceError|SyntaxError|Cannot find module|Unhandled|uncaught/i.test(line));
  if (errors.length) problems.push(`console errors:\n${errors.map((line) => `      ${line.trim()}`).join("\n")}`);

  const desktopStatePath = path.join(stateDir, "desktop-state.json");
  if (!fs.existsSync(desktopStatePath)) problems.push("the app never wrote desktop-state.json, so bootstrap did not finish");

  const heartbeat = readHeartbeat();
  if (!heartbeat) problems.push("the seeded heartbeat file is gone or unreadable");
  else if (heartbeat.state !== "degraded" || heartbeat.consecutiveTimeouts !== 9) {
    problems.push("the desktop modified the bridge's heartbeat file; it must be read-only there");
  } else if (heartbeat.lastSuccessAt !== seededHeartbeat.lastSuccessAt) {
    problems.push("the desktop rewrote the bridge's heartbeat timestamp");
  }

  if (problems.length) {
    process.stderr.write(`[desktop-smoke] ${problems.length} problem(s) found:\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    if (stderr.trim()) process.stderr.write(`--- stderr ---\n${stderr.trim().split("\n").slice(-25).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write([
      "[desktop-smoke] ok",
      `exit=${code}`,
      `stateDir=${stateDir}`,
      `heartbeatUntouched=true`,
      `stateFiles=${fs.readdirSync(stateDir).sort().join(",")}`,
    ].join("\n") + "\n");
  }
  cleanup();
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, "wechat-activity.json"), "utf8"));
  } catch {
    return null;
  }
}

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Leaving a temp directory behind is not worth failing the check over.
  }
}
