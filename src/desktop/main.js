const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require("electron");
const dotenv = require("dotenv");

const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { ComponentLogger, queryLogs } = require("../core/component-logger");
const { readConfig } = require("../core/config");
const { DesktopStateStore, DESIRED_STATES } = require("../core/desktop-state-store");
const { ProviderProfileStore } = require("../core/provider-profile-store");
const { computeVerificationFingerprint } = require("../core/provider-profile-store");
const { SupervisionPlanStore } = require("../core/supervision-plan-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ZhijiantimeClient, ZhijiantimeSyncService } = require("../integrations/zhijiantime");
const { BackupService } = require("../services/backup-service");
const { createOpenCodeRuntimeAdapter } = require("../adapters/runtime/opencode");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { verifyCodeBuddyEchoTool } = require("../adapters/runtime/codebuddy");
const { ProviderCatalog } = require("../services/provider-catalog");
const { ProviderVerifier } = require("../services/provider-verifier");
const { CredentialVault } = require("../security/credential-vault");
const { DiagnosticCapture } = require("../security/diagnostic-capture");
const {
  ModelSettingsService,
  buildEngineSnapshot,
  registerModelSettingsIpc,
} = require("./model-settings-service");
const { RecordsService } = require("./records-service");
const { ReportScheduler } = require("./report-scheduler");
const { RuntimeSupervisor } = require("./runtime-supervisor");
const { RuntimeProfileVerifier } = require("./runtime-profile-verifier");
const { SupervisionDispatcher } = require("./supervision-dispatcher");
const { WindowsTaskService } = require("./windows-task-service");

const rootDir = path.resolve(__dirname, "..", "..");
loadEnvironment(rootDir);
process.env.CYBERBOSS_HOME ||= rootDir;

const config = readConfig();
app.setName("CyberBoss");
app.setAppUserModelId("CyberBoss.Desktop");
const stateDir = config.stateDir || path.join(os.homedir(), ".cyberboss");
const logDir = path.join(stateDir, "logs");
const logger = new ComponentLogger({ logDir, component: "desktop" });
const stateStore = new DesktopStateStore({
  stateDir,
  onCorrupt: () => logger.error("desktop_state.corrupt", { category: "corrupt-data" }),
});
const planStore = new SupervisionPlanStore({ stateDir });
const recordsService = new RecordsService({ stateDir });
const checkinConfig = new CheckinConfigStore({ filePath: config.checkinConfigFile });
const profileStore = new ProviderProfileStore({ filePath: config.providerProfilesFile });
const supervisor = new RuntimeSupervisor({ rootDir, stateDir, logger, profileStore });
const credentialVault = new CredentialVault({ filePath: config.credentialVaultFile });
const diagnosticCapture = new DiagnosticCapture({ filePath: config.diagnosticCaptureFile });
const providerCatalog = new ProviderCatalog();
const modelCatalog = {
  list: (profile, secrets, options) => profile.runtimeId === "opencode"
    ? listOpenCodeCatalog(profile, secrets, options)
    : providerCatalog.list(profile, secrets, options),
  invalidate: (profileId) => providerCatalog.invalidate(profileId),
};
const providerVerifier = new ProviderVerifier({
  profileStore,
  credentialVault,
  capture: diagnosticCapture,
});
const runtimeProfileVerifier = new RuntimeProfileVerifier({
  profileStore,
  credentialVault,
  stateDir,
  adapterFactory: createVerificationRuntimeAdapter,
});
const modelSettingsService = new ModelSettingsService({
  profileStore,
  credentialVault,
  catalog: modelCatalog,
  verifier: providerVerifier,
  supervisor,
  diagnosticCapture,
  runtimeVerifier: (profileId) => verifyRuntimeProfile(profileId),
});
const dispatcher = new SupervisionDispatcher({ config, desktopStateStore: stateStore, planStore, logger });
const reportLogger = new ComponentLogger({ logDir, component: "reports" });
const backupService = new BackupService({ stateDir, logger });
const integrationLogger = new ComponentLogger({ logDir, component: "integrations" });
const zhijiantimeClient = new ZhijiantimeClient({ rootDir });
const zhijiantimeSync = new ZhijiantimeSyncService({
  stateDir,
  client: zhijiantimeClient,
  desktopStateStore: stateStore,
  planStore,
  notify: (text) => dispatcher.enqueueNotice(text),
  logger: integrationLogger,
  onStatus: () => publishSnapshot(),
});
const windowsTaskService = new WindowsTaskService({
  rootDir,
  stateDir,
  executable: process.execPath,
  entryScript: __filename,
  logger,
});
let startupTaskError = null;
const reportScheduler = new ReportScheduler({
  stateDir,
  desktopStateStore: stateStore,
  timelineIntegration: createTimelineIntegration(config),
  logger: reportLogger,
  onGenerated: async ({ kind }) => {
    if (kind !== "daily") return;
    await backupService.createBackup({ kind: "daily" });
    backupService.cleanupAutomaticBackups();
  },
});

let mainWindow = null;
let tray = null;
let quitting = false;
let shutdownStarted = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(bootstrap).catch((error) => {
    logger.error("desktop.bootstrap_failed", { code: error.code || "BOOTSTRAP_FAILED" });
    app.exit(1);
  });
}

async function bootstrap() {
  registerIpc();
  createMainWindow();
  createTray();
  dispatcher.start();
  reportScheduler.start();
  zhijiantimeSync.start();
  supervisor.on("state", () => {
    reportScheduler.setRuntimeHealthy(["running", "quiet"].includes(supervisor.phase));
    if (["running", "quiet"].includes(supervisor.phase)) zhijiantimeSync.sync().catch(() => {});
    updateTrayMenu();
    publishSnapshot();
    const stable = ["running", "quiet", "stopped"].includes(supervisor.phase) ? supervisor.phase : "";
    if (stable) stateStore.markStable(stable);
  });
  let desiredState = stateStore.get().desiredState;
  if (!profileStore.getActive() && desiredState !== "stopped") {
    stateStore.setDesiredState("stopped");
    desiredState = "stopped";
  }
  supervisor.desiredState = desiredState;
  if (desiredState !== "stopped") {
    supervisor.start().catch(() => publishSnapshot());
  }
  logger.info("desktop.ready", { desiredState });
  scheduleArtifactSmokeExit();
  app.on("activate", showMainWindow);
}

function scheduleArtifactSmokeExit() {
  const delayMs = Number.parseInt(String(process.env.CYBERBOSS_ARTIFACT_SMOKE_EXIT_MS || ""), 10);
  if (!Number.isSafeInteger(delayMs) || delayMs < 250 || delayMs > 30_000) return;
  const timer = setTimeout(requestExit, delayMs);
  timer.unref?.();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#f5f2eb",
    title: "CyberBoss 控制中心",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("CyberBoss 控制中心");
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function createTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="9" width="32" height="32" fill="#315d52"/><path d="M8 11.5C8 9.6 9.6 8 11.5 8h9C22.4 8 24 9.6 24 11.5v9c0 1.9-1.6 3.5-3.5 3.5h-9A3.5 3.5 0 0 1 8 20.5z" fill="#f7d98b"/><circle cx="13" cy="15" r="1.6" fill="#315d52"/><circle cx="19" cy="15" r="1.6" fill="#315d52"/><path d="M12 19c2.7 1.7 5.3 1.7 8 0" fill="none" stroke="#315d52" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 20, height: 20 });
}

function updateTrayMenu() {
  if (!tray) return;
  const state = stateStore.get().desiredState;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制中心", click: showMainWindow },
    { type: "separator" },
    trayStateItem("运行", "running", state),
    trayStateItem("静默", "quiet", state),
    trayStateItem("停止", "stopped", state),
    { type: "separator" },
    { label: "退出 CyberBoss", click: requestExit },
  ]));
}

function trayStateItem(label, desiredState, currentState) {
  return {
    label,
    type: "radio",
    checked: desiredState === currentState,
    enabled: desiredState === "stopped" || Boolean(profileStore.getActive()),
    click: () => applyDesiredState(desiredState).catch(() => {}),
  };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  registerModelSettingsIpc({
    ipcMain,
    service: modelSettingsService,
    getMainWindow: () => mainWindow,
    rendererUrl: pathToFileURL(path.join(__dirname, "renderer", "index.html")).href,
    onMutation: () => { updateTrayMenu(); publishSnapshot(); },
  });
  ipcMain.handle("desktop:get-snapshot", () => buildSnapshot());
  ipcMain.handle("desktop:set-state", (_event, desiredState) => applyDesiredState(desiredState));
  ipcMain.handle("desktop:retry", async () => { await supervisor.retry(); return buildSnapshot(); });
  ipcMain.handle("desktop:update-settings", (_event, patch) => updateSettings(patch));
  ipcMain.handle("desktop:list-diary", (_event, options) => recordsService.listDiary(options));
  ipcMain.handle("desktop:list-reports", () => recordsService.listReports());
  ipcMain.handle("desktop:backfill", (_event, action) => {
    if (action === "pause") reportScheduler.pauseBackfill();
    if (action === "resume") reportScheduler.resumeBackfill();
    return buildSnapshot();
  });
  ipcMain.handle("desktop:retry-report", (_event, date) => reportScheduler.retry(String(date || "")));
  ipcMain.handle("desktop:list-logs", (_event, options) => queryLogs({ logDir, ...sanitizeLogOptions(options) }));
  ipcMain.handle("desktop:sync-zhijiantime", async () => { await zhijiantimeSync.sync(); return buildSnapshot(); });
  ipcMain.handle("desktop:authorize-zhijiantime", async (_event, token) => {
    try {
      await zhijiantimeClient.reauthorize(String(token || ""));
      await zhijiantimeSync.sync();
      return { authorized: true, snapshot: buildSnapshot() };
    } catch (error) {
      return { authorized: false, error: error.message || "指尖时光授权失败。", snapshot: buildSnapshot() };
    }
  });
  ipcMain.handle("desktop:update-checkpoint", (_event, id, patch) => updateCheckpoint(id, patch));
  ipcMain.handle("desktop:open-record", (_event, targetPath) => openValidatedPath(targetPath));
  ipcMain.handle("desktop:record-preview", (_event, targetPath) => readRecordPreview(targetPath));
  ipcMain.handle("desktop:open-data-folder", () => shell.openPath(stateDir));
  ipcMain.handle("desktop:create-backup", (_event, kind) => createBackupFromUi(kind));
  ipcMain.handle("desktop:restore-backup", () => restoreBackupFromUi());
  ipcMain.handle("desktop:exit", () => requestExit());
}

async function applyDesiredState(desiredState) {
  if (!DESIRED_STATES.has(desiredState)) throw new Error("invalid desired state");
  if (desiredState !== "stopped" && !profileStore.getActive()) {
    throw Object.assign(new Error("请先新增、验证并激活模型配置。"), { code: "NO_ACTIVE_ENGINE" });
  }
  stateStore.setDesiredState(desiredState);
  updateTrayMenu();
  publishSnapshot();
  try {
    await supervisor.setDesiredState(desiredState);
  } catch {
    // The friendly error is included in the supervisor snapshot.
  }
  return buildSnapshot();
}

async function updateSettings(patch) {
  const allowed = {};
  for (const key of ["startWithWindows", "randomCheckinsEnabled", "reportEnabled", "reportTime", "contextDurations", "backfillPaused"]) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) allowed[key] = patch[key];
  }
  const previous = stateStore.get();
  stateStore.patch(allowed);
  if (Object.prototype.hasOwnProperty.call(allowed, "startWithWindows") && allowed.startWithWindows !== previous.startWithWindows) {
    try {
      await windowsTaskService.setEnabled(Boolean(allowed.startWithWindows));
      startupTaskError = null;
    } catch (error) {
      stateStore.patch({ startWithWindows: previous.startWithWindows });
      startupTaskError = {
        category: "permission",
        code: error.code || "WINDOWS_TASK_UPDATE_FAILED",
        capability: "随 Windows 启动",
        summary: "无法更新 Windows 自动启动任务。",
        repairAction: "打开诊断后重试",
        timestamp: new Date().toISOString(),
      };
    }
  }
  dispatcher.ensureRandomCheckpoint();
  publishSnapshot();
  return buildSnapshot();
}

function updateCheckpoint(id, patch) {
  const allowed = {};
  if (patch?.state === "skipped") allowed.state = "skipped";
  if (patch?.outcome === "cancelled_by_user") allowed.outcome = patch.outcome;
  if (patch?.dueAt && Number.isFinite(Date.parse(patch.dueAt))) allowed.dueAt = new Date(patch.dueAt).toISOString();
  const result = planStore.update(String(id || ""), allowed);
  publishSnapshot();
  return result;
}

function buildSnapshot() {
  const settings = stateStore.get();
  const range = checkinConfig.getRange(resolveDefaultCheckinRange());
  const supervisorRuntime = supervisor.snapshot();
  const runtime = !profileStore.getActive() && supervisorRuntime.phase === "stopped"
    ? { ...supervisorRuntime, phase: "configuration_required" }
    : supervisorRuntime;
  const engine = buildEngineSnapshot({ activeProfile: profileStore.getActive(), runtime });
  return {
    settings,
    runtime,
    engine,
    wechat: resolveWechatStatus(runtime),
    supervision: {
      random: {
        enabled: settings.randomCheckinsEnabled,
        minMinutes: Math.round(range.minIntervalMs / 60_000),
        maxMinutes: Math.round(range.maxIntervalMs / 60_000),
      },
      checkpoints: planStore.list({ includeRandom: false }).filter((item) => item.state === "pending").slice(0, 50),
      recent: planStore.list({ includeRandom: true }).filter((item) => item.state !== "pending").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20),
    },
    reports: {
      backfillPaused: settings.backfillPaused,
      runningDate: reportScheduler.currentDate,
      queue: reportScheduler.queueStore.list().slice(-20),
    },
    zhijiantime: zhijiantimeSync.snapshot(),
    startupTaskError,
    stateDir,
  };
}

async function listOpenCodeCatalog(profile, secrets, options = {}) {
  const adapter = createOpenCodeRuntimeAdapter({
    config: { stateDir, workspaceRoot: rootDir },
    profile,
    secrets,
  });
  try {
    return await adapter.listCatalog({ reason: options.reason || "display" });
  } finally {
    await adapter.close();
  }
}

async function verifyRuntimeProfile(profileId) {
  const profile = profileStore.get(profileId);
  if (profile?.runtimeId !== "codebuddy") return runtimeProfileVerifier.verify(profileId);
  const secretGeneration = credentialVault.getGeneration(profileId);
  const secrets = await credentialVault.read(profileId) || {};
  const startingFingerprint = computeVerificationFingerprint({ ...profile, secretGeneration });
  const verificationRoot = fs.mkdtempSync(path.join(stateDir, "codebuddy-verification-"));
  try {
    const result = await verifyCodeBuddyEchoTool({
      config: {
        stateDir,
        workspaceRoot: verificationRoot,
        verificationServerPath: path.join(__dirname, "runtime-verification-mcp-server.js"),
      },
      profile: { ...profile, secretGeneration },
      secrets,
    });
    if (!result?.ok) return result;
    if (credentialVault.getGeneration(profileId) !== secretGeneration) {
      return { ok: false, error: { code: "CREDENTIAL_CHANGED", message: "Credentials changed during verification." } };
    }
    const current = profileStore.get(profileId);
    if (!current || computeVerificationFingerprint({ ...current, secretGeneration }) !== startingFingerprint) {
      return { ok: false, error: { code: "PROFILE_CHANGED", message: "Profile changed during verification." } };
    }
    const capabilities = {
      authentication: true,
      modelAccess: true,
      streaming: true,
      tools: result.toolVerified === true,
      toolContinuation: result.toolVerified === true,
      cancellation: false,
      imageInput: false,
      accountIdentityFingerprint: result.identityFingerprint,
    };
    const verifiedAt = new Date().toISOString();
    profileStore.markVerified(profileId, {
      fingerprint: startingFingerprint,
      secretGeneration,
      capabilities,
      verifiedAt,
    });
    return { ok: true, capabilities, verifiedAt };
  } catch (error) {
    return { ok: false, error: { code: error.code || "MODEL_SERVICE_UNAVAILABLE", message: error.message || "CodeBuddy verification failed." } };
  } finally {
    try { fs.rmSync(verificationRoot, { recursive: true, force: true }); } catch {}
  }
}

function createVerificationRuntimeAdapter({ profile, secrets, workspaceRoot, verification }) {
  const sessionsFile = path.join(workspaceRoot, "verification-sessions.json");
  if (profile.runtimeId === "opencode") {
    return createOpenCodeRuntimeAdapter({
      config: {
        ...config,
        stateDir: path.join(workspaceRoot, "opencode-state"),
        workspaceRoot,
        verificationMode: true,
        endpoint: profile.baseUrl || config.opencodeEndpoint,
      },
      profile,
      secrets,
    });
  }
  if (profile.runtimeId === "codex") {
    return createCodexRuntimeAdapter({
      ...config,
      stateDir: workspaceRoot,
      sessionsFile,
      codexEndpoint: profile.baseUrl || config.codexEndpoint,
      codexModel: profile.modelId,
      codexModelProvider: profile.options?.modelProvider || "",
      codexVerificationMode: true,
      codexVerificationMcpServer: verification.mcpServer,
    });
  }
  if (profile.runtimeId === "claudecode") {
    const mcpConfigPath = writeClaudeVerificationConfig(workspaceRoot, verification.mcpServer);
    return createClaudeCodeRuntimeAdapter({
      ...config,
      stateDir: workspaceRoot,
      sessionsFile,
      claudeModel: profile.modelId,
      claudeVerificationMode: true,
      claudeVerificationMcpConfigPath: mcpConfigPath,
    });
  }
  throw Object.assign(new Error("Unsupported runtime verification profile."), { code: "UNSUPPORTED_RUNTIME" });
}

function writeClaudeVerificationConfig(workspaceRoot, mcpServer) {
  if (!mcpServer?.command || !Array.isArray(mcpServer.args)) {
    throw Object.assign(new Error("The verification MCP server is invalid."), { code: "RUNTIME_INCOMPATIBLE" });
  }
  const configPath = path.join(workspaceRoot, "claude-verification-mcp.json");
  const document = {
    mcpServers: {
      cyberboss_verifier: {
        command: mcpServer.command,
        args: [...mcpServer.args],
        ...(mcpServer.env && Object.keys(mcpServer.env).length ? { env: { ...mcpServer.env } } : {}),
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const reopened = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (reopened?.mcpServers?.cyberboss_verifier?.command !== mcpServer.command) {
    throw Object.assign(new Error("The isolated Claude verification config could not be reopened."), { code: "RUNTIME_CONFIG_WRITE_FAILED" });
  }
  return configPath;
}

function resolveWechatStatus(runtime) {
  if (["running", "quiet"].includes(runtime.phase)) return { state: "connected", label: "已连接" };
  if (runtime.phase === "starting") return { state: "reconnecting", label: "正在连接" };
  if (runtime.phase === "error") return { state: "error", label: "连接异常" };
  return { state: "stopped", label: "已停止" };
}

function publishSnapshot() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:snapshot", buildSnapshot());
}

function sanitizeLogOptions(options) {
  const value = options && typeof options === "object" ? options : {};
  return {
    component: typeof value.component === "string" ? value.component : "",
    level: typeof value.level === "string" ? value.level : "",
    text: typeof value.text === "string" ? value.text.slice(0, 100) : "",
    limit: Math.min(500, Math.max(1, Number.parseInt(value.limit, 10) || 200)),
  };
}

function openValidatedPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  const relative = path.relative(stateDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("record path is outside CyberBoss data");
  if (!fs.existsSync(resolved)) throw new Error("record no longer exists");
  return shell.openPath(resolved);
}

function readRecordPreview(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  const relative = path.relative(stateDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(resolved)) return "";
  const extension = path.extname(resolved).toLowerCase();
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" })[extension];
  if (!mime || fs.statSync(resolved).size > 20 * 1024 * 1024) return "";
  return `data:${mime};base64,${fs.readFileSync(resolved).toString("base64")}`;
}

async function createBackupFromUi(kind) {
  const selectedKind = ["manual", "diary-export", "reports-export"].includes(kind) ? kind : "manual";
  const classes = selectedKind === "diary-export" ? ["diary"] : selectedKind === "reports-export" ? ["reports"] : ["settings", "diary", "reports"];
  const defaultName = `${selectedKind}-${new Date().toISOString().slice(0, 10)}.zip`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: selectedKind === "manual" ? "创建 CyberBoss 备份" : "导出 CyberBoss 数据",
    defaultPath: path.join(stateDir, "backups", defaultName),
    filters: [{ name: "CyberBoss 备份", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const created = await backupService.createBackup({ targetPath: result.filePath, classes, kind: selectedKind });
  return { canceled: false, filePath: created.filePath };
}

async function restoreBackupFromUi() {
  if (stateStore.get().desiredState !== "stopped" || supervisor.phase !== "stopped") {
    return { restored: false, error: "请先把 CyberBoss 切换为“停止”，再恢复备份。" };
  }
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "选择 CyberBoss 备份",
    properties: ["openFile"],
    filters: [{ name: "CyberBoss 备份", extensions: ["zip"] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true, restored: false };
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["取消", "恢复备份"],
    defaultId: 0,
    cancelId: 0,
    title: "确认恢复？",
    message: "日记、报表、监管计划和桌面设置可能会被备份中的版本替换。",
    detail: "恢复前会自动创建一份当前数据备份。微信和 Codex 登录信息不会改变。",
  });
  if (confirmation.response !== 1) return { canceled: true, restored: false };
  try {
    const restored = await backupService.restore({ archivePath: picked.filePaths[0] });
    stateStore.setDesiredState("stopped");
    publishSnapshot();
    return restored;
  } catch (error) {
    return { restored: false, error: error.message || "恢复失败。" };
  }
}

function requestExit() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  quitting = true;
  dispatcher.stop();
  reportScheduler.stop();
  Promise.all([supervisor.stop(), zhijiantimeSync.stop()]).finally(() => app.exit(0));
}

function loadEnvironment(projectRoot) {
  const candidates = [path.join(projectRoot, ".env"), path.join(os.homedir(), ".cyberboss", ".env")];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath });
      return;
    }
  }
}

module.exports = { buildSnapshot, openValidatedPath };
