const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { RESULT_CODES } = require("./result-codes");

function resolveCodexConfig({ env = process.env, cwd = process.cwd(), homedir = os.homedir() } = {}) {
  const runtime = normalizeText(env.CYBERBOSS_RUNTIME || "codex").toLowerCase();
  const command = normalizeText(env.CYBERBOSS_CODEX_COMMAND || "codex");
  const codexHome = path.resolve(normalizeText(env.CODEX_HOME) || path.join(homedir, ".codex"));
  const defaultCodexHome = path.resolve(path.join(homedir, ".codex"));
  const stateDir = path.resolve(normalizeText(env.CYBERBOSS_STATE_DIR) || path.join(homedir, ".cyberboss"));
  const configuredPort = normalizeText(env.CYBERBOSS_SHARED_PORT || "8765");
  const port = Number(configuredPort);

  if (runtime !== "codex" || !command || !Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      code: RESULT_CODES.CONFIG_INVALID,
      runtime,
      command,
      codexHome,
      defaultCodexHome,
      stateDir,
      cwd,
    };
  }

  return {
    ok: true,
    runtime,
    command,
    codexHome,
    defaultCodexHome,
    usesDedicatedCodexHome: normalizePath(codexHome) !== normalizePath(defaultCodexHome),
    stateDir,
    port,
    listenUrl: `ws://127.0.0.1:${port}`,
    pidFile: path.join(stateDir, "logs", "shared-app-server.pid"),
    logFile: path.join(stateDir, "logs", "shared-app-server.log"),
    loginLogFile: path.join(codexHome, "log", "codex-login.log"),
    cwd: path.resolve(cwd),
  };
}

function inspectCodexCommand(command, { fsImpl = fs } = {}) {
  if (!path.isAbsolute(command)) {
    return { ok: true, commandExists: null };
  }
  try {
    const stats = fsImpl.statSync(command);
    return stats.isFile()
      ? { ok: true, commandExists: true }
      : { ok: false, code: RESULT_CODES.CLI_NOT_FOUND, commandExists: false };
  } catch {
    return { ok: false, code: RESULT_CODES.CLI_NOT_FOUND, commandExists: false };
  }
}

function inspectCodexHome(codexHome, { fsImpl = fs } = {}) {
  try {
    if (fsImpl.existsSync(codexHome)) {
      fsImpl.accessSync(codexHome, fs.constants.R_OK | fs.constants.W_OK);
    } else {
      const parent = findExistingParent(codexHome, fsImpl);
      fsImpl.accessSync(parent, fs.constants.R_OK | fs.constants.W_OK);
    }
    return { ok: true, codexHomeWritable: true };
  } catch {
    return {
      ok: false,
      code: RESULT_CODES.CODEX_HOME_NOT_WRITABLE,
      codexHomeWritable: false,
    };
  }
}

function inspectAuthFile(codexHome, { fsImpl = fs } = {}) {
  const authFile = path.join(codexHome, "auth.json");
  try {
    if (!fsImpl.existsSync(authFile)) {
      return {
        ok: false,
        code: RESULT_CODES.AUTH_MISSING,
        authFile,
        credentialFileExists: false,
        credentialFileReopened: false,
      };
    }
    const raw = fsImpl.readFileSync(authFile, "utf8");
    if (!raw.trim()) {
      throw new Error("empty credential file");
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("credential file is not an object");
    }
    return {
      ok: true,
      authFile,
      credentialFileExists: true,
      credentialFileBytes: Buffer.byteLength(raw),
      credentialFileReopened: true,
    };
  } catch {
    return {
      ok: false,
      code: RESULT_CODES.AUTH_FILE_INVALID,
      authFile,
      credentialFileExists: true,
      credentialFileReopened: false,
    };
  }
}

function inspectLoginStatus(config, { runCommand = runCommandSync } = {}) {
  const result = runCommand(config.command, ["login", "status"], {
    cwd: config.cwd,
    env: { ...process.env, CODEX_HOME: config.codexHome },
  });
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      code: RESULT_CODES.CLI_NOT_FOUND,
      cliAuthMode: "none",
      commandStatus: null,
    };
  }
  const loggedIn = result.status === 0 && /logged in using chatgpt/i.test(combined);
  return loggedIn
    ? { ok: true, cliAuthMode: "chatgpt" }
    : {
        ok: false,
        code: RESULT_CODES.CLI_STATUS_UNAUTHENTICATED,
        cliAuthMode: "none",
        commandStatus: Number.isInteger(result.status) ? result.status : null,
      };
}

function classifyLoginLog(filePath, { fsImpl = fs } = {}) {
  let text = "";
  try {
    text = fsImpl.readFileSync(filePath, "utf8");
  } catch {
    return { loginLogState: "missing" };
  }
  let loginLogModifiedAt = 0;
  try {
    loginLogModifiedAt = Number(fsImpl.statSync(filePath).mtimeMs) || 0;
  } catch {
    // The classification remains useful even if metadata cannot be read.
  }
  const tail = text.slice(-64 * 1024);
  if (/token exchange|exchange.*token|oauth.*token.*(fail|error)/i.test(tail)) {
    return { loginLogState: "token_exchange_failed", loginLogModifiedAt };
  }
  if (/state_valid\s*[=:]\s*true|callback.*(received|valid|success)/i.test(tail)) {
    return { loginLogState: "callback_valid", loginLogModifiedAt };
  }
  if (/device.?auth|device code/i.test(tail)) {
    return { loginLogState: "device_auth_started", loginLogModifiedAt };
  }
  return { loginLogState: "callback_not_observed", loginLogModifiedAt };
}

function diagnoseCredentials(config, dependencies = {}) {
  const command = inspectCodexCommand(config.command, dependencies);
  const home = inspectCodexHome(config.codexHome, dependencies);
  const auth = inspectAuthFile(config.codexHome, dependencies);
  const status = inspectLoginStatus(config, dependencies);
  const loginLog = classifyLoginLog(config.loginLogFile, dependencies);
  const firstFailure = [command, home, auth, status].find((entry) => !entry.ok);
  return {
    ...command,
    ...home,
    ...auth,
    ...status,
    ...loginLog,
    ok: !firstFailure,
    code: firstFailure?.code || null,
  };
}

function runCommandSync(command, args, options) {
  const useShell = process.platform === "win32"
    && !(path.isAbsolute(command) && path.extname(command).toLowerCase() === ".exe");
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    windowsHide: true,
    shell: useShell,
  });
}

function findExistingParent(target, fsImpl) {
  let current = path.resolve(target);
  while (!fsImpl.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  resolveCodexConfig,
  inspectCodexCommand,
  inspectCodexHome,
  inspectAuthFile,
  inspectLoginStatus,
  classifyLoginLog,
  diagnoseCredentials,
};
