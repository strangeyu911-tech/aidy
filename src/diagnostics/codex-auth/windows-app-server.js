const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { RESULT_CODES } = require("./result-codes");

function createWindowsAppServer({
  runPowerShell = runPowerShellCommand,
  spawnImpl = spawn,
  fsImpl = fs,
  killProcess = defaultKillProcess,
  checkReady = checkReadyz,
  sleep = delay,
} = {}) {
  async function inspect(config) {
    const listenerPids = await findListenerPids(config.port, { runPowerShell });
    const pidFilePid = readPidFile(config.pidFile, fsImpl);
    const readyz = await checkReady(config.port);
    if (listenerPids.length === 0) {
      return {
        ok: false,
        code: RESULT_CODES.APP_SERVER_NOT_RUNNING,
        listenerPids,
        listenerPid: 0,
        pidFilePid,
        pidFileState: pidFilePid ? "stale" : "missing",
        appServerIdentityVerified: false,
        readyz,
      };
    }
    if (listenerPids.length !== 1) {
      return {
        ok: false,
        code: RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED,
        listenerPids,
        listenerPid: 0,
        pidFilePid,
        pidFileState: "unknown",
        appServerIdentityVerified: false,
        readyz,
      };
    }

    const listenerPid = listenerPids[0];
    const processInfo = await getProcessInfo(listenerPid, { runPowerShell });
    const identity = verifyProcessIdentity(processInfo, config);
    return {
      ok: identity.verified,
      code: identity.verified ? null : RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED,
      listenerPids,
      listenerPid,
      pidFilePid,
      pidFileState: !pidFilePid ? "missing" : pidFilePid === listenerPid ? "match" : "stale",
      appServerIdentityVerified: identity.verified,
      identityEvidence: identity.evidence,
      processInfo,
      readyz,
    };
  }

  async function start(config) {
    const before = await inspect(config);
    if (before.listenerPids.length) {
      return before.ok
        ? { ...before, started: false }
        : before;
    }

    let stdoutFd = null;
    let stderrFd = null;
    const args = [
      ...(Array.isArray(config.appServerPrefixArgs) ? config.appServerPrefixArgs : []),
      "app-server",
      "--listen",
      config.listenUrl,
    ];
    let child;
    try {
      fsImpl.mkdirSync(path.dirname(config.logFile), { recursive: true });
      stdoutFd = fsImpl.openSync(config.logFile, "a");
      stderrFd = fsImpl.openSync(config.logFile, "a");
      const useShell = !(path.isAbsolute(config.command)
        && path.extname(config.command).toLowerCase() === ".exe");
      child = spawnImpl(config.command, args, {
        cwd: config.cwd,
        env: { ...process.env, CODEX_HOME: config.codexHome, ...(config.appServerEnv || {}) },
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        shell: useShell,
        windowsHide: true,
      });
      child.once("error", () => {
        // waitForReady converts asynchronous spawn failures to APP_SERVER_START_FAILED.
      });
      child.unref();
    } catch {
      return { ok: false, code: RESULT_CODES.APP_SERVER_START_FAILED, started: false };
    } finally {
      if (stdoutFd != null) {
        try { fsImpl.closeSync(stdoutFd); } catch { /* best effort */ }
      }
      if (stderrFd != null) {
        try { fsImpl.closeSync(stderrFd); } catch { /* best effort */ }
      }
    }

    const ready = await waitForReady(config.port, { checkReady, sleep });
    if (!ready) {
      return {
        ok: false,
        code: RESULT_CODES.APP_SERVER_START_FAILED,
        spawnedPid: child.pid,
        started: true,
      };
    }
    const after = await inspect(config);
    if (!after.ok) {
      return { ...after, started: true, spawnedPid: child.pid };
    }
    writePidFile(config.pidFile, after.listenerPid, fsImpl);
    return { ...after, started: true, spawnedPid: child.pid };
  }

  async function restart(config) {
    const before = await inspect(config);
    if (!before.appServerIdentityVerified || !before.listenerPid) {
      return {
        ...before,
        ok: false,
        code: RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED,
        restarted: false,
      };
    }
    await killProcess(before.listenerPid);
    const stopped = await waitForNoListener(config.port, { runPowerShell, sleep });
    if (!stopped) {
      return { ...before, ok: false, code: RESULT_CODES.APP_SERVER_START_FAILED, restarted: false };
    }
    const started = await start(config);
    return { ...started, restarted: started.ok };
  }

  return { inspect, start, restart };
}

async function findListenerPids(port, { runPowerShell = runPowerShellCommand } = {}) {
  const numericPort = Number(port);
  const script = [
    `$items = @()` ,
    `try { $items = @(Get-NetTCPConnection -State Listen -LocalPort ${numericPort} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { $items = @() }`,
    `if ($items.Count -eq 0) {`,
    `  $items = @(netstat.exe -ano -p tcp | ForEach-Object { if ($_ -match '^\\s*TCP\\s+\\S+:${numericPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$') { [int]$Matches[1] } } | Select-Object -Unique)`,
    `}`,
    `$items | ConvertTo-Json -Compress`,
  ].join("; ");
  const output = String(await runPowerShell(script) || "").trim();
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return [...new Set(values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
}

async function getProcessInfo(pid, { runPowerShell = runPowerShellCommand } = {}) {
  const numericPid = Number(pid);
  const script = [
    `$item = $null`,
    `try { $item = Get-CimInstance Win32_Process -Filter 'ProcessId = ${numericPid}' -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine } catch {`,
    `  $process = Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue`,
    `  if ($process) { $item = [PSCustomObject]@{ ProcessId = $process.Id; ExecutablePath = $process.Path; CommandLine = $null } }`,
    `}`,
    `$item | ConvertTo-Json -Compress`,
  ].join("; ");
  const output = String(await runPowerShell(script) || "").trim();
  return output ? JSON.parse(output) : null;
}

function verifyProcessIdentity(processInfo, config) {
  const actualPath = normalizePath(processInfo?.ExecutablePath);
  const expectedPath = path.isAbsolute(config.command) ? normalizePath(config.command) : "";
  const commandLine = String(processInfo?.CommandLine || "");
  const pathMatches = Boolean(actualPath && expectedPath && actualPath === expectedPath);
  const appServerMatches = /(^|\s|["'])app-server(?=$|\s|["'])/i.test(commandLine);
  const portMatches = commandLine.includes(`:${config.port}`)
    || new RegExp(`(?:--port(?:=|\\s+)|--listen[^\\r\\n]*:)${config.port}(?:\\D|$)`, "i").test(commandLine);
  return {
    verified: pathMatches && appServerMatches && portMatches,
    evidence: { pathMatches, appServerMatches, portMatches },
  };
}

function runPowerShellCommand(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function checkReadyz(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/readyz", timeout: 700 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForReady(port, { checkReady, sleep }, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReady(port)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function waitForNoListener(port, { runPowerShell, sleep }, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if ((await findListenerPids(port, { runPowerShell })).length === 0) {
      return true;
    }
    await sleep(150);
  }
  return false;
}

function readPidFile(filePath, fsImpl = fs) {
  try {
    const pid = Number.parseInt(fsImpl.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function normalizePath(value) {
  return typeof value === "string" && value.trim()
    ? path.resolve(value.trim()).toLowerCase()
    : "";
}

function defaultKillProcess(pid) {
  process.kill(pid, "SIGTERM");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createWindowsAppServer,
  findListenerPids,
  getProcessInfo,
  verifyProcessIdentity,
  readPidFile,
  writePidFile,
};
