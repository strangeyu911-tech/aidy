const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../src/adapters/runtime/codex/mcp-config");
const { normalizeWorkspaceRoot } = require("../src/core/workspace-path");
const { createWindowsAppServer } = require("../src/diagnostics/codex-auth/windows-app-server");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch {
  // ignore
}

try {
  require("dotenv").config({ path: path.join(os.homedir(), ".cyberboss", ".env") });
} catch {
  // ignore
}

const rootDir = path.resolve(__dirname, "..");
const port = String(process.env.CYBERBOSS_SHARED_PORT || "8765");
const listenUrl = `ws://127.0.0.1:${port}`;
const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const logDir = path.join(stateDir, "logs");
const appServerPidFile = path.join(logDir, "shared-app-server.pid");
const bridgePidFile = path.join(logDir, "shared-wechat.pid");
const appServerLogFile = path.join(logDir, "shared-app-server.log");
const accountsDir = path.join(stateDir, "accounts");
const sessionFile = process.env.CYBERBOSS_SESSIONS_FILE || path.join(stateDir, "sessions.json");

function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function removePidFileIfMatches(filePath, pid) {
  const current = readPidFile(filePath);
  if (current && current === pid) {
    fs.rmSync(filePath, { force: true });
  }
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/readyz",
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReadyz({ attempts = 10, delayMs = 300 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReadyz()) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openLogFile(filePath) {
  return fs.openSync(filePath, "a");
}

function spawnDetachedCommand(command, args, { logFile, cwd = rootDir, env = {} } = {}) {
  const stdoutFd = openLogFile(logFile);
  const stderrFd = openLogFile(logFile);
  const useShell = process.platform === "win32"
    && !(path.isAbsolute(command) && path.extname(command).toLowerCase() === ".exe");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: useShell,
  });
  child.unref();
  return child.pid;
}

async function ensureSharedAppServer() {
  if (process.env.CYBERBOSS_RUNTIME && process.env.CYBERBOSS_RUNTIME !== "codex") {
    return { pid: 0, status: "skipped" };
  }

  ensureLogDir();
  if (process.platform === "win32") {
    const adapter = createWindowsAppServer();
    const config = buildSharedAppServerConfig();
    const inspected = await adapter.inspect(config);
    const decision = classifyWindowsAppServerInspection(inspected);
    if (inspected.listenerPid) {
      if (decision.identityVerified) {
        if (inspected.pidFilePid !== inspected.listenerPid) {
          writePidFile(appServerPidFile, inspected.listenerPid);
        }
        return {
          pid: inspected.listenerPid,
          status: decision.status,
          identityVerified: true,
        };
      }
      return {
        pid: inspected.listenerPid,
        status: decision.status,
        identityVerified: false,
      };
    }
    const started = await adapter.start(config);
    if (!started.ok) {
      throw new Error(`failed to start shared app-server safely; check ${appServerLogFile}`);
    }
    return { pid: started.listenerPid, status: "started", identityVerified: true };
  }

  const pidFromFile = readPidFile(appServerPidFile);
  if (pidFromFile && isPidAlive(pidFromFile) && (await checkReadyz())) {
    return { pid: pidFromFile, status: "already_running" };
  }

  if (await checkReadyz()) {
    return { pid: pidFromFile || 0, status: "already_running_unknown_pid" };
  }

  const env = {
    CYBERBOSS_STATE_DIR: stateDir,
    TIMELINE_FOR_AGENT_STATE_DIR: stateDir,
  };
  if (!process.env.TIMELINE_FOR_AGENT_CHROME_PATH) {
    env.TIMELINE_FOR_AGENT_CHROME_PATH =
      process.env.CYBERBOSS_SCREENSHOT_CHROME_PATH
      || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "");
  }

  const command = process.env.CYBERBOSS_CODEX_COMMAND || "codex";
  const mcpConfigArgs = buildCodexMcpConfigArgs([
    resolveCodexProjectToolMcpServerConfig({
      cyberbossHome: process.env.CYBERBOSS_HOME || rootDir,
    }),
    ...resolveAdditionalMcpServerConfigs({
      filePath: process.env.CYBERBOSS_MCP_SERVERS_FILE,
    }),
  ]);
  const pid = spawnDetachedCommand(command, [...mcpConfigArgs, "app-server", "--listen", listenUrl], {
    logFile: appServerLogFile,
    env,
  });
  writePidFile(appServerPidFile, pid);

  const ready = await waitForReadyz();
  if (!ready) {
    throw new Error(`failed to start shared app-server; check ${appServerLogFile}`);
  }

  writePidFile(appServerPidFile, pid);
  return { pid, status: "started" };
}

function ensureBridgeNotRunning() {
  const pidFromFile = readPidFile(bridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    fs.rmSync(bridgePidFile, { force: true });
  }
  return 0;
}

function resolveCurrentAccountId() {
  if (!fs.existsSync(accountsDir)) {
    return "";
  }
  const entries = fs.readdirSync(accountsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    .map((name) => {
      const fullPath = path.join(accountsDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        return {
          accountId: normalizeText(parsed?.accountId),
          savedAt: parseTimestamp(parsed?.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.accountId);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  return entries[0]?.accountId || "";
}

function resolveBoundThread(workspaceRoot) {
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`session file not found: ${sessionFile}`);
  }
  const runtimeId = normalizeText(process.env.CYBERBOSS_RUNTIME || "codex");
  const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const currentAccountId = resolveCurrentAccountId();
  const bindings = Object.values(data.bindings || {})
    .filter((binding) => !currentAccountId || normalizeText(binding?.accountId) === currentAccountId)
    .sort((left, right) => parseTimestamp(right?.updatedAt) - parseTimestamp(left?.updatedAt));

  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const exact = bindings.find((binding) => getThreadId(binding, normalizedWorkspaceRoot, runtimeId));
  if (exact) {
    return {
      threadId: getThreadId(exact, normalizedWorkspaceRoot, runtimeId),
      workspaceRoot: normalizedWorkspaceRoot,
    };
  }

  const active = bindings.find((binding) => {
    const activeWorkspaceRoot = normalizeWorkspaceRoot(binding?.activeWorkspaceRoot);
    return activeWorkspaceRoot && getThreadId(binding, activeWorkspaceRoot, runtimeId);
  });
  if (active) {
    const activeWorkspaceRoot = normalizeWorkspaceRoot(active.activeWorkspaceRoot);
    return {
      threadId: getThreadId(active, activeWorkspaceRoot, runtimeId),
      workspaceRoot: activeWorkspaceRoot,
    };
  }

  throw new Error(`no bound WeChat thread found for workspace: ${workspaceRoot}`);
}

function getThreadId(binding, workspaceRoot, runtimeId = "") {
  if (!workspaceRoot) {
    return "";
  }
  const map = getThreadMapForRuntime(binding, runtimeId);
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const exact = map[normalizedWorkspaceRoot];
  if (exact) {
    return normalizeText(exact);
  }
  const alias = Object.entries(map).find(([candidateRoot]) => (
    normalizeWorkspaceRoot(candidateRoot) === normalizedWorkspaceRoot
  ));
  return normalizeText(alias?.[1]);
}

function classifyWindowsAppServerInspection(inspected) {
  if (!inspected?.listenerPid) {
    return { status: "start_required", identityVerified: false };
  }
  if (!inspected.appServerIdentityVerified) {
    return { status: "already_running_unknown_identity", identityVerified: false };
  }
  return {
    status: inspected.pidFilePid !== inspected.listenerPid
      ? "already_running_pid_repaired"
      : "already_running",
    identityVerified: true,
  };
}

function buildSharedAppServerConfig() {
  const command = process.env.CYBERBOSS_CODEX_COMMAND || "codex";
  const mcpConfigArgs = buildCodexMcpConfigArgs([
    resolveCodexProjectToolMcpServerConfig({
      cyberbossHome: process.env.CYBERBOSS_HOME || rootDir,
    }),
    ...resolveAdditionalMcpServerConfigs({
      filePath: process.env.CYBERBOSS_MCP_SERVERS_FILE,
    }),
  ]);
  return {
    command,
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    cwd: rootDir,
    port: Number(port),
    listenUrl,
    pidFile: appServerPidFile,
    logFile: appServerLogFile,
    appServerPrefixArgs: mcpConfigArgs,
    appServerEnv: {
      CYBERBOSS_STATE_DIR: stateDir,
      TIMELINE_FOR_AGENT_STATE_DIR: stateDir,
    },
  };
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeText(runtimeId);
  const runtimeMap = binding && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function parseTimestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rootDir,
  port,
  listenUrl,
  stateDir,
  logDir,
  appServerPidFile,
  bridgePidFile,
  appServerLogFile,
  ensureLogDir,
  isPidAlive,
  readPidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  buildSharedAppServerConfig,
  classifyWindowsAppServerInspection,
  ensureBridgeNotRunning,
  resolveBoundThread,
};
