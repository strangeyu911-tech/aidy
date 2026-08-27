const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const { AtomicJsonStore } = require("../core/atomic-json-store");
const { computeVerificationFingerprint } = require("../core/provider-profile-store");
const { getRuntimeDefinition } = require("../core/runtime-registry");
const { BridgeControlClient } = require("./bridge-control-client");
const {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../adapters/runtime/codex/mcp-config");

class RuntimeSupervisor extends EventEmitter {
  constructor({
    rootDir,
    stateDir,
    endpoint = "ws://127.0.0.1:8765",
    logger,
    env = process.env,
    profileStore = null,
    bridgeClientFactory = (options) => new BridgeControlClient(options),
    now = () => Date.now(),
  } = {}) {
    super();
    this.rootDir = rootDir;
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.logger = logger;
    this.env = env;
    this.profileStore = profileStore;
    this.bridgeClientFactory = bridgeClientFactory;
    this.now = now;
    this.desiredState = "stopped";
    this.phase = "stopped";
    this.children = new Map();
    this.externalAppServer = false;
    this.intentionalStop = false;
    this.restartTimes = [];
    this.plannedChildStops = new Set();
    this.retryTimer = null;
    this.bridgeClient = null;
    this.bridgeControlToken = "";
    this.bridgeControlPort = 0;
    this.healthyProfileId = "";
    this.switchTransaction = null;
    this.switchPromise = null;
    this.instanceToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.registryStore = new AtomicJsonStore({
      filePath: path.join(stateDir, "owned-processes.json"),
      defaultValue: { schemaVersion: 1, processes: [] },
      normalize: normalizeProcessRegistry,
    });
    this.switchJournalStore = new AtomicJsonStore({
      filePath: path.join(stateDir, "runtime-switch.json"),
      defaultValue: { schemaVersion: 1, transaction: null },
      normalize: normalizeSwitchJournal,
    });
    this.switchTransaction = this.switchJournalStore.read().transaction;
    this.orphansChecked = false;
  }

  snapshot() {
    return {
      desiredState: this.desiredState,
      phase: this.phase,
      bridgePid: this.children.get("bridge")?.pid || 0,
      appServerPid: this.children.get("appserver")?.pid || 0,
      externalAppServer: this.externalAppServer,
      activeProfileId: this.healthyProfileId,
      selectedProfileId: normalizeText(this.profileStore?.getActive?.()?.id),
      switchTransaction: this.switchTransaction ? { ...this.switchTransaction } : null,
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
    try {
      this.requireVerifiedProfile(this.profileStore?.getActive?.(), "NO_ACTIVE_ENGINE");
    } catch (error) {
      this.phase = "configuration_required";
      this.lastError = friendlyProfileError(error);
      this.emitState();
      throw error;
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
    let activeProfile;
    try {
      activeProfile = this.requireVerifiedProfile(this.profileStore?.getActive?.(), "NO_ACTIVE_ENGINE");
    } catch (error) {
      this.phase = "configuration_required";
      this.lastError = friendlyProfileError(error);
      this.healthyProfileId = "";
      this.emitState();
      throw error;
    }
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
      await this.startProfileRuntime(activeProfile);
      await this.probeProfile(activeProfile);
      this.healthyProfileId = activeProfile.id;
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
      this.healthyProfileId = "";
      throw error;
    }
  }

  async startProfileRuntime(profile) {
    const definition = getRuntimeDefinition(profile.runtimeId);
    if (definition.processKind === "codex") await this.ensureAppServer();
    await this.startBridge(profile);
  }

  async probeProfile(profile) {
    if (!this.bridgeClient) throw processError("BRIDGE_CONTROL_UNAVAILABLE", "微信桥接控制服务不可用。", "bridge");
    const health = await this.bridgeClient.health();
    const exactProfile = health?.runtimeReady === true
      && health.activeProfileId === profile.id
      && health.runtimeId === profile.runtimeId
      && health.modelId === profile.modelId
      && Number(health.secretGeneration) === Number(profile.secretGeneration);
    if (!exactProfile) {
      throw processError("RUNTIME_PROFILE_MISMATCH", "模型服务健康探针与所选配置不匹配。", "runtime");
    }
    if (profile.runtimeId === "opencode" && profile.ownershipMode === "external" && health.catalogLive !== true) {
      throw processError("OPENCODE_LIVE_CATALOG_REQUIRED", "External OpenCode 激活需要实时模型目录。", "runtime");
    }
    return health;
  }

  async switchProfile(profileId, { graceMs } = {}) {
    if (this.switchPromise) {
      throw processError("SWITCH_IN_PROGRESS", "另一个模型配置切换仍在进行。", "runtime");
    }
    const operation = this.performProfileSwitch(profileId, { graceMs });
    this.switchPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.switchPromise === operation) this.switchPromise = null;
    }
  }

  async performProfileSwitch(profileId, { graceMs } = {}) {
    const oldProfile = this.requireVerifiedProfile(this.profileStore?.getActive?.(), "NO_ACTIVE_ENGINE");
    const newProfile = this.requireVerifiedProfile(this.profileStore?.get?.(profileId), "PROFILE_NOT_VERIFIED");
    const forceExternalRefresh = oldProfile.id === newProfile.id
      && newProfile.runtimeId === "opencode"
      && newProfile.ownershipMode === "external";
    if (oldProfile.id === newProfile.id && !forceExternalRefresh) return this.snapshot();
    const normalizedGraceMs = normalizeGraceMs(graceMs);
    const deadlineAt = new Date(this.now() + normalizedGraceMs).toISOString();
    const previousPhase = this.desiredState === "quiet" ? "quiet" : "running";
    let oldStopped = false;
    this.switchTransaction = {
      oldProfileId: oldProfile.id,
      newProfileId: newProfile.id,
      phase: "draining",
      graceMs: normalizedGraceMs,
      deadlineAt,
      error: null,
      rollbackError: null,
    };
    this.phase = "switching";
    this.lastError = null;
    this.logger?.info("runtime.switch_started", { oldProfileId: oldProfile.id, newProfileId: newProfile.id, graceMs: normalizedGraceMs });
    this.emitState();
    try {
      if (!this.bridgeClient) throw processError("BRIDGE_CONTROL_UNAVAILABLE", "微信桥接控制服务不可用。", "bridge");
      const drained = await this.bridgeClient.drain({ deadlineAt });
      if (Number(drained?.activeTurns) > 0) {
        if (drained?.nonInterruptibleBoundary) {
          throw processError("SAFETY_BOUNDARY_ACTIVE", "不可中断安全操作尚未完成。", "runtime");
        }
        this.switchTransaction.phase = "aborting";
        this.emitState();
        const aborted = await this.bridgeClient.abort("runtime profile switch grace expired");
        if (Number(aborted?.activeTurns) > 0) {
          throw processError("TURN_CANCELLATION_UNACKNOWLEDGED", "当前回合未确认取消。", "runtime");
        }
      }
      this.switchTransaction.phase = "stopping_old";
      this.emitState();
      await this.stopProfileRuntime(oldProfile);
      oldStopped = true;
      this.healthyProfileId = "";
      this.profileStore.activate(newProfile.id);
      this.switchTransaction.phase = "starting_new";
      this.emitState();
      await this.startProfileRuntime(newProfile);
      this.switchTransaction.phase = "probing_new";
      this.emitState();
      await this.probeProfile(newProfile);
      this.healthyProfileId = newProfile.id;
      this.phase = previousPhase;
      this.switchTransaction.phase = "completed";
      this.logger?.info("runtime.switch_completed", { oldProfileId: oldProfile.id, newProfileId: newProfile.id });
      this.emitState();
      return this.snapshot();
    } catch (error) {
      this.switchTransaction.error = observableError(error);
      if (!oldStopped) {
        this.phase = previousPhase;
        this.logger?.error("runtime.switch_failed", { code: error.code || "SWITCH_FAILED", rollback: false });
        this.emitState();
        throw error;
      }
      this.switchTransaction.phase = "rolling_back";
      this.emitState();
      try {
        await this.stopProfileRuntime(newProfile);
        this.profileStore.activate(oldProfile.id);
        await this.startProfileRuntime(oldProfile);
        await this.probeProfile(oldProfile);
        this.healthyProfileId = oldProfile.id;
        this.phase = previousPhase;
        this.switchTransaction.phase = "rolled_back";
        this.logger?.error("runtime.switch_rolled_back", { code: error.code || "SWITCH_FAILED", oldProfileId: oldProfile.id });
        this.emitState();
        throw error;
      } catch (rollbackError) {
        if (rollbackError === error) throw error;
        this.healthyProfileId = "";
        this.phase = "error";
        this.switchTransaction.phase = "rollback_failed";
        this.switchTransaction.rollbackError = observableError(rollbackError);
        const combined = processError("SWITCH_ROLLBACK_FAILED", "新模型服务启动失败，旧模型服务也未能恢复。", "runtime");
        combined.cause = error;
        combined.rollbackError = rollbackError;
        this.lastError = {
          ...friendlyProcessError(combined),
          switchError: observableError(error),
          rollbackError: observableError(rollbackError),
        };
        this.logger?.error("runtime.switch_rollback_failed", { code: rollbackError.code || "ROLLBACK_FAILED" });
        this.emitState();
        throw combined;
      }
    }
  }

  requireVerifiedProfile(profile, missingCode = "PROFILE_NOT_VERIFIED") {
    const fingerprintMatches = profile?.verifiedFingerprint
      && profile.verifiedFingerprint === computeVerificationFingerprint(profile);
    if (!profile || profile.status !== "verified" || !profile.verifiedAt || !fingerprintMatches) {
      throw Object.assign(new Error("A live-verified active model profile is required."), { code: missingCode });
    }
    return profile;
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

  async startBridge(profile) {
    const existing = this.children.get("bridge");
    if (existing && existing.exitCode == null) return;
    const executable = process.execPath;
    this.bridgeControlToken = crypto.randomBytes(32).toString("base64url");
    this.bridgeControlPort = await reserveLoopbackPort();
    const child = this.spawnOwned("bridge", executable, [path.join(this.rootDir, "bin", "cyberboss.js"), "start"], {
      env: {
        ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : undefined,
        CYBERBOSS_CODEX_ENDPOINT: this.endpoint,
        CYBERBOSS_STATE_DIR: this.stateDir,
        CYBERBOSS_ENABLE_CHECKIN: "0",
        CYBERBOSS_BRIDGE_CONTROL_TOKEN: this.bridgeControlToken,
        CYBERBOSS_BRIDGE_CONTROL_PORT: String(this.bridgeControlPort),
        CYBERBOSS_ACTIVE_PROFILE_ID: profile?.id,
      },
    });
    const ready = await waitForBridgeReady(child, 45_000);
    if (!ready) throw processError("BRIDGE_NOT_READY", "微信桥接未能完成启动。", "bridge");
    this.bridgeClient = this.bridgeClientFactory({ port: this.bridgeControlPort, token: this.bridgeControlToken });
  }

  spawnOwned(component, command, args, { env = {}, shell = false } = {}) {
    const childEnv = { ...this.env, ...env, CYBERBOSS_INSTANCE_TOKEN: this.instanceToken };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) delete childEnv[key];
    }
    const spawnSpec = resolveOwnedSpawnSpec({ rootDir: this.rootDir, command, args });
    this.logger?.info(`${component}.spawn_spec`, {
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: spawnSpec.cwd,
      jobObject: spawnSpec.useProcessHost,
    });
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spawnSpec.cwd,
      env: childEnv,
      shell: spawnSpec.useProcessHost ? false : shell,
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
          executablePath: spawnSpec.command,
          commandPath: command,
          parentPid: process.pid,
          instanceToken: this.instanceToken,
          startedAt: new Date().toISOString(),
        },
      ],
    }));
    this.logger?.info(`${component}.spawned`, {
      pid: child.pid,
      jobObject: spawnSpec.useProcessHost,
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: spawnSpec.cwd,
    });
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
    this.healthyProfileId = "";
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
    this.bridgeClient = null;
    this.bridgeControlToken = "";
    this.bridgeControlPort = 0;
  }

  async stopProfileRuntime(profile) {
    const bridge = this.children.get("bridge");
    if (bridge && bridge.exitCode == null) this.plannedChildStops.add("bridge");
    await stopChild(bridge, 10_000);
    this.children.delete("bridge");
    const processKind = profile?.runtimeId ? getRuntimeDefinition(profile.runtimeId).processKind : "";
    if (processKind === "codex" && !this.externalAppServer) {
      const appServer = this.children.get("appserver");
      if (appServer && appServer.exitCode == null) this.plannedChildStops.add("appserver");
      await stopChild(appServer, 15_000);
    }
    this.children.delete("appserver");
    this.externalAppServer = false;
    this.bridgeClient = null;
    this.bridgeControlToken = "";
    this.bridgeControlPort = 0;
  }

  emitState() {
    this.switchJournalStore?.write?.({ schemaVersion: 1, transaction: this.switchTransaction });
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

function normalizeGraceMs(value) {
  if (value === undefined || value === null || value === "") return 120_000;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 120_000;
  return Math.min(600_000, Math.max(30_000, Math.round(parsed)));
}

function friendlyProfileError(error) {
  return {
    category: "configuration",
    code: error?.code || "NO_ACTIVE_ENGINE",
    capability: "runtime",
    summary: error?.message || "请先实时验证并激活模型配置。",
    repairAction: "打开模型设置",
    timestamp: new Date().toISOString(),
  };
}

function observableError(error) {
  return {
    code: error?.code || "RUNTIME_ERROR",
    message: error?.message || String(error || "Runtime operation failed."),
  };
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = Number(server.address()?.port) || 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeSwitchJournal(value) {
  const transaction = value?.transaction;
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    return { schemaVersion: 1, transaction: null };
  }
  const oldProfileId = normalizeText(transaction.oldProfileId);
  const newProfileId = normalizeText(transaction.newProfileId);
  const phase = normalizeText(transaction.phase);
  if (!oldProfileId || !newProfileId || !phase) return { schemaVersion: 1, transaction: null };
  return {
    schemaVersion: 1,
    transaction: {
      oldProfileId,
      newProfileId,
      phase,
      graceMs: normalizeGraceMs(transaction.graceMs),
      deadlineAt: Number.isFinite(Date.parse(transaction.deadlineAt || "")) ? new Date(transaction.deadlineAt).toISOString() : "",
      error: transaction.error && typeof transaction.error === "object" ? observableError(transaction.error) : null,
      rollbackError: transaction.rollbackError && typeof transaction.rollbackError === "object" ? observableError(transaction.rollbackError) : null,
    },
  };
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

function resolveOwnedSpawnSpec({
  rootDir,
  command,
  args = [],
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  processHostAvailable,
} = {}) {
  const processHost = platform === "win32"
    ? path.join(rootDir, "native", "win32", "CyberBoss.ProcessHost.exe")
    : "";
  const packagedAsar = isAsarPath(rootDir);
  const canUseProcessHost = processHostAvailable === undefined
    ? Boolean(processHost && fs.existsSync(processHost))
    : processHostAvailable;
  const useProcessHost = Boolean(processHost && !packagedAsar && canUseProcessHost);
  const spawnCommand = useProcessHost ? processHost : command;
  const spawnArgs = useProcessHost ? [String(process.pid), command, ...args] : args;
  const cwd = packagedAsar ? resolvePackagedSpawnCwd(rootDir, resourcesPath) : rootDir;
  return {
    command: spawnCommand,
    args: spawnArgs,
    cwd,
    processHost,
    useProcessHost,
    packagedAsar,
  };
}

function resolvePackagedSpawnCwd(rootDir, resourcesPath) {
  if (resourcesPath && !isAsarPath(resourcesPath) && fs.existsSync(resourcesPath)) return resourcesPath;
  return path.dirname(rootDir);
}

function isAsarPath(value) {
  return /(?:^|[\\/])app\.asar(?:[\\/]|$)/i.test(String(value || ""));
}

module.exports = {
  RuntimeSupervisor,
  checkReady,
  friendlyProcessError,
  normalizeGraceMs,
  normalizeProcessRegistry,
  resolveOwnedSpawnSpec,
  waitUntil,
};
