const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { WindowsTaskService } = require("../src/desktop/windows-task-service");
const { isPidAlive, readPidFile } = require("./shared-common");

const rootDir = path.resolve(__dirname, "..");
const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");
const packagedExecutable = path.join(rootDir, "dist", "win-unpacked", "CyberBoss.exe");

async function main() {
  const action = String(process.argv[2] || "status").toLowerCase();
  if (["install", "install-disabled", "enable", "migrate"].includes(action) && !fs.existsSync(packagedExecutable)) {
    throw new Error(`CyberBoss packaged executable does not exist: ${packagedExecutable}`);
  }
  const service = new WindowsTaskService({
    rootDir,
    stateDir,
    executable: packagedExecutable,
    args: [],
    workingDirectory: path.dirname(packagedExecutable),
  });
  if (action === "install") console.log(JSON.stringify(await service.install({ enabled: true })));
  else if (action === "install-disabled") console.log(JSON.stringify(await service.install({ enabled: false })));
  else if (action === "enable") console.log(JSON.stringify(await service.setEnabled(true)));
  else if (action === "disable") console.log(JSON.stringify(await service.setEnabled(false)));
  else if (action === "migrate") console.log(JSON.stringify(await service.migrateLegacy({ stopOwnedProcess: stopVerifiedLegacyProcesses })));
  else console.log(JSON.stringify({ installed: await service.exists(), legacyInstalled: await service.exists("\\CyberBoss\\CyberBoss 自动运行") }));
}

async function stopVerifiedLegacyProcesses() {
  const logDir = path.join(stateDir, "logs");
  for (const [name, expectedText] of [["shared-wechat.pid", rootDir.toLowerCase()], ["shared-app-server.pid", "app-server"]]) {
    const pid = readPidFile(path.join(logDir, name));
    if (!pid || !isPidAlive(pid)) continue;
    const commandLine = await readCommandLine(pid);
    if (!commandLine.toLowerCase().includes(expectedText)) continue;
    await terminateTree(pid);
  }
}

function readCommandLine(pid) {
  const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`;
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).then((result) => result.stdout.trim()).catch(() => "");
}

function terminateTree(pid) {
  return run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => null);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || `exit ${code}`)));
  });
}

main().catch((error) => { console.error(error.message || String(error)); process.exitCode = 1; });
