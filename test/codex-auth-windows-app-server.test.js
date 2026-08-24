const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  createWindowsAppServer,
  findListenerPids,
  verifyProcessIdentity,
} = require("../src/diagnostics/codex-auth/windows-app-server");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

function config(tempDir) {
  return {
    command: "C:\\Tools\\codex.exe",
    codexHome: "C:\\Profiles\\CyberBoss",
    cwd: tempDir,
    port: 8765,
    listenUrl: "ws://127.0.0.1:8765",
    pidFile: path.join(tempDir, "logs", "shared-app-server.pid"),
    logFile: path.join(tempDir, "logs", "shared-app-server.log"),
  };
}

test("Windows identity requires matching listener path, app-server argument and port", () => {
  const expected = config("C:\\work");
  assert.equal(verifyProcessIdentity({
    ExecutablePath: "C:\\Tools\\codex.exe",
    CommandLine: "codex.exe app-server --listen ws://127.0.0.1:8765",
  }, expected).verified, true);
  assert.equal(verifyProcessIdentity({
    ExecutablePath: "C:\\Tools\\other.exe",
    CommandLine: "other.exe app-server --listen ws://127.0.0.1:8765",
  }, expected).verified, false);
  assert.equal(verifyProcessIdentity({
    ExecutablePath: "C:\\Tools\\codex.exe",
    CommandLine: "codex.exe app-server --listen ws://127.0.0.1:9999",
  }, expected).verified, false);
});

test("Windows listener query includes a netstat fallback for restricted Get-NetTCPConnection", async () => {
  let scriptText = "";
  const pids = await findListenerPids(8765, {
    runPowerShell: async (script) => {
      scriptText = script;
      return "20468";
    },
  });
  assert.deepEqual(pids, [20468]);
  assert.match(scriptText, /netstat\.exe/);
  assert.match(scriptText, /:8765/);
});

test("Windows inspection marks a live but mismatched PID file stale", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-process-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const expected = config(tempDir);
  fs.mkdirSync(path.dirname(expected.pidFile), { recursive: true });
  fs.writeFileSync(expected.pidFile, "111\n");
  const runPowerShell = async (script) => script.includes("Get-NetTCPConnection")
    ? "222"
    : JSON.stringify({ ProcessId: 222, ExecutablePath: expected.command, CommandLine: `${expected.command} app-server --listen ${expected.listenUrl}` });
  const appServer = createWindowsAppServer({ runPowerShell, checkReady: async () => true });
  const inspected = await appServer.inspect(expected);
  assert.equal(inspected.pidFileState, "stale");
  assert.equal(inspected.listenerPid, 222);
  assert.equal(inspected.appServerIdentityVerified, true);
});

test("Windows restart never kills a listener whose identity cannot be proved", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-process-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let killedPid = 0;
  const expected = config(tempDir);
  const runPowerShell = async (script) => script.includes("Get-NetTCPConnection")
    ? "222"
    : JSON.stringify({ ProcessId: 222, ExecutablePath: "C:\\Windows\\notepad.exe", CommandLine: "notepad.exe" });
  const appServer = createWindowsAppServer({
    runPowerShell,
    checkReady: async () => true,
    killProcess: async (pid) => { killedPid = pid; },
  });
  const result = await appServer.restart(expected);
  assert.equal(result.code, RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED);
  assert.equal(killedPid, 0);
});

test("Windows restart stops only the verified listener and writes the new real listener PID", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-restart-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const expected = config(tempDir);
  let phase = "old";
  const killed = [];
  const runPowerShell = async (script) => {
    if (script.includes("Get-NetTCPConnection")) {
      return phase === "old" ? "222" : phase === "new" ? "333" : "";
    }
    const pid = phase === "old" ? 222 : 333;
    return JSON.stringify({
      ProcessId: pid,
      ExecutablePath: expected.command,
      CommandLine: `${expected.command} app-server --listen ${expected.listenUrl}`,
    });
  };
  const child = new EventEmitter();
  child.pid = 999;
  child.unref = () => {};
  const appServer = createWindowsAppServer({
    runPowerShell,
    checkReady: async () => true,
    sleep: async () => {},
    killProcess: async (pid) => {
      killed.push(pid);
      phase = "stopped";
    },
    spawnImpl: () => {
      phase = "new";
      return child;
    },
  });

  const result = await appServer.restart(expected);
  assert.equal(result.ok, true);
  assert.equal(result.restarted, true);
  assert.deepEqual(killed, [222]);
  assert.equal(result.spawnedPid, 999);
  assert.equal(result.listenerPid, 333);
  assert.equal(fs.readFileSync(expected.pidFile, "utf8").trim(), "333");
});
