const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cyberboss", Object.freeze({
  getSnapshot: () => ipcRenderer.invoke("desktop:get-snapshot"),
  setState: (state) => ipcRenderer.invoke("desktop:set-state", state),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  updateSettings: (patch) => ipcRenderer.invoke("desktop:update-settings", patch),
  listDiary: (options) => ipcRenderer.invoke("desktop:list-diary", options),
  listReports: () => ipcRenderer.invoke("desktop:list-reports"),
  controlBackfill: (action) => ipcRenderer.invoke("desktop:backfill", action),
  retryReport: (date) => ipcRenderer.invoke("desktop:retry-report", date),
  listLogs: (options) => ipcRenderer.invoke("desktop:list-logs", options),
  syncZhijiantime: () => ipcRenderer.invoke("desktop:sync-zhijiantime"),
  authorizeZhijiantime: (token) => ipcRenderer.invoke("desktop:authorize-zhijiantime", token),
  updateCheckpoint: (id, patch) => ipcRenderer.invoke("desktop:update-checkpoint", id, patch),
  openRecord: (filePath) => ipcRenderer.invoke("desktop:open-record", filePath),
  getRecordPreview: (filePath) => ipcRenderer.invoke("desktop:record-preview", filePath),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
  createBackup: (kind) => ipcRenderer.invoke("desktop:create-backup", kind),
  restoreBackup: () => ipcRenderer.invoke("desktop:restore-backup"),
  exit: () => ipcRenderer.invoke("desktop:exit"),
  onSnapshot: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("desktop:snapshot", handler);
    return () => ipcRenderer.removeListener("desktop:snapshot", handler);
  },
}));
