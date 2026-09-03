const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const TASK_NAME = "\\Aidy\\Aidy 桌面控制中心";
const LEGACY_DESKTOP_TASK_NAME = "\\CyberBoss\\CyberBoss 桌面控制中心";
const LEGACY_TASK_NAME = "\\CyberBoss\\CyberBoss 自动运行";

class WindowsTaskService {
  constructor({ rootDir, stateDir, executable, args, entryScript, workingDirectory, logger } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.stateDir = path.resolve(stateDir);
    this.executable = path.resolve(executable);
    this.args = Array.isArray(args) ? args.map((value) => String(value)) : (entryScript ? [path.resolve(entryScript)] : []);
    this.workingDirectory = path.resolve(workingDirectory || path.dirname(this.executable));
    this.logger = logger;
  }

  async install({ enabled = true } = {}) {
    if (process.platform !== "win32") return { supported: false };
    if (!fs.existsSync(this.executable)) {
      throw Object.assign(new Error(`Aidy packaged executable does not exist: ${this.executable}`), { code: "WINDOWS_TASK_RUNTIME_MISSING" });
    }
    const taskDir = path.join(this.stateDir, "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const xmlPath = path.join(taskDir, "cyberboss-desktop-task.xml");
    fs.writeFileSync(xmlPath, `\uFEFF${buildTaskXml({
      executable: this.executable,
      args: this.args,
      workingDirectory: this.workingDirectory,
      userId: resolveTaskUserId(),
    })}`, "utf16le");
    await runWindowsCommand("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);
    if (!enabled) await this.setEnabled(false);
    this.logger?.info("windows_task.installed", { enabled });
    return { supported: true, installed: true, enabled };
  }

  async setEnabled(enabled) {
    if (process.platform !== "win32") return { supported: false };
    if (!(await this.exists())) await this.install({ enabled });
    else await runWindowsCommand("schtasks.exe", ["/Change", "/TN", TASK_NAME, enabled ? "/Enable" : "/Disable"]);
    this.logger?.info("windows_task.changed", { enabled });
    return { supported: true, installed: true, enabled };
  }

  async exists(taskName = TASK_NAME) {
    if (process.platform !== "win32") return false;
    try {
      await runWindowsCommand("schtasks.exe", ["/Query", "/TN", taskName]);
      return true;
    } catch {
      return false;
    }
  }

  async migrateLegacy({ stopOwnedProcess } = {}) {
    const legacyExists = await this.exists(LEGACY_TASK_NAME);
    if (!legacyExists) {
      await this.install({ enabled: true });
      return { legacyFound: false, installed: true };
    }
    await runWindowsCommand("schtasks.exe", ["/Change", "/TN", LEGACY_TASK_NAME, "/Disable"]);
    await runWindowsCommand("schtasks.exe", ["/End", "/TN", LEGACY_TASK_NAME]).catch(() => {});
    await stopOwnedProcess?.();
    await this.install({ enabled: true });
    if (!(await this.exists(TASK_NAME))) throw Object.assign(new Error("New Aidy desktop task could not be validated."), { code: "WINDOWS_TASK_VALIDATION_FAILED" });
    await runWindowsCommand("schtasks.exe", ["/Delete", "/TN", LEGACY_TASK_NAME, "/F"]);
    await runWindowsCommand("schtasks.exe", ["/Delete", "/TN", LEGACY_DESKTOP_TASK_NAME, "/F"]).catch(() => {});
    this.logger?.info("windows_task.legacy_migrated", {});
    return { legacyFound: true, installed: true, legacyRemoved: true };
  }
}

function buildTaskXml({ executable, args = [], workingDirectory, userId }) {
  const commandArgs = args.map(quoteWindowsArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Aidy desktop controller and crash watchdog</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(executable)}</Command><Arguments>${escapeXml(commandArgs)}</Arguments><WorkingDirectory>${escapeXml(workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

function resolveTaskUserId() {
  const domain = process.env.USERDOMAIN || os.hostname();
  const user = process.env.USERNAME || os.userInfo().username;
  return `${domain}\\${user}`;
}

function quoteWindowsArgument(value) {
  const text = String(value || "");
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function escapeXml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function runWindowsCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `Command exited with ${code}`), { code: "WINDOWS_TASK_COMMAND_FAILED" })));
  });
}

module.exports = { LEGACY_DESKTOP_TASK_NAME, LEGACY_TASK_NAME, TASK_NAME, WindowsTaskService, buildTaskXml, escapeXml, quoteWindowsArgument };
