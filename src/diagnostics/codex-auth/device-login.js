const path = require("path");
const { spawn } = require("child_process");
const { RESULT_CODES } = require("./result-codes");

async function runDeviceLogin(config, {
  spawnImpl = spawn,
  verifyCredentials,
  timeoutMs = 15 * 60_000,
} = {}) {
  if (typeof verifyCredentials !== "function") {
    throw new Error("runDeviceLogin requires verifyCredentials");
  }

  const startedAt = Date.now();

  const useShell = process.platform === "win32"
    && !(path.isAbsolute(config.command) && path.extname(config.command).toLowerCase() === ".exe");
  const child = spawnImpl(config.command, ["login", "--device-auth"], {
    cwd: config.cwd,
    env: { ...process.env, CODEX_HOME: config.codexHome },
    stdio: "inherit",
    windowsHide: false,
    shell: useShell,
  });

  const exit = await waitForExit(child, timeoutMs);
  const verification = await verifyCredentials();
  if (exit.timedOut || exit.code !== 0) {
    return {
      ok: false,
      code: verification.loginLogState === "token_exchange_failed"
        && Number(verification.loginLogModifiedAt) >= startedAt - 1_000
        ? RESULT_CODES.AUTH_NETWORK_FAILED
        : RESULT_CODES.DEVICE_AUTH_FAILED,
      deviceLoginExitCode: exit.code,
      deviceLoginTimedOut: exit.timedOut,
      verification,
    };
  }

  return verification.ok
    ? { ok: true, deviceLoginCompleted: true, verification }
    : {
        ok: false,
        code: verification.code || RESULT_CODES.DEVICE_AUTH_FAILED,
        deviceLoginCompleted: true,
        verification,
      };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best effort
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.once("error", () => finish({ code: null, timedOut: false }));
    child.once("exit", (code) => finish({ code, timedOut: false }));
  });
}

module.exports = { runDeviceLogin };
