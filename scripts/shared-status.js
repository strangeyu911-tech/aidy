const http = require("http");
const {
  listenUrl,
  appServerPidFile,
  bridgePidFile,
  readPidFile,
  isPidAlive,
  buildSharedAppServerConfig,
} = require("./shared-common");
const { createWindowsAppServer } = require("../src/diagnostics/codex-auth/windows-app-server");

async function main() {
  const runtime = process.env.CYBERBOSS_RUNTIME || "codex";
  const isCodex = runtime === "codex";
  console.log(`runtime=${runtime}`);
  console.log(`listen=${listenUrl}`);
  if (isCodex && process.platform === "win32") {
    await printWindowsAppServerState();
  } else {
    printPidState("shared_app_server_pid", appServerPidFile);
  }
  printPidState("shared_cyberboss_pid", bridgePidFile);
  if (!isCodex) {
    console.log(`readyz=skipped`);
  } else {
    console.log(`readyz=${await checkReadyz() ? "ok" : "down"}`);
  }
}

async function printWindowsAppServerState() {
  try {
    const inspected = await createWindowsAppServer().inspect(buildSharedAppServerConfig());
    console.log(`shared_app_server_pid_file=${inspected.pidFilePid || "missing"}`);
    console.log(`shared_app_server_listener_pid=${inspected.listenerPid || "missing"}`);
    console.log(`shared_app_server_pid_state=${inspected.pidFileState || "unknown"}`);
    console.log(`shared_app_server_identity=${inspected.appServerIdentityVerified ? "verified" : "unverified"}`);
  } catch (error) {
    console.log(`shared_app_server_listener_pid=unknown`);
    console.log(`shared_app_server_pid_state=unknown`);
    console.log(`shared_app_server_identity=unverified`);
    console.log(`shared_app_server_inspection_error=${String(error?.message || error).slice(0, 200)}`);
  }
}

function printPidState(label, filePath) {
  const pid = readPidFile(filePath);
  if (!pid) {
    console.log(`${label}=missing`);
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`${label}=stale`);
    return;
  }
  console.log(`${label}=${pid}`);
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: new URL(listenUrl).port,
        path: "/readyz",
        timeout: 600,
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

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
