const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_INVOKE_CHANNELS = new Set([
  "desktop:get-snapshot", "desktop:set-state", "desktop:retry", "desktop:check-codebuddy", "desktop:start-wechat-login", "desktop:refresh-onboarding", "desktop:update-settings",
  "desktop:list-diary", "desktop:list-reports", "desktop:backfill", "desktop:retry-report",
  "desktop:list-logs", "desktop:sync-zhijiantime", "desktop:authorize-zhijiantime",
  "desktop:update-checkpoint", "desktop:open-record", "desktop:record-preview",
  "desktop:open-data-folder", "desktop:create-backup", "desktop:restore-backup", "desktop:exit",
  "desktop:list-runtime-options", "desktop:list-profiles", "desktop:save-profile",
  "desktop:write-profile-secrets", "desktop:refresh-models", "desktop:test-profile",
  "desktop:activate-profile", "desktop:delete-profile", "desktop:set-diagnostic-capture",
  "desktop:list-persona-packs", "desktop:set-persona-pack",
]);

function invoke(channel, ...args) {
  if (!ALLOWED_INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error("IPC channel is not allowed."));
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld("cyberboss", Object.freeze({
  getSnapshot: () => invoke("desktop:get-snapshot"),
  setState: (state) => invoke("desktop:set-state", state),
  retry: () => invoke("desktop:retry"),
  checkCodeBuddy: () => invoke("desktop:check-codebuddy"),
  startWeChatLogin: () => invoke("desktop:start-wechat-login"),
  refreshOnboarding: () => invoke("desktop:refresh-onboarding"),
  updateSettings: (patch) => invoke("desktop:update-settings", patch),
  listDiary: (options) => invoke("desktop:list-diary", options),
  listReports: () => invoke("desktop:list-reports"),
  controlBackfill: (action) => invoke("desktop:backfill", action),
  retryReport: (date) => invoke("desktop:retry-report", date),
  listLogs: (options) => invoke("desktop:list-logs", options),
  syncZhijiantime: () => invoke("desktop:sync-zhijiantime"),
  authorizeZhijiantime: (token) => invoke("desktop:authorize-zhijiantime", token),
  updateCheckpoint: (id, patch) => invoke("desktop:update-checkpoint", id, patch),
  openRecord: (filePath) => invoke("desktop:open-record", filePath),
  getRecordPreview: (filePath) => invoke("desktop:record-preview", filePath),
  openDataFolder: () => invoke("desktop:open-data-folder"),
  createBackup: (kind) => invoke("desktop:create-backup", kind),
  restoreBackup: () => invoke("desktop:restore-backup"),
  listRuntimeOptions: () => invoke("desktop:list-runtime-options"),
  listProfiles: () => invoke("desktop:list-profiles"),
  saveProfile: (profile) => invoke("desktop:save-profile", profile),
  writeProfileSecrets: (profileId, secrets) => invoke("desktop:write-profile-secrets", profileId, secrets),
  refreshModels: (profileId, options) => invoke("desktop:refresh-models", profileId, options),
  testProfile: (profileId) => invoke("desktop:test-profile", profileId),
  activateProfile: (profileId, options) => invoke("desktop:activate-profile", profileId, options),
  deleteProfile: (profileId) => invoke("desktop:delete-profile", profileId),
  setDiagnosticCapture: (options) => invoke("desktop:set-diagnostic-capture", options),
  listPersonaPacks: () => invoke("desktop:list-persona-packs"),
  setPersonaPack: (id) => invoke("desktop:set-persona-pack", id),
  exit: () => invoke("desktop:exit"),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("desktop:snapshot", handler);
    return () => ipcRenderer.removeListener("desktop:snapshot", handler);
  },
}));
