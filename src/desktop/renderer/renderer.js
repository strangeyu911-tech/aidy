const api = window.cyberboss;
let snapshot = null;
let previousMode = null;
let modeCooldown = false;
let undoTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  bindControls();
  api.onSnapshot(renderSnapshot);
  renderSnapshot(await api.getSnapshot());
  await loadDiary();
  await loadReports();
});

function bindNavigation() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => {
    $$("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${button.dataset.view}`));
  }));
  $$("[data-record-tab]").forEach((button) => button.addEventListener("click", () => {
    $$("[data-record-tab]").forEach((item) => item.classList.toggle("active", item === button));
    const diary = button.dataset.recordTab === "diary";
    $("#diary-list").classList.toggle("hidden", !diary);
    $("#diary-tools").classList.toggle("hidden", !diary);
    $("#report-list").classList.toggle("hidden", diary);
  }));
}

function bindControls() {
  $("#power-button").addEventListener("click", () => {
    if (snapshot.settings.desiredState === "stopped") changeState("running");
    else openStopModal();
  });
  $$("[data-mode]").forEach((button) => button.addEventListener("click", () => changeMode(button.dataset.mode)));
  $("#modal-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal-confirm").addEventListener("click", async () => { $("#modal").classList.add("hidden"); await changeState("stopped"); });
  $("#modal-stop-now").addEventListener("click", async () => { $("#modal").classList.add("hidden"); await api.controlBackfill("pause"); await changeState("stopped"); });
  $("#toast-undo").addEventListener("click", async () => { if (previousMode) await changeState(previousMode, false); hideToast(); });
  $("#diary-search-button").addEventListener("click", loadDiary);
  $("#diary-search").addEventListener("keydown", (event) => { if (event.key === "Enter") loadDiary(); });
  $("#open-data").addEventListener("click", () => api.openDataFolder());
  $$('[data-backup-kind]').forEach((button) => button.addEventListener("click", () => runBackup(button.dataset.backupKind)));
  $("#restore-backup").addEventListener("click", restoreBackup);
  $("#load-logs").addEventListener("click", loadLogs);
  $("#sync-zhijian").addEventListener("click", async () => renderSnapshot(await api.syncZhijiantime()));
  $("#authorize-zhijian").addEventListener("click", authorizeZhijiantime);
  $("#exit-app").addEventListener("click", () => api.exit());
  for (const selector of ["#startup-setting", "#random-setting", "#report-setting", "#report-time", "#meal-duration", "#shower-duration"]) {
    $(selector).addEventListener("change", saveSettings);
  }
}

function openStopModal() {
  const activeReport = snapshot.reports?.runningDate;
  $("#modal-description").textContent = activeReport
    ? `正在生成 ${activeReport} 的报表。默认会先完成当前报表，再停止微信、查岗和同步；也可以立即停止当前报表。`
    : "停止后，微信回复、查岗、同步、日记和报表都会暂停。桌面控制中心会继续留在托盘中。";
  $("#modal-confirm").textContent = activeReport ? "完成当前工作后停止" : "停止 CyberBoss";
  $("#modal-stop-now").classList.toggle("hidden", !activeReport);
  $("#modal").classList.remove("hidden");
}

async function changeMode(nextMode) {
  if (modeCooldown || snapshot.settings.desiredState === "stopped" || snapshot.settings.desiredState === nextMode) return;
  previousMode = snapshot.settings.desiredState;
  modeCooldown = true;
  $$("[data-mode]").forEach((button) => button.disabled = true);
  await changeState(nextMode, false);
  showToast(`已切换为${nextMode === "quiet" ? "静默" : "运行"}模式`);
  setTimeout(() => { modeCooldown = false; $$("[data-mode]").forEach((button) => button.disabled = false); }, 2_000);
}

async function changeState(state, clearUndo = true) {
  renderSnapshot(await api.setState(state));
  if (clearUndo && state === "stopped") hideToast();
}

function renderSnapshot(nextSnapshot) {
  snapshot = nextSnapshot;
  const desired = snapshot.settings.desiredState;
  const phase = snapshot.runtime.phase;
  const display = stateDisplay(phase, desired);
  $("#state-title").textContent = display.title;
  $("#state-description").textContent = display.description;
  $("#header-state").textContent = display.short;
  $("#power-button").textContent = desired === "stopped" ? "启动" : "停止";
  $("#power-button").classList.toggle("stop", desired !== "stopped");
  $$("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === desired));
  $("#wechat-state").textContent = snapshot.wechat.label;
  $("#wechat-detail").textContent = phase === "quiet" ? "回复保留，主动推送静默" : "后台连接状态";
  $("#random-range").textContent = snapshot.supervision.random.enabled
    ? `${snapshot.supervision.random.minMinutes}–${snapshot.supervision.random.maxMinutes} 分钟`
    : "已关闭";
  renderError(snapshot.runtime.error || snapshot.startupTaskError);
  renderCheckpoints(snapshot.supervision.checkpoints);
  renderRecent(snapshot.supervision.recent);
  renderSettings();
  renderBackfill();
}

function stateDisplay(phase, desired) {
  if (phase === "starting") return { title: "正在启动", short: "启动中", description: "正在依次连接 Codex 与微信，完成后会自动进入监管状态。" };
  if (phase === "stopping") return { title: "正在停止", short: "停止中", description: "正在安全关闭后台服务和当前任务。" };
  if (phase === "error") return { title: "需要处理", short: "异常", description: "桌面控制中心仍在运行，你可以查看下面的修复建议。" };
  if (desired === "quiet") return { title: "静默运行中", short: "静默", description: "会回复你的消息，并继续同步、日记和报表；不会主动发起查岗。" };
  if (desired === "running") return { title: "监管运行中", short: "运行", description: "微信回复、随机查岗和固定安排都已启用。关闭窗口后仍会在托盘运行。" };
  return { title: "已停止", short: "停止", description: "后台服务已停止；控制中心仍留在托盘，可随时重新启动。" };
}

function renderError(error) {
  const card = $("#error-card");
  if (!error) { card.classList.add("hidden"); card.textContent = ""; return; }
  card.classList.remove("hidden");
  card.innerHTML = `<strong>${escapeHtml(error.summary)}</strong><p>受影响：${escapeHtml(error.capability)}。建议：${escapeHtml(error.repairAction)}。</p><button id="retry-button" type="button">重试启动</button>`;
  $("#retry-button").addEventListener("click", async () => renderSnapshot(await api.retry()));
}

function renderCheckpoints(items) {
  const list = $("#checkpoint-list");
  $("#checkpoint-count").textContent = String(items.length);
  if (!items.length) { list.className = "record-list empty-state"; list.textContent = "还没有固定查岗安排"; return; }
  list.className = "record-list";
  list.innerHTML = items.map((item) => `<article class="record-item"><div><h4>${escapeHtml(item.title)}</h4><p>${sourceLabel(item.source)} · ${formatDateTime(item.dueAt)}</p></div><div class="record-actions"><button data-delay-checkpoint="${escapeHtml(item.id)}" data-due-at="${escapeHtml(item.dueAt)}" type="button">延后 10 分钟</button><button data-cancel-checkpoint="${escapeHtml(item.id)}" type="button">取消</button></div></article>`).join("");
  $$('[data-delay-checkpoint]').forEach((button) => button.addEventListener("click", async () => {
    const dueAt = new Date(Date.parse(button.dataset.dueAt) + 10 * 60_000).toISOString();
    await api.updateCheckpoint(button.dataset.delayCheckpoint, { dueAt });
  }));
  $$('[data-cancel-checkpoint]').forEach((button) => button.addEventListener("click", async () => {
    await api.updateCheckpoint(button.dataset.cancelCheckpoint, { state: "skipped", outcome: "cancelled_by_user" });
  }));
}

function renderRecent(items) {
  const list = $("#recent-list");
  if (!items.length) { list.className = "record-list empty-state"; list.textContent = "暂无记录"; return; }
  list.className = "record-list";
  list.innerHTML = items.slice(0, 6).map((item) => `<article class="record-item"><div><h4>${escapeHtml(item.title)}</h4><p>${outcomeLabel(item.outcome)} · ${sourceLabel(item.source)}</p></div><time>${formatDateTime(item.updatedAt)}</time></article>`).join("");
}

function renderSettings() {
  const settings = snapshot.settings;
  $("#startup-setting").checked = settings.startWithWindows;
  $("#random-setting").checked = settings.randomCheckinsEnabled;
  $("#report-setting").checked = settings.reportEnabled;
  $("#report-time").value = settings.reportTime;
  $("#meal-duration").value = settings.contextDurations.meal;
  $("#shower-duration").value = settings.contextDurations.shower;
  $("#data-dir").textContent = snapshot.stateDir;
  const zhijian = snapshot.zhijiantime || { state: "not_configured" };
  const zhijianLabels = { connected: "已连接", syncing: "同步中", idle: "待同步", error: "异常", not_configured: "未配置" };
  $("#zhijian-state").textContent = zhijianLabels[zhijian.state] || zhijian.state;
  $("#zhijian-detail").textContent = zhijian.error?.summary || (zhijian.lastSyncAt ? `上次同步 ${formatDateTime(zhijian.lastSyncAt)}` : "同步今日日程和待办，按最新安排去重");
  $("#zhijian-auth-row").classList.toggle("hidden", zhijian.state !== "error" || !/DPAPI|凭据|授权|TOKEN/i.test(`${zhijian.error?.code || ""} ${zhijian.error?.summary || ""}`));
}

async function saveSettings() {
  renderSnapshot(await api.updateSettings({
    startWithWindows: $("#startup-setting").checked,
    randomCheckinsEnabled: $("#random-setting").checked,
    reportEnabled: $("#report-setting").checked,
    reportTime: $("#report-time").value,
    contextDurations: { meal: Number($("#meal-duration").value), shower: Number($("#shower-duration").value) },
  }));
}

async function loadDiary() {
  const items = await api.listDiary({ query: $("#diary-search")?.value || "" });
  const list = $("#diary-list");
  if (!items.length) { list.className = "record-list empty-state"; list.textContent = "没有找到日记"; return; }
  list.className = "record-list";
  list.innerHTML = items.map((item, index) => `<article class="record-item"><div><h4>${escapeHtml(item.date)}</h4><p>${escapeHtml(item.preview)}</p></div><div class="record-actions"><button data-toggle-diary="${index}" type="button">查看全文</button><button data-open-record="${escapeHtml(item.filePath)}" type="button">打开文件</button></div><pre id="diary-content-${index}" class="diary-content hidden">${escapeHtml(item.content)}</pre></article>`).join("");
  bindOpenRecordButtons(list);
  list.querySelectorAll("[data-toggle-diary]").forEach((button) => button.addEventListener("click", () => {
    const content = $(`#diary-content-${button.dataset.toggleDiary}`);
    const hidden = content.classList.toggle("hidden");
    button.textContent = hidden ? "查看全文" : "收起";
  }));
}

async function loadReports() {
  const items = await api.listReports();
  const list = $("#report-list");
  if (!items.length) { list.className = "record-list empty-state hidden"; list.textContent = "还没有生成报表"; return; }
  list.className = "record-list hidden";
  list.innerHTML = items.map((item, index) => `<article class="record-item"><div><h4>${escapeHtml(item.date)} 日报</h4><p>${reportStatusLabel(item.status)} · ${formatDateTime(item.generatedAt)}</p></div><div class="record-actions">${item.filePath ? `<button data-open-record="${escapeHtml(item.filePath)}" type="button">打开</button>` : ""}${item.status === "failed" ? `<button data-retry-report="${escapeHtml(item.date)}" type="button">重试</button>` : ""}</div>${item.filePath ? `<img id="report-preview-${index}" class="report-preview hidden" alt="${escapeHtml(item.date)} 日报预览">` : ""}</article>`).join("");
  bindOpenRecordButtons(list);
  list.querySelectorAll("[data-retry-report]").forEach((button) => button.addEventListener("click", async () => { await api.retryReport(button.dataset.retryReport); await loadReports(); }));
  await Promise.all(items.map(async (item, index) => {
    if (!item.filePath) return;
    const preview = await api.getRecordPreview(item.filePath);
    const image = $(`#report-preview-${index}`);
    if (preview && image) { image.src = preview; image.classList.remove("hidden"); }
  }));
}

function renderBackfill() {
  const container = $("#backfill-status");
  const queue = snapshot.reports?.queue || [];
  const unfinished = queue.filter((item) => ["pending", "paused", "running", "failed"].includes(item.status));
  if (!unfinished.length) { container.classList.add("hidden"); return; }
  const paused = snapshot.reports.backfillPaused;
  const running = snapshot.reports.runningDate;
  container.classList.remove("hidden");
  container.innerHTML = `<span>${running ? `正在补生成 ${escapeHtml(running)}` : `有 ${unfinished.length} 份日报等待处理`}</span><button id="backfill-toggle" type="button">${paused ? "继续补生成" : "暂停补生成"}</button>`;
  $("#backfill-toggle").addEventListener("click", async () => renderSnapshot(await api.controlBackfill(paused ? "resume" : "pause")));
}

function bindOpenRecordButtons(container) {
  container.querySelectorAll("[data-open-record]").forEach((button) => button.addEventListener("click", () => api.openRecord(button.dataset.openRecord)));
}

async function loadLogs() {
  const records = await api.listLogs({ limit: 100 });
  const list = $("#log-list");
  list.classList.remove("hidden");
  list.textContent = records.length ? records.map((item) => `${item.timestamp} ${item.level} ${item.component} ${item.event}`).join("\n") : "暂无诊断日志";
}

async function runBackup(kind) {
  const result = await api.createBackup(kind);
  if (!result || result.canceled) return;
  showOperationResult(`已保存到 ${result.filePath}`);
}

async function restoreBackup() {
  const result = await api.restoreBackup();
  if (!result || result.canceled) return;
  showOperationResult(result.restored ? "恢复完成，CyberBoss 保持停止状态。" : result.error || "恢复失败。");
}

async function authorizeZhijiantime() {
  const input = $("#zhijian-token");
  const resultElement = $("#zhijian-auth-result");
  const token = input.value.trim();
  if (!token) { resultElement.textContent = "请先粘贴 token。"; return; }
  resultElement.textContent = "正在授权…";
  const result = await api.authorizeZhijiantime(token);
  input.value = "";
  resultElement.textContent = result.authorized ? "授权成功。" : result.error || "授权失败。";
  renderSnapshot(result.snapshot);
}

function showOperationResult(text) {
  const result = $("#backup-result");
  result.textContent = text;
  result.classList.remove("hidden");
}

function showToast(text) {
  clearTimeout(undoTimer);
  $("#toast-text").textContent = text;
  $("#toast").classList.remove("hidden");
  undoTimer = setTimeout(hideToast, 10_000);
}

function hideToast() { clearTimeout(undoTimer); $("#toast").classList.add("hidden"); previousMode = null; }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function sourceLabel(source) { return ({ conversation: "对话安排", context: "情境推断", zhijiantime: "指尖时光", system_report: "系统报表", random: "随机查岗" })[source] || source; }
function outcomeLabel(outcome) { return ({ suppressed_quiet: "静默期已归档", queued: "已执行", pending_activity: "因近期活动跳过", cancelled_by_user: "用户已取消", newer_arrangement: "已按新安排替代" })[outcome] || outcome || "已记录"; }
function reportStatusLabel(status) { return ({ generated: "已生成", pending: "等待生成", running: "正在生成", failed: "生成失败", paused: "已暂停" })[status] || status || "未知状态"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
