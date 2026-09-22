"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_UNINSTALL_KEYS = Object.freeze([
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
]);

async function locateCodeBuddyDistribution({
  explicitExecutablePath = "", env = process.env, platform = process.platform,
  fsImpl = fs, execFileImpl = execFile,
  queryWindowsInstallations = defaultQueryWindowsInstallations,
} = {}) {
  const candidates = [];
  const explicitPath = normalizeText(explicitExecutablePath);
  if (explicitPath) candidates.push(standaloneCandidate(explicitPath, "explicit"));
  for (const executablePath of pathCandidates(env, platform)) {
    candidates.push(standaloneCandidate(executablePath, "path"));
  }
  if (platform === "win32") {
    const installations = await safeQueryInstallations(queryWindowsInstallations, {
      env, fsImpl, execFileImpl, platform,
    });
    for (const installation of installations) {
      candidates.push(...await workBuddyCandidates(installation, { env, fsImpl }));
    }
    const localAppData = normalizeText(env.LOCALAPPDATA);
    if (localAppData) {
      candidates.push(...await workBuddyCandidates({
        installLocation: path.win32.join(localAppData, "Programs", "WorkBuddy"),
      }, { env, fsImpl }));
    }
  }
  for (const candidate of deduplicateCandidates(candidates, platform)) {
    try {
      return await probeCodeBuddyCandidate(candidate, { fsImpl, execFileImpl });
    } catch {
      // The aggregate error intentionally exposes no candidate paths or output.
    }
  }
  throw locatorError(
    "CODEBUDDY_BINARY_NOT_FOUND",
    "No compatible CodeBuddy command was found. Install CodeBuddy or WorkBuddy, then scan again.",
  );
}

async function probeCodeBuddyCandidate(candidate, { fsImpl = fs, execFileImpl = execFile } = {}) {
  const normalized = normalizeCandidate(candidate);
  try {
    await reopenInvocation(normalized, fsImpl);
    const versionOutput = await runFile(execFileImpl, normalized.command, [...normalized.argsPrefix, "--version"]);
    const version = parseVersion(versionOutput);
    if (!version) throw new Error("version unavailable");
    await reopenInvocation(normalized, fsImpl);
    const helpOutput = await runFile(execFileImpl, normalized.command, [...normalized.argsPrefix, "--help"]);
    if (!/(?:^|\s)--serve(?:\s|$|[=,])/m.test(helpOutput)) throw new Error("serve unavailable");
    return Object.freeze({
      source: normalized.source,
      sourceLabel: normalized.sourceLabel,
      version,
      appVersion: await readWorkBuddyAppVersion(normalized.executablePath, fsImpl),
      staticModels: Object.freeze(parseStaticModels(helpOutput)),
      executablePath: normalized.executablePath,
      command: normalized.command,
      argsPrefix: Object.freeze([...normalized.argsPrefix]),
      shell: false,
    });
  } catch {
    throw locatorError(
      "CODEBUDDY_VERSION_UNREADABLE",
      "The CodeBuddy candidate could not be reopened or did not advertise managed server support.",
    );
  }
}

function sanitizeCodeBuddyDistribution(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    source: normalizeText(source.source),
    sourceLabel: normalizeText(source.sourceLabel),
    version: normalizeText(source.version),
    appVersion: normalizeText(source.appVersion),
    staticModels: Array.isArray(source.staticModels) ? Object.freeze(source.staticModels.map((model) => ({
      id: normalizeText(model?.id),
      name: normalizeText(model?.name) || normalizeText(model?.id),
    })).filter((model) => model.id)) : Object.freeze([]),
    executablePath: normalizeText(source.executablePath),
  });
}

/**
 * The `--help` `--model` line statically lists every supported model ID —
 * e.g. "Currently supported: (fast-model, balanced-model, ..., hy4-preview,
 * hy3, ...)" — independent of any gateway auth. When live catalog discovery
 * fails (auth regressions, gateway unavailability), this keeps the model
 * dropdown populated instead of collapsing to the empty-catalog fallback.
 */
function parseStaticModels(helpOutput) {
  const match = String(helpOutput || "").match(/--model[^]*?Currently supported:\s*\(([^)]*)\)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .map((id) => ({ id, name: id }));
}

/**
 * The CLI's `--version` reports the bundled CLI (e.g. 2.137.1), not the desktop
 * app the user installed (e.g. 5.5.6). The app version lives in
 * `resources/install-manifest.json` next to the bundled CLI — three levels up
 * from `<resources>/app.asar.unpacked/cli/bin/<entry>`. Standalone CLI
 * installs have no manifest and report "".
 */
async function readWorkBuddyAppVersion(cliEntryPath, fsImpl) {
  try {
    const resourcesDir = path.resolve(path.dirname(cliEntryPath), "..", "..", "..");
    const manifestPath = path.join(resourcesDir, "install-manifest.json");
    const parsed = JSON.parse(await fsImpl.promises.readFile(manifestPath, "utf8"));
    return normalizeText(parsed?.appVersion);
  } catch {
    return "";
  }
}

function standaloneCandidate(executablePath, source) {
  return { source, sourceLabel: "CodeBuddy", executablePath, command: executablePath, argsPrefix: [], shell: false };
}

async function workBuddyCandidates(installation, { env, fsImpl }) {
  const source = installation && typeof installation === "object" ? installation : {};
  const explicitCli = normalizeText(source.cliEntryPath);
  const explicitNode = normalizeText(source.bundledNodePath);
  if (explicitCli || explicitNode) return explicitCli && explicitNode ? [bundledCandidate(explicitCli, explicitNode)] : [];
  const installLocation = normalizeText(source.installLocation);
  if (!installLocation) return [];
  const join = path.win32.join;
  const cliPaths = [
    join(installLocation, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy"),
    join(installLocation, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy.js"),
    join(installLocation, "resources", "codebuddy", "cli.js"),
  ];
  const nodePaths = [
    join(installLocation, "resources", "app.asar.unpacked", "cli", "node.exe"),
    join(installLocation, "resources", "codebuddy", "node.exe"),
    ...await workBuddyUserNodePaths(env, fsImpl),
  ];
  const output = [];
  for (const cliPath of cliPaths) {
    for (const nodePath of nodePaths) output.push(bundledCandidate(cliPath, nodePath));
  }
  return output;
}

function bundledCandidate(cliEntryPath, bundledNodePath) {
  return {
    source: "workbuddy-bundled", sourceLabel: "WorkBuddy / CodeBuddy",
    executablePath: cliEntryPath, command: bundledNodePath,
    argsPrefix: [cliEntryPath], shell: false,
  };
}

async function workBuddyUserNodePaths(env, fsImpl) {
  const userProfile = normalizeText(env.USERPROFILE);
  if (!userProfile || typeof fsImpl?.promises?.readdir !== "function") return [];
  const versionsRoot = path.win32.join(userProfile, ".workbuddy", "binaries", "node", "versions");
  try {
    const entries = await fsImpl.promises.readdir(versionsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => typeof entry === "string" || entry?.isDirectory?.())
      .map((entry) => typeof entry === "string" ? entry : entry.name)
      .filter(Boolean)
      .sort(compareVersionsDescending)
      .map((version) => path.win32.join(versionsRoot, version, "node.exe"));
  } catch {
    return [];
  }
}

function pathCandidates(env, platform) {
  const pathValue = normalizeText(env.PATH || env.Path);
  if (!pathValue) return [];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const extensions = platform === "win32" ? normalizeWindowsExtensions(env.PATHEXT) : [""];
  const output = [];
  for (const directory of pathValue.split(delimiter).map(normalizeText).filter(Boolean)) {
    for (const name of ["codebuddy", "cbc"]) {
      for (const extension of extensions) {
        output.push((platform === "win32" ? path.win32 : path).join(directory, `${name}${extension}`));
      }
    }
  }
  return output;
}

function normalizeWindowsExtensions(value) {
  const extensions = normalizeText(value).split(";").map((item) => normalizeText(item).toLowerCase());
  const safe = extensions.filter((item) => item === ".exe" || item === ".com");
  return safe.length ? safe : [".exe"];
}

async function reopenInvocation(candidate, fsImpl) {
  await reopenFile(candidate.executablePath, fsImpl);
  if (normalizePathKey(candidate.command, "win32") !== normalizePathKey(candidate.executablePath, "win32")) {
    await reopenFile(candidate.command, fsImpl);
  }
}

async function reopenFile(filePath, fsImpl) {
  const handle = await fsImpl.promises.open(filePath, "r");
  await handle.close();
}

function runFile(execFileImpl, command, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, {
      shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve(`${boundedText(stdout)}\n${boundedText(stderr)}`);
    });
  });
}

function boundedText(value) { return String(value || "").slice(0, MAX_OUTPUT_BYTES); }
function parseVersion(value) { return String(value || "").match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] || ""; }

function normalizeCandidate(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {
    source: normalizeText(source.source), sourceLabel: normalizeText(source.sourceLabel),
    executablePath: normalizeText(source.executablePath), command: normalizeText(source.command),
    argsPrefix: Array.isArray(source.argsPrefix) ? source.argsPrefix.map(normalizeText).filter(Boolean) : [],
  };
  if (!normalized.source || !normalized.sourceLabel || !normalized.executablePath || !normalized.command) {
    throw locatorError("CODEBUDDY_VERSION_UNREADABLE", "The CodeBuddy candidate is incomplete.");
  }
  return normalized;
}

function deduplicateCandidates(candidates, platform) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = [candidate.command, ...candidate.argsPrefix].map((value) => normalizePathKey(value, platform)).join("\u0000");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePathKey(value, platform) {
  const text = normalizeText(value);
  return platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
}

async function safeQueryInstallations(query, dependencies) {
  try {
    const value = await query(dependencies);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function defaultQueryWindowsInstallations({ execFileImpl = execFile } = {}) {
  const locations = [];
  for (const key of WINDOWS_UNINSTALL_KEYS) {
    try {
      locations.push(...parseWorkBuddyInstallLocations(await runFile(execFileImpl, "reg.exe", ["query", key, "/s"])));
    } catch {
      // Missing/denied registry hives remove this fallback only.
    }
  }
  return [...new Set(locations.map((item) => normalizePathKey(item, "win32")))]
    .map((installLocation) => ({ installLocation }));
}

function parseWorkBuddyInstallLocations(output) {
  const blocks = String(output || "").split(/\r?\n(?=HKEY_)/i);
  const locations = [];
  for (const block of blocks) {
    if (!/^\s*DisplayName\s+REG_\w+\s+WorkBuddy\s*$/im.test(block)) continue;
    const location = block.match(/^\s*InstallLocation\s+REG_\w+\s+(.+?)\s*$/im)?.[1];
    if (location) locations.push(location.trim());
  }
  return locations;
}

function compareVersionsDescending(left, right) { return right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }); }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function locatorError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { locateCodeBuddyDistribution, probeCodeBuddyCandidate, sanitizeCodeBuddyDistribution };
