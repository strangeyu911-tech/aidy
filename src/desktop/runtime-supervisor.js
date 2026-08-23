const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const { AtomicJsonStore } = require("../core/atomic-json-store");
const {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../adapters/runtime/codex/mcp-config");

class RuntimeSupervisor extends EventEmitter {
  constructor({ rootDir, stateDir, endpoint = "ws://127.0.0.1:8765", logger, env = process.env } = {}) {
    super();
    this.rootDir = rootDir;
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.logger = logger;
    this.env = env;
    this.desiredState = "stopped";
    this.phase = "stopped";
    this.children = new Map();
    this.externalAppServer = false;
    this.intentionalStop = false;
    this.restartTimes = [];
    this.plannedChildStops = new Set();
    this.retryTimer = null;
    this.instanceToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.registryStore = new AtomicJsonStore({
      filePath: path.join(stateDir, "owned-processes.json"),
      defaultValue: { schemaVersion: 1, processes: [] },
      normalize: normalizeProcessRegistry,
    });
    this.orphansChecked = false;
  }

  snapshot() {
    return {
      desiredState: this.desiredState,
      phase: this.phase,
      bridgePid: this.children.get("bridge")?.pid || 0,
      appServerPid: this.children.get("appserver")?.pid || 0,
      externalAppServer: this.externalAppServer,
      error: this.lastError || null,
    };
  }

  async setDesiredState(desiredState) {
    this.desiredState = desiredState;
    this.emitState();
    if (desiredState === "stopped") {
      await this.stop();
      return this.snapshot();
    }
    if (this.phase === "running" || this.phase === "quiet") {
      this.phase = desiredState;
      this.emitState();
      return this.snapshot();
    }
    await this.start();
    return this.snapshot();
  }

  async start() {
    if (this.desiredState === "stopped" || ["starting", "running", "quiet"].includes(this.phase)) return;
    this.intentionalStop = false;
    this.lastError = null;
    this.phase = "starting";
    this.logger?.info("runtime.starting", { desiredState: this.desiredState });
    this.emitState();
    try {
      if (!this.orphansChecked) {
        this.orphansChecked = true;
        await this.cleanupVerifiedOrphans();
      }
      await this.ensureAppServer();
      await this.startBridge();
      this.phase = this.desiredState === "quiet" ? "quiet" : "running";
      this.restartTimes = [];
      this.logger?.info("runtime.ready", { phase: this.phase });
      this.emitState();
    } catch (error) {
      this.lastError = friendlyProcessError(error);
      this.phase = "error";
      this.logger?.error("runtime.start_failed", { category: this.lastError.category, code: this.lastError.code });
      this.emitState();
      await this.stopChildren();
      throw error;
    }
  }

  async ensureAppServer() {
    const owned = this.children.get("appserver");
    if (owned && owned.exitCode == null && await checkReady(this.endpoint)) {
      this.externalAppServer = false;
      return;
    }
    if (await checkReady(this.endpoint)) {
      this.externalAppServer = true;
      this.logger?.info("appserver.attached", { endpoint: this.endpoint });
      return;
    }
    this.externalAppServer = false;
    const command = this.env.CYBERBOSS_CODEX_COMMAND || "codex";
    const mcpArgs = buildCodexMcpConfigArgs([
      resolveCodexProjectToolMcpServerConfig({ cyberbossHome: this.env.CYBERBOSS_HOME || this.rootDir }),
      ...resolveAdditionalMcpServerConfigs({ filePath: this.env.CYBERBOSS_MCP_SERVERS_FILE }),
    ]);
    const child = this.spawnOwned("appserver", command, [...mcpArgs, "app-server", "--listen", this.endpoint], {
      env: {
        CYBERBOSS_STATE_DIR: this.stateDir,
        TIMELINE_FOR_AGENT_STATE_DIR: this.stateDir,
      },
      shell: process.platform === "win32" && !path.isAbsolute(command),
    });
    const ready = await waitUntil(() => checkReady(this.endpoint), 30_000, 300, () => child.exitCode != null);
    if (!ready) throw processError("APP_SERVER_NOT_READY", "Codex 服务未能在 30 秒内启动。", "runtime");
  }

  async startBridge() {
    const existing = this.children.get("bridge");
    if (existing && existing.exitCode == null) return;
    const executable = process.execPath;
    const child = this.spawnOwned("bridge", executable, [path.join(this.rootDir, "bin", "cyberboss.js"), "start"], {
      env: {
        ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : undefined,
        CYBERBOSS_CODEX_ENDPOINT: this.endpoint,
        CYBERBOSS_STATE_DIR: this.stateDir,
        CYBERBOSS_ENABLE_CHECKIN: "0",
      },
    });
    const ready = await waitForBridgeReady(child, 45_000);
    if (!ready) throw processError("BRIDGE_NOT_READY", "微信桥接未能完成启动。", "bridge");
  }

  spawnOwned(component, command, args, { env = {}, shell = false } = {}) {
    const childEnv = { ...this.env, ...env, CYBERBOSS_INSTANCE_TOKEN: this.instanceToken };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const processHost = process.platform === "win32"
      ? path.join(this.rootDir, "native", "win32", "CyberBoss.ProcessHost.exe")
      : "";
    const useProcessHost = Boolean(processHost && require("fs").existsSync(processHost));
    const spawnCommand = useProcessHost ? processHost : command;
    const spawnArgs = useProcessHost ? [String(process.pid), command, ...args] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: this.rootDir,
      env: childEnv,
      shell: useProcessHost ? false : shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.__cyberbossReady = false;
    child.__cyberbossComponent = component;
    child.stdout?.on("data", (chunk) => this.handleOutput(component, chunk, false));
    child.stderr?.on("data", (chunk) => this.handleOutput(component, chunk, true));
    child.once("error", (error) => {
      this.logger?.error(`${component}.spawn_error`, { code: error.code || "SPAWN_ERROR" });
    });
    child.once("exit", (code, signal) => this.handleExit(component, child, code, signal));
    this.children.set(component, child);
    this.registryStore.update((registry) => ({
      ...registry,
      processes: [
        ...registry.processes.filter((item) => item.component !== component),
        {
          component,
          pid: child.pid,
          childPid: 0,
          executablePath: spawnCommand,
          commandPath: command,
          parentPid: process.pid,
          instanceToken: this.instanceToken,
          startedAt: new Date().toISOString(),
        },
      ],
    }));
    this.logger?.info(`${component}.spawned`, { pid: child.pid, jobObject: useProcessHost });
    this.emitState();
    return child;
  }

  handleOutput(component, chunk, isError) {
    const output = String(chunk || "");
    const child = this.children.get(component);
    if (child && component === "bridge" && output.includes("bridge loop started")) {
      child.__cyberbossReady = true;
    }
    const childPid = Number(output.match(/\[cyberboss-process-host\] child-pid=(\d+)/)?.[1] || 0);
    if (childPid) {
      this.registryStore.update((registry) => ({
        ...registry,
        processes: registry.processes.map((item) => item.component === component && item.pid === child?.pid ? { ...item, childPid } : item),
      }));
    }
    const category = isError ? "stderr" : "stdout";
    this.logger?.debug(`${component}.${category}`, { bytes: Buffer.byteLength(output) });
  }

  handleExit(component, child, code, signal) {
    if (this.children.get(component) === child) this.children.delete(component);
    this.registryStore.update((registry) => ({ ...registry, processes: registry.processes.filter((item) => item.pid !== child.pid) }));
    this.logger?.warn(`${component}.exited`, { code, signal, intentional: this.intentionalStop });
    this.emitState();
    if (this.plannedChildStops.delete(component)) return;
    if (this.intentionalStop || this.desiredState === "stopped") return;
    if (component === "appserver" && this.externalAppServer) return;
    this.phase = "starting";
    this.emitState();
    void this.prepareRestart(component);
  }

  async prepareRestart(component) {
    if (component === "appserver") {
      this.plannedChildStops.add("bridge");
      await stopChild(this.children.get("bridge"), 10_000);
      this.children.delete("bridge");
    }
    this.scheduleRestart(component);
  }

  scheduleRestart(component) {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((timestamp) => now - timestamp <= 10 * 60_000);
    this.restartTimes.push(now);
    if (this.restartTimes.length >= 3) {
      this.phase = "error";
      this.lastError = friendlyProcessError(processError(
        "RESTART_CIRCUIT_OPEN",
        `${component === "bridge" ? "微信桥接" : "Codex 服务"}在 10 分钟内连续退出 3 次，已暂停自动重启。`,
        component
      ));
      this.emitState();
      return;
    }
    const delay = [1_000, 5_000, 30_000][Math.min(this.restartTimes.length - 1, 2)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.desiredState !== "stopped") {
        this.phase = "stopped";
        this.start().catch(() => {});
      }
    }, delay);
  }

  async retry() {
    this.restartTimes = [];
    this.phase = "stopped";
    this.lastError = null;
    await this.start();
  }

  async stop() {
    this.intentionalStop = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.phase !== "stopped") {
      this.phase = "stopping";
      this.emitState();
    }
    await this.stopChildren();
    this.phase = "stopped";
    this.lastError = null;
    this.logger?.info("runtime.stopped", {});
    this.emitState();
  }

  async stopChildren() {
    await stopChild(this.children.get("bridge"), 10_000);
    this.children.delete("bridge");
    if (!this.externalAppServer) {
      await stopChild(this.children.get("appserver"), 15_000);
    }
    this.children.delete("appserver");
  }

  emitState() {
    this.emit("state", this.snapshot());
  }

  async cleanupVerifiedOrphans() {
    if (process.platform !== "win32") return;
    const registry = this.registryStore.read();
    const remaining = [];
    for (const entry of registry.processes) {
      if (!isProcessAlive(entry.pid)) continue;
      const details = await inspectWindowsProcess(entry.pid);
      const sameExecutable = normalizeWindowsPath(details.executablePath) === normalizeWindowsPath(entry.executablePath);
      const startDelta = Math.abs(Date.parse(details.startedAt || "") - Date.parse(entry.startedAt || ""));
      const parentGone = !isProcessAlive(entry.parentPid);
      if (sameExecutable && Number.isFinite(startDelta) && startDelta <= 5_000 && parentGone) {
        await terminateProcessTree(entry.pid);
        this.logger?.warn("process.orphan_removed", { component: entry.component, pid: entry.pid });
        continue;
      }
      remaining.push(entry);
      this.logger?.warn("process.orphan_ambiguous", { component: entry.component, pid: entry.pid });
    }
    this.registryStore.write({ schemaVersion: 1, processes: remaining });
  }
}

async function stopChild(child, timeoutMs) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  const exited = await waitUntil(() => child.exitCode != null, timeoutMs, 100);
  if (!exited && child.pid) await terminateProcessTree(child.pid);
}

function terminateProcessTree(pid) {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("exit", resolve);
    killer.once("error", resolve);
  });
}

function waitForBridgeReady(child, timeoutMs) {
  return waitUntil(() => child.__cyberbossReady === true, timeoutMs, 100, () => child.exitCode != null);
}

function checkReady(endpoint) {
  const parsed = new URL(endpoint.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
  return new Promise((resolve) => {
    const request = http.get({ hostname: parsed.hostname, port: parsed.port, path: "/readyz", timeout: 500 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => { request.destroy(); resolve(false); });
  });
}

async function waitUntil(predicate, timeoutMs, intervalMs, aborted = () => false) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (aborted()) return false;
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function processError(code, message, capability) {
  const error = new Error(message);
  error.code = code;
  error.capability = capability;
  return error;
}

function friendlyProcessError(error) {
  return {
    category: "process",
    code: error?.code || "PROCESS_ERROR",
    capability: error?.capability || "runtime",
    summary: error?.message || "后台服务启动失败。",
    repairAction: "重试启动",
    timestamp: new Date().toISOString(),
  };
}

function normalizeProcessRegistry(value) {
  const processes = Array.isArray(value?.processes) ? value.processes.filter((item) => (
    item && Number.isInteger(Number(item.pid)) && Number(item.pid) > 0 && typeof item.component === "string"
  )).map((item) => ({
    component: item.component,
    pid: Number(item.pid),
    childPid: Number(item.childPid) || 0,
    executablePath: String(item.executablePath || ""),
    commandPath: String(item.commandPath || ""),
    parentPid: Number(item.parentPid) || 0,
    instanceToken: String(item.instanceToken || ""),
    startedAt: Number.isFinite(Date.parse(item.startedAt || "")) ? new Date(item.startedAt).toISOString() : "",
  })) : [];
  return { schemaVersion: 1, processes };
}

function isProcessAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function inspectWindowsProcess(pid) {
  return new Promise((resolve) => {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if($p){[pscustomobject]@{executablePath=$p.ExecutablePath;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.once("error", () => resolve({}));
    child.once("exit", () => {
      try { resolve(JSON.parse(stdout.trim() || "{}")); } catch { resolve({}); }
    });
  });
}

function normalizeWindowsPath(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

module.exports = { RuntimeSupervisor, checkReady, friendlyProcessError, normalizeProcessRegistry, waitUntil };
