const api = window.cyberboss;
let snapshot = null;
let previousMode = null;
let modeCooldown = false;
let undoTimer = null;
let runtimeOptions = { runtimes: [], providers: [] };
let modelProfiles = [];
let editorProfile = null;
let loadedModels = [];
let modelSettingsLoaded = false;
const profileEditorState = window.cyberbossProfileEditorState;
const modelSettingsModelPicker = window.cyberbossModelSettingsModelPicker;
const modelSettingsView = window.cyberbossModelSettingsViewState;
let modelSettingsViewState = modelSettingsView.createModelSettingsViewState();
const modelSettingsCoach = window.cyberbossModelSettingsCoachState;
const connectionStatusView = window.cyberbossConnectionStatusView;
const MODEL_SETTINGS_COACH_STORAGE_KEY = "cyberboss:model-settings-coach:v1";
let modelSettingsCoachState = modelSettingsCoach.createModelSettingsCoachState({ completed: readModelCoachCompleted() });
let modelCoachTarget = null;
const profileTestResults = new Map();

const COMPATIBILITY_RUNTIME_IDS = Object.freeze(["codex", "claudecode", "codebuddy"]);
const RUNTIME_DISPLAY_ORDER = Object.freeze({ codebuddy: 0, "builtin-api": 1, codex: 2, claudecode: 3, opencode: 4 });
const RUNTIME_SETUP_GUIDES = Object.freeze({
  "builtin-api": {
    title: "使用已有 API Key",
    body: "选择供应商，填写 API Key，选择模型后测试连接。ChatGPT 订阅不等于 OpenAI API Key。",
  },
  opencode: {
    title: "OpenCode（高级选项）",
    body: "适合已经在本机或其他地址运行 OpenCode 的用户。请按 OpenCode 的方式准备服务后再填写连接信息。",
  },
  codex: {
    title: "Codex（兼容）",
    body: "适合已经有 Codex 使用经验的用户。完成本机登录后填写模型并测试连接。",
  },
  claudecode: {
    title: "Claude Code（兼容）",
    body: "适合已经有 Claude Code 使用经验的用户。完成本机登录后填写模型并测试连接。",
  },
  codebuddy: {
    title: "推荐：WorkBuddy",
    body: "已安装并登录 WorkBuddy 后，点击“刷新模型”并从下拉菜单选择当前可用模型，再保存并测试连接。",
    notice: "WorkBuddy 登录属于当前 Windows 用户；所有艾迪 WorkBuddy 配置共享同一个账号。你在外部登录、退出或切换账号后，需要重新验证这些配置。\n\n连接能力可能随 WorkBuddy 版本变化；如果遇到连接问题，请先更新 WorkBuddy 后再次测试。",
  },
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", async () => {
  bindNavigation();
  bindControls();
  api.onSnapshot(renderSnapshot);
  await loadModelSettings();
  renderSnapshot(await api.getSnapshot());
  await loadDiary();
  await loadReports();
});

function bindNavigation() {
  $$("[data-view]").forEach((button) => button.addEventListener("click", () => {
    $$("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${button.dataset.view}`));
    if (button.dataset.view === "settings") {
      requestAnimationFrame(() => {
        if (modelSettingsCoachState.status === "active") renderModelCoachMarks();
        else maybeStartModelCoachMarks();
      });
    } else {
      hideModelCoachVisual();
    }
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
  $("#onboarding-primary-action").addEventListener("click", handleOnboardingPrimaryAction);
  $("#onboarding-secondary-action").addEventListener("click", refreshOnboarding);
  $("#check-codebuddy-environment").addEventListener("click", checkCodeBuddyEnvironment);
  $$('[data-open-model-setup]').forEach((button) => button.addEventListener("click", openModelSettings));
  $("#new-model-profile").addEventListener("click", () => openProfileEditor());
  $("#cancel-model-profile").addEventListener("click", closeProfileEditor);
  $("#model-profile-editor").addEventListener("submit", saveModelDraft);
  $("#profile-runtime").addEventListener("change", renderProfileFields);
  $("#profile-ownership").addEventListener("change", renderProfileFields);
  $("#profile-provider").addEventListener("change", applyProviderDefaults);
  $("#profile-model-search").addEventListener("input", renderModelOptions);
  $("#profile-name").addEventListener("input", renderProfileEditorStatus);
  $("#profile-model-id").addEventListener("input", () => {
    $("#profile-test-result").classList.add("hidden");
    renderProfileEditorStatus();
  });
  $("#profile-model-id").addEventListener("change", selectOpenCodeProviderForModel);
  $("#profile-codebuddy-model-select").addEventListener("change", selectCodeBuddyModel);
  $("#profile-codebuddy-custom-model-id").addEventListener("input", selectCodeBuddyCustomModel);
  $("#refresh-profile-models").addEventListener("click", refreshProfileModels);
  $("#test-model-profile").addEventListener("click", testModelProfile);
  $("#activate-model-profile").addEventListener("click", activateModelProfile);
  $("#reopen-model-guide").addEventListener("click", toggleModelGuide);
  $("#close-model-guide").addEventListener("click", closeModelGuide);
  $("#start-model-profile-from-guide").addEventListener("click", startModelProfileFromGuide);
  $("#skip-model-coach").addEventListener("click", skipModelCoachMarks);
  $("#next-model-coach").addEventListener("click", advanceModelCoachMarks);
  window.addEventListener("resize", positionModelCoachMark);
  window.addEventListener("scroll", positionModelCoachMark, true);
  $("#enable-diagnostic-capture").addEventListener("click", () => updateDiagnosticCapture("enable"));
  $("#disable-diagnostic-capture").addEventListener("click", () => updateDiagnosticCapture("disable"));
  $("#delete-diagnostic-capture").addEventListener("click", () => updateDiagnosticCapture("delete"));
  for (const selector of ["#startup-setting", "#random-setting", "#report-setting", "#report-time", "#meal-duration", "#shower-duration"]) {
    $(selector).addEventListener("change", saveSettings);
  }
  $("#persona-setting").addEventListener("change", savePersonaPack);
}

function openStopModal() {
  const activeReport = snapshot.reports?.runningDate;
  $("#modal-description").textContent = activeReport
    ? `正在生成 ${activeReport} 的报表。默认会先完成当前报表，再停止微信、查岗和同步；也可以立即停止当前报表。`
    : "停止后，微信回复、查岗、同步、日记和报表都会暂停。桌面控制中心会继续留在托盘中。";
  $("#modal-confirm").textContent = activeReport ? "完成当前工作后停止" : "停止艾迪";
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
  const display = connectionStatusView.stateDisplay(phase, desired, snapshot.onboarding, snapshot.runtime.error);
  $("#state-title").textContent = display.title;
  $("#state-description").textContent = display.description;
  $("#header-state").textContent = display.short;
  $("#power-button").textContent = desired === "stopped" ? "启动" : "停止";
  $("#power-button").classList.toggle("stop", desired !== "stopped");
  const configurationRequired = snapshot.engine?.configurationRequired !== false;
  $("#first-run-setup").classList.toggle("hidden", !configurationRequired);
  const onboardingBlocked = ["model", "wechat"].includes(snapshot.onboarding?.step);
  $("#power-button").disabled = configurationRequired || onboardingBlocked || snapshot.engine?.canRun === false;
  $$("[data-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === desired);
    button.disabled = configurationRequired || onboardingBlocked || phase === "switching";
  });
  renderEngine(snapshot.engine, snapshot.runtime);
  $("#wechat-state").textContent = snapshot.wechat.label;
  $("#wechat-detail").textContent = phase === "quiet" ? "回复保留，主动推送静默" : snapshot.wechat.detail || "后台连接状态";
  $("#random-range").textContent = snapshot.supervision.random.enabled
    ? `${snapshot.supervision.random.minMinutes}–${snapshot.supervision.random.maxMinutes} 分钟`
    : "已关闭";
  renderError(snapshot.runtime.error || snapshot.startupTaskError);
  renderCheckpoints(snapshot.supervision.checkpoints);
  renderRecent(snapshot.supervision.recent);
  renderSettings();
  renderBackfill();
  renderOnboarding(snapshot);
  if (modelProfiles.length) {
    renderModelProfiles();
    renderProfileEditorStatus();
  }
}

function renderError(error) {
  const card = $("#error-card");
  if (!error) { card.classList.add("hidden"); card.textContent = ""; return; }
  const view = connectionStatusView.resolveErrorView(error);
  card.classList.remove("hidden");
  card.innerHTML = `<strong>${escapeHtml(view.summary)}</strong><p>受影响：${escapeHtml(view.capabilityLabel)}。建议：${escapeHtml(view.repairAction)}</p><small>诊断代码：${escapeHtml(view.code)}</small>${view.buttonLabel ? `<button id="error-action-button" type="button">${escapeHtml(view.buttonLabel)}</button>` : ""}`;
  if (view.buttonAction === "retry") {
    $("#error-action-button").addEventListener("click", async () => renderSnapshot(await api.retry()));
  } else if (view.buttonAction === "wechat_login") {
    $("#error-action-button").addEventListener("click", async () => {
      const result = await api.startWeChatLogin();
      const feedback = document.createElement("p");
      feedback.textContent = result?.message || "微信登录窗口已打开。完成扫码后请重新检查。";
      feedback.setAttribute("role", "status");
      card.append(feedback);
    });
  }
}

function renderOnboarding(currentSnapshot) {
  const onboarding = currentSnapshot.onboarding || { step: "model", complete: false, title: "先连接一个你能使用的模型", description: "完成模型连接测试并激活后，下一步是连接微信。" };
  const panel = $("#first-run-setup");
  panel.classList.toggle("hidden", Boolean(onboarding.complete));
  $("#onboarding-description").textContent = onboarding.description;
  $$("[data-onboarding-step]").forEach((item) => {
    const step = item.dataset.onboardingStep;
    item.classList.toggle("current", step === onboarding.step);
    item.classList.toggle("complete", ["wechat", "start", "complete"].includes(onboarding.step) && step === "model"
      || onboarding.step === "start" && step === "wechat"
      || onboarding.step === "complete" && ["model", "wechat", "start"].includes(step));
  });
  const primary = $("#onboarding-primary-action");
  const secondary = $("#onboarding-secondary-action");
  primary.textContent = onboarding.step === "model" ? "开始设置模型"
    : onboarding.step === "wechat" ? "连接微信"
      : "启动艾迪";
  primary.classList.toggle("hidden", onboarding.complete);
  secondary.classList.toggle("hidden", onboarding.step !== "wechat" || onboarding.complete);
}

function handleOnboardingPrimaryAction() {
  const step = snapshot?.onboarding?.step || "model";
  if (step === "model") return openModelSettings();
  if (step === "wechat") return connectWeChat();
  if (step === "start") return changeState("running");
  return null;
}

async function connectWeChat() {
  const result = $("#onboarding-action-result");
  try {
    const response = await api.startWeChatLogin();
    result.textContent = response.message || "微信登录窗口已打开。完成扫码后回到这里检查。";
    result.classList.remove("hidden", "error-result");
  } catch (error) {
    result.textContent = friendlyUiError(error);
    result.classList.remove("hidden");
    result.classList.add("error-result");
  }
}

async function refreshOnboarding() {
  try {
    renderSnapshot(await api.refreshOnboarding());
    $("#onboarding-action-result").textContent = "已重新检查微信连接状态。";
    $("#onboarding-action-result").classList.remove("hidden", "error-result");
  } catch (error) {
    $("#onboarding-action-result").textContent = friendlyUiError(error);
    $("#onboarding-action-result").classList.remove("hidden");
    $("#onboarding-action-result").classList.add("error-result");
  }
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
  renderPersonaPack(snapshot.personaPack);
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

async function loadModelSettings() {
  [runtimeOptions, modelProfiles] = await Promise.all([api.listRuntimeOptions(), api.listProfiles()]);
  modelSettingsLoaded = true;
  renderRuntimeOptions();
  renderModelProfiles();
}

function renderRuntimeOptions() {
  const runtimes = [...(runtimeOptions.runtimes || [])].sort((left, right) => (
    (RUNTIME_DISPLAY_ORDER[left.id] ?? 99) - (RUNTIME_DISPLAY_ORDER[right.id] ?? 99)
  ));
  $("#profile-runtime").innerHTML = `<option value="">请选择运行引擎</option>${runtimes.map((item) => {
    const label = item.isRecommended ? `${item.productLabel || runtimeLabel(item.id, item.name)}（推荐）`
      : item.id === "opencode" ? "OpenCode（实验）" : runtimeLabel(item.id, item.name);
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(label)}</option>`;
  }).join("")}`;
  renderProfileFields();
}

function renderModelProfiles() {
  const list = $("#model-profile-list");
  if (!modelProfiles.length) {
    list.className = "profile-list empty-state";
    list.textContent = "还没有模型配置。请新增、测试并激活一个配置。";
    return;
  }
  const activeId = resolveActiveProfileId();
  list.className = "profile-list";
  list.innerHTML = modelProfiles.map((profile) => {
    const cardState = profileEditorState.resolveProfileCardState({
      profile,
      activeProfileId: activeId,
    });
    const engineDetail = profile.runtimeId === "codebuddy"
      ? `WorkBuddy · ${profile.modelId || "未选模型"}`
      : `${runtimeLabel(profile.runtimeId)} · ${providerLabel(profile.providerId)} · ${profile.modelId || "未选模型"}`;
    return `<article class="profile-card ${cardState.active ? "active" : ""}"><div><span class="profile-state">${cardState.active ? "当前使用 · 已验证" : profileStatusLabel(profile.status)}</span><h4>${escapeHtml(profile.name || "未命名配置")}</h4><p>${escapeHtml(engineDetail)}</p><small>${profile.verifiedAt ? `上次测试 ${formatDateTime(profile.verifiedAt)}` : "尚未通过连接测试"}</small></div><div class="record-actions"><button type="button" data-edit-profile="${escapeHtml(profile.id)}">编辑</button><button type="button" data-test-profile="${escapeHtml(profile.id)}">测试</button><button class="profile-activate-button" type="button" data-activate-profile="${escapeHtml(profile.id)}" ${cardState.disabled ? "disabled" : ""}>${cardState.label}</button><button type="button" data-delete-profile="${escapeHtml(profile.id)}">删除</button></div></article>`;
  }).join("");
  list.querySelectorAll("[data-edit-profile]").forEach((button) => button.addEventListener("click", () => openProfileEditor(button.dataset.editProfile)));
  list.querySelectorAll("[data-test-profile]").forEach((button) => button.addEventListener("click", () => testExistingProfile(button.dataset.testProfile)));
  list.querySelectorAll("[data-activate-profile]").forEach((button) => button.addEventListener("click", () => activateExistingProfile(button.dataset.activateProfile)));
  list.querySelectorAll("[data-delete-profile]").forEach((button) => button.addEventListener("click", () => deleteModelProfile(button.dataset.deleteProfile)));
}

function openModelSettings() {
  $("#nav-settings").click();
  $("#model-settings").scrollIntoView({ behavior: "smooth", block: "start" });
  if (!modelProfiles.length && modelSettingsCoachState.status === "idle") return;
  if (!modelProfiles.length) openProfileEditor();
  else if ($("#model-profile-editor").classList.contains("hidden")) {
    openProfileEditor(snapshot?.engine?.activeProfile?.id || modelProfiles[0].id);
  }
  if ($("#profile-runtime").value === "codebuddy") void checkCodeBuddyEnvironment();
}

function toggleModelGuide() {
  if (modelSettingsViewState.guideOpen) closeModelGuide();
  else openModelGuide();
}

function readModelCoachCompleted() {
  try {
    return Boolean(window.localStorage.getItem(MODEL_SETTINGS_COACH_STORAGE_KEY));
  } catch {
    return false;
  }
}

function persistModelCoachCompletion(value) {
  try {
    window.localStorage.setItem(MODEL_SETTINGS_COACH_STORAGE_KEY, value);
  } catch {
    // The coach remains dismissible for this session when renderer storage is unavailable.
  }
}

function maybeStartModelCoachMarks() {
  if (!modelSettingsLoaded || modelProfiles.length || modelSettingsCoachState.status !== "idle") return;
  if (modelSettingsViewState.guideOpen || modelSettingsViewState.editorMode !== "closed") return;
  modelSettingsCoachState = modelSettingsCoach.transitionModelSettingsCoach(modelSettingsCoachState, { type: "start" });
  renderModelCoachMarks();
}

function hideModelCoachVisual() {
  modelCoachTarget?.classList.remove("model-coach-target");
  modelCoachTarget = null;
  $("#model-settings-coach").classList.add("hidden");
}

function advanceModelCoachMarks() {
  modelSettingsCoachState = modelSettingsCoach.transitionModelSettingsCoach(modelSettingsCoachState, { type: "next" });
  if (modelSettingsCoachState.status === "completed") persistModelCoachCompletion("completed");
  renderModelCoachMarks();
}

function skipModelCoachMarks() {
  modelSettingsCoachState = modelSettingsCoach.transitionModelSettingsCoach(modelSettingsCoachState, { type: "skip" });
  persistModelCoachCompletion("skipped");
  renderModelCoachMarks();
}

function renderModelCoachMarks() {
  hideModelCoachVisual();
  const coach = $("#model-settings-coach");
  if (modelSettingsCoachState.status !== "active") {
    coach.classList.add("hidden");
    return;
  }

  const steps = {
    1: {
      target: "#new-model-profile",
      title: "先添加一个 AI 配置",
      description: "推荐使用 WorkBuddy。已经安装并登录的话，点击“新增配置”开始。",
    },
    2: {
      target: "#reopen-model-guide",
      title: "需要帮助时看这里",
      description: "还没安装 WorkBuddy，或者不知道模型 ID 填什么？可以随时查看完整配置指南。",
    },
  };
  const step = steps[modelSettingsCoachState.step];
  if (!step) return;
  if (modelSettingsCoachState.step === 2) $("#advanced-settings").open = true;
  modelCoachTarget = $(step.target);
  modelCoachTarget.classList.add("model-coach-target");
  $("#model-coach-progress").textContent = `新手提示 · ${modelSettingsCoachState.step} / ${modelSettingsCoach.STEP_COUNT}`;
  $("#model-coach-title").textContent = step.title;
  $("#model-coach-description").textContent = step.description;
  $("#next-model-coach").textContent = modelSettingsCoachState.step === modelSettingsCoach.STEP_COUNT ? "完成" : "下一步";
  coach.classList.remove("hidden");
  modelCoachTarget.scrollIntoView({ behavior: "smooth", block: "center" });
  requestAnimationFrame(positionModelCoachMark);
}

function positionModelCoachMark() {
  if (modelSettingsCoachState.status !== "active" || !modelCoachTarget) return;
  const coach = $("#model-settings-coach");
  const targetRect = modelCoachTarget.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 32);
  coach.style.width = `${width}px`;
  const height = coach.offsetHeight;
  const placement = modelSettingsCoach.resolveModelCoachPosition({
    targetRect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    coachWidth: width,
    coachHeight: height,
  });
  coach.style.left = `${placement.left}px`;
  coach.style.top = `${placement.top}px`;
  coach.style.setProperty("--coach-arrow-left", `${placement.arrowLeft}px`);
  coach.classList.toggle("coach-above", placement.above);
}

function openModelGuide() {
  hideModelCoachVisual();
  modelSettingsViewState = modelSettingsView.transitionModelSettingsView(modelSettingsViewState, { type: "open-guide" });
  renderModelSettingsView();
  $("#model-config-guide").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeModelGuide() {
  modelSettingsViewState = modelSettingsView.transitionModelSettingsView(modelSettingsViewState, { type: "close-guide" });
  renderModelSettingsView();
}

function startModelProfileFromGuide() {
  closeModelGuide();
  openProfileEditor();
}

function renderModelSettingsView() {
  const guideOpen = modelSettingsViewState.guideOpen;
  $("#model-config-guide").classList.toggle("hidden", !guideOpen);
  $("#reopen-model-guide").textContent = guideOpen ? "收起配置指南" : "查看配置指南";
  $("#reopen-model-guide").setAttribute("aria-expanded", String(guideOpen));
  $("#model-profile-editor").classList.toggle("hidden", modelSettingsViewState.editorMode === "closed");
}

function openProfileEditor(profileId = "") {
  hideModelCoachVisual();
  editorProfile = modelProfiles.find((item) => item.id === profileId) || null;
  modelSettingsViewState = modelSettingsView.transitionModelSettingsView(modelSettingsViewState, {
    type: editorProfile ? "edit-config" : "create-config",
    profileId: editorProfile?.id || "",
  });
  loadedModels = [];
  $("#profile-id").value = editorProfile?.id || "";
  $("#profile-name").value = editorProfile?.name || "我的 WorkBuddy";
  $("#profile-runtime").value = editorProfile?.runtimeId || "codebuddy";
  $("#profile-ownership").value = editorProfile?.ownershipMode || "managed-local";
  renderProfileFields();
  $("#profile-provider").value = editorProfile?.providerId || "";
  renderProfileFields();
  $("#profile-base-url").value = editorProfile?.baseUrl || "";
  $("#profile-model-id").value = editorProfile?.modelId || "auto";
  $("#profile-codebuddy-custom-model-id").value = "";
  renderCodeBuddyModelSelect();
  $("#profile-api-key").value = "";
  $("#profile-service-password").value = "";
  $("#profile-sensitive-headers").value = "";
  const previousTest = profileTestResults.get(editorProfile?.id);
  if (previousTest?.modelId === $("#profile-model-id").value) setProfileResult(previousTest.text, previousTest.isError);
  else $("#profile-test-result").classList.add("hidden");
  $("#activate-model-profile").disabled = editorProfile?.status !== "verified";
  renderModelSettingsView();
  renderProfileEditorStatus();
  $("#model-profile-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeProfileEditor() {
  editorProfile = null;
  loadedModels = [];
  modelSettingsViewState = modelSettingsView.transitionModelSettingsView(modelSettingsViewState, { type: "close-editor" });
  renderModelSettingsView();
  clearSecretInputs();
}

function renderProfileFields() {
  const runtimeId = $("#profile-runtime").value;
  const isOpenCode = runtimeId === "opencode";
  const isCodeBuddy = runtimeId === "codebuddy";
  const isCompatibilityRuntime = COMPATIBILITY_RUNTIME_IDS.includes(runtimeId);
  const external = isOpenCode && $("#profile-ownership").value === "external";
  $("#profile-ownership-row").classList.toggle("hidden", !isOpenCode);
  $("#profile-service-password-row").classList.toggle("hidden", !external);
  $("#profile-service-password-label").textContent = isCodeBuddy ? "WorkBuddy 服务密码" : "OpenCode 服务密码";
  $("#external-opencode-notice").classList.toggle("hidden", !external);
  $("#profile-connection-step").classList.toggle("hidden", isCodeBuddy);
  $("#profile-base-url-row").classList.toggle("hidden", isCodeBuddy);
  $("#profile-api-key-row").classList.toggle("hidden", external || isCompatibilityRuntime);
  $("#profile-sensitive-headers-row").classList.toggle("hidden", external || isCompatibilityRuntime);
  $("#profile-provider-row").classList.toggle("hidden", isCodeBuddy);
  $("#profile-model-picker").classList.toggle("hidden", false);
  $("#profile-model-id-row").classList.toggle("hidden", isCodeBuddy);
  $("#profile-codebuddy-model-row").classList.toggle("hidden", !isCodeBuddy);
  $("#profile-codebuddy-custom-model").classList.toggle("hidden", !isCodeBuddy);
  const provider = $("#profile-provider");
  const previous = provider.value;
  if (runtimeId === "builtin-api") {
    provider.innerHTML = `<option value="">请选择供应商</option>${runtimeOptions.providers.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName)}</option>`).join("")}`;
  } else if (isOpenCode) {
    const known = [...new Set([editorProfile?.providerId, ...loadedModels.map((item) => item.providerId)].filter(Boolean))];
    provider.innerHTML = `<option value="opencode">从实例目录选择</option>${known.filter((id) => id !== "opencode").map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")}`;
  } else if (isCompatibilityRuntime) {
    provider.innerHTML = '<option value="compatibility">兼容运行时</option>';
  } else {
    provider.innerHTML = '<option value="">请先选择运行引擎</option>';
  }
  if ([...provider.options].some((option) => option.value === previous)) provider.value = previous;
  const strict = isOpenCode || provider.value === "openrouter";
  $("#profile-model-help").textContent = isCodeBuddy
    ? "模型下拉显示 WorkBuddy 的名称，保存和测试使用对应的真实模型 ID。点击“刷新模型”获取当前账号可用模型。"
    : strict ? "此运行方式必须从最新实时目录选择模型，不能使用手动 ID。" : "可从目录选择；目录不可用时也可以手动填写模型 ID。";
  renderRuntimeGuide(runtimeId);
  if (isCodeBuddy) renderCodeBuddyModelSelect();
  $("#codebuddy-environment").classList.toggle("hidden", !isCodeBuddy);
  renderCodeBuddyEnvironment();
  renderProfileEditorStatus();
}

function renderRuntimeGuide(runtimeId) {
  const guide = RUNTIME_SETUP_GUIDES[runtimeId];
  const step = $("#runtime-guide-step");
  if (!guide) { step.classList.add("hidden"); return; }
  step.classList.remove("hidden");
  $("#runtime-guide-title").textContent = guide.title;
  $("#runtime-guide-content").innerHTML = `<p>${escapeHtml(guide.body)}</p>${guide.steps ? `<ol>${guide.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : ""}${guide.notice ? `<details><summary>账号与兼容性说明</summary><p>${escapeHtml(guide.notice)}</p></details>` : ""}`;
}

function renderCodeBuddyEnvironment() {
  const container = $("#codebuddy-environment");
  if (!container) return;
  const status = snapshot?.codeBuddy || { state: "not_checked", label: "尚未检查 WorkBuddy", detail: "检查安装后，再通过连接测试确认登录和模型可用性。" };
  const profile = modelProfiles.find((item) => item.id === $("#profile-id")?.value) || editorProfile;
  const test = profileTestResults.get(profile?.id || "");
  const verified = profile?.status === "verified" || test?.code === "";
  const loginRequired = test?.code === "CODEBUDDY_LOGIN_REQUIRED";
  const title = verified
    ? "已登录且可用"
    : loginRequired ? "需要登录 WorkBuddy" : status.label || "WorkBuddy 环境";
  const detail = verified
    ? "连接测试已通过，当前模型可以使用。"
    : loginRequired
      ? "未检测到 WorkBuddy 登录，请先登录后再次测试。"
      : status.detail || "登录状态和模型可用性会在连接测试中确认。";
  $("#codebuddy-environment-title").textContent = title;
  $("#codebuddy-environment-detail").textContent = detail;
  $("#check-codebuddy-environment").disabled = status.state === "checking";
}

async function checkCodeBuddyEnvironment() {
  const button = $("#check-codebuddy-environment");
  button.disabled = true;
  try {
    const status = await api.checkCodeBuddy();
    snapshot = { ...(snapshot || {}), codeBuddy: status };
    renderCodeBuddyEnvironment();
  } catch (error) {
    $("#codebuddy-environment-detail").textContent = friendlyUiError(error);
  } finally {
    button.disabled = false;
  }
}

function missingRequiredApiKey() {
  if ($("#profile-runtime").value !== "builtin-api") return false;
  const provider = runtimeOptions.providers.find((item) => item.id === $("#profile-provider").value);
  if (!provider?.requiresApiKey || $("#profile-api-key").value.trim()) return false;
  return !(editorProfile?.providerId === provider.id && editorProfile?.hasApiKey === true);
}

function friendlyUiError(error) {
  const raw = String(error?.message || "");
  const code = String(error?.code || "").toUpperCase();
  if (["CODEBUDDY_BINARY_NOT_FOUND", "CODEBUDDY_CONNECTION_LOST", "CODEBUDDY_START_TIMEOUT"].includes(code)) {
    return "无法读取 WorkBuddy 模型目录。请先启动并登录 WorkBuddy，然后重试。";
  }
  if (code === "CODEBUDDY_LOGIN_REQUIRED") {
    return "还没有检测到 WorkBuddy 登录。请先登录后再刷新模型。";
  }
  if (code === "CODEBUDDY_API_INCOMPATIBLE") {
    return "当前 WorkBuddy 版本不支持模型发现。请更新后重试，或在高级设置中填写真实模型 ID。";
  }
  if (code === "CODEBUDDY_MODEL_UNAVAILABLE") {
    return "所选模型当前不可用。请刷新模型目录并重新选择。";
  }
  if (/Credential encryption failed|CREDENTIAL_ENCRYPT_FAILED|DPAPI/i.test(raw)) {
    return "无法安全保存凭据。请使用当前 Windows 用户重新登录后再试。";
  }
  if (/No saved WeChat account|WECHAT_LOGIN_REQUIRED|微信账号.*缺失/i.test(raw)) {
    return "尚未连接微信。请点击“连接微信”并扫码登录。";
  }
  if (/Multiple WeChat accounts|WECHAT_ACCOUNT_SELECTION_REQUIRED/i.test(raw)) {
    return "检测到多个微信账号，请先设置默认账号后再试。";
  }
  if (/Error invoking remote method|IPC_/i.test(raw)) {
    return "控制中心暂时无法完成此操作，请稍后重试或查看诊断详情。";
  }
  return raw || "操作失败，请按页面提示修复后重试。";
}

function applyProviderDefaults() {
  const preset = runtimeOptions.providers.find((item) => item.id === $("#profile-provider").value);
  if (preset?.defaultBaseUrl && !$("#profile-base-url").value) $("#profile-base-url").value = preset.defaultBaseUrl;
  renderProfileFields();
}

async function saveModelDraft(event) {
  event.preventDefault();
  try {
    const saved = await persistEditor({ includeSecrets: true });
    setProfileResult(`草稿“${saved.name}”已安全保存。还需要测试并激活。`, false);
  } catch (error) {
    setProfileResult(friendlyUiError(error), true);
  } finally {
    $("#profile-api-key").value = "";
    $("#profile-service-password").value = "";
    $("#profile-sensitive-headers").value = "";
  }
}

async function refreshProfileModels() {
  const button = $("#refresh-profile-models");
  button.disabled = true;
  setProfileResult("正在实时刷新模型目录…", false);
  try {
    const saved = await persistEditor({ includeSecrets: true, allowStrictWithoutCatalog: true });
    const result = await api.refreshModels(saved.id, { query: $("#profile-model-search").value });
    loadedModels = result.models || [];
    renderProfileFields();
    renderModelOptions();
    setProfileResult(result.stale ? "只取得旧目录，不能用于激活。请检查连接后重试。" : `已从 WorkBuddy 获取 ${loadedModels.length} 个可用模型。`, result.stale);
  } catch (error) {
    setProfileResult(friendlyUiError(error), true);
  } finally {
    clearSecretInputs();
    button.disabled = false;
  }
}

function renderModelOptions() {
  const query = $("#profile-model-search").value.trim().toLowerCase();
  const filtered = loadedModels.filter((model) => !query || `${model.id} ${model.name} ${model.providerId}`.toLowerCase().includes(query)).slice(0, 1000);
  $("#profile-model-options").innerHTML = filtered.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(`${model.providerId ? `${model.providerId} · ` : ""}${model.name || model.id}`)}</option>`).join("");
  renderCodeBuddyModelSelect();
}

function renderCodeBuddyModelSelect() {
  const select = $("#profile-codebuddy-model-select");
  if (!select || $("#profile-runtime").value !== "codebuddy") return;
  const current = $("#profile-model-id").value.trim();
  const query = $("#profile-model-search").value.trim().toLocaleLowerCase();
  const options = modelSettingsModelPicker.buildCodeBuddyModelOptions(loadedModels, current)
    .filter((model) => !query || `${model.id} ${model.label}`.toLocaleLowerCase().includes(query));
  select.innerHTML = options.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join("");
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function selectCodeBuddyModel() {
  $("#profile-model-id").value = $("#profile-codebuddy-model-select").value;
  $("#profile-codebuddy-custom-model-id").value = "";
  $("#profile-test-result").classList.add("hidden");
  renderProfileEditorStatus();
}

function selectCodeBuddyCustomModel() {
  if ($("#profile-runtime").value !== "codebuddy") return;
  $("#profile-model-id").value = $("#profile-codebuddy-custom-model-id").value.trim();
  $("#profile-test-result").classList.add("hidden");
  renderProfileEditorStatus();
}

function selectOpenCodeProviderForModel() {
  if ($("#profile-runtime").value !== "opencode") return;
  const selected = loadedModels.find((item) => item.id === $("#profile-model-id").value);
  if (!selected?.providerId) return;
  renderProfileFields();
  if (![...$("#profile-provider").options].some((option) => option.value === selected.providerId)) {
    $("#profile-provider").add(new Option(selected.providerId, selected.providerId));
  }
  $("#profile-provider").value = selected.providerId;
}

async function testModelProfile() {
  const button = $("#test-model-profile");
  button.disabled = true;
  if (missingRequiredApiKey()) {
    setProfileResult("还没有填写 API Key。请在上面的 API Key 字段中填写，然后再次测试连接。", true);
    button.disabled = false;
    return;
  }
  setProfileResult($("#profile-runtime").value === "codebuddy" ? "正在验证 WorkBuddy 登录、模型和连接…" : "正在检查模型能否完整回复、执行必要操作并继续任务…", false);
  try {
    const saved = await persistEditor({ includeSecrets: true });
    const result = await api.testProfile(saved.id);
    await reloadProfiles();
    editorProfile = modelProfiles.find((item) => item.id === saved.id) || null;
    if (result.ok) {
      $("#activate-model-profile").disabled = false;
      const text = "连接测试通过。现在可以激活此配置。";
      profileTestResults.set(saved.id, { profileId: saved.id, modelId: saved.modelId, isError: false, text, code: "" });
      setProfileResult(text, false);
      renderCodeBuddyEnvironment();
    } else {
      $("#activate-model-profile").disabled = true;
      const current = modelProfiles.find((item) => item.id === saved.id) || saved;
      const active = modelProfiles.find((item) => item.id === resolveActiveProfileId()) || null;
      const text = profileEditorState.formatProfileTestFailure({ profile: current, activeProfile: active, error: result.error });
      profileTestResults.set(saved.id, { profileId: saved.id, modelId: saved.modelId, isError: true, text, code: result.error?.code || "" });
      setProfileResult(text, true);
      renderCodeBuddyEnvironment();
    }
  } catch (error) {
    setProfileResult(friendlyUiError(error), true);
  } finally {
    clearSecretInputs();
    button.disabled = false;
  }
}

async function activateModelProfile() {
  const id = $("#profile-id").value;
  if (!id) return setProfileResult("请先保存并测试配置。", true);
  await activateExistingProfile(id);
}

async function activateExistingProfile(id) {
  const previousActiveId = snapshot?.engine?.activeProfile?.id || snapshot?.runtime?.selectedProfileId || "";
  setProfileResult("正在安全切换模型；当前回复和工具会先完成…", false);
  try {
    await api.activateProfile(id, { graceMs: 120000 });
    await reloadProfiles();
    renderSnapshot(await api.getSnapshot());
    setProfileResult("模型配置已激活。", false);
    $("#nav-control").click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    await reloadProfiles();
    editorProfile = modelProfiles.find((item) => item.id === previousActiveId) || editorProfile;
    renderSnapshot(await api.getSnapshot());
    const previous = modelProfiles.find((item) => item.id === previousActiveId);
    setProfileResult(`切换失败；${previous ? `仍在使用“${previous.name}”` : "未改变原选择"}。${friendlyUiError(error)}`, true);
  }
}

async function testExistingProfile(id) {
  openProfileEditor(id);
  await testModelProfile();
}

async function deleteModelProfile(id) {
  const target = modelProfiles.find((item) => item.id === id);
  if (!target || !window.confirm(`确认删除“${target.name}”吗？已保存的凭据也会从本机安全存储中删除。`)) return;
  try {
    await api.deleteProfile(id);
    if (editorProfile?.id === id) closeProfileEditor();
    await reloadProfiles();
  } catch (error) {
    setProfileResult(friendlyUiError(error), true);
  }
}

async function persistEditor({ includeSecrets, allowStrictWithoutCatalog = false } = {}) {
  const runtimeId = $("#profile-runtime").value;
  const providerId = $("#profile-provider").value;
  const modelId = $("#profile-model-id").value.trim();
  const strict = runtimeId === "opencode" || providerId === "openrouter";
  if (strict && !allowStrictWithoutCatalog && !loadedModels.some((model) => model.id === modelId && (runtimeId !== "opencode" || model.providerId === providerId))) {
    throw new Error("OpenRouter 和 OpenCode 必须刷新目录并从实时结果中选择模型。");
  }
  const saved = await api.saveProfile({
    id: $("#profile-id").value || undefined,
    name: $("#profile-name").value,
    runtimeId,
    ownershipMode: runtimeId === "opencode" ? $("#profile-ownership").value : "",
    providerId,
    baseUrl: $("#profile-base-url").value,
    modelId,
  });
  $("#profile-id").value = saved.id;
  if (includeSecrets) {
    const secrets = collectSecretInputs();
    if (Object.keys(secrets).length) await api.writeProfileSecrets(saved.id, secrets);
  }
  await reloadProfiles();
  editorProfile = modelProfiles.find((item) => item.id === saved.id) || saved;
  return editorProfile;
}

function collectSecretInputs() {
  const apiKey = $("#profile-api-key").value.trim();
  const servicePassword = $("#profile-service-password").value.trim();
  const sensitiveHeaders = parseSensitiveHeaders($("#profile-sensitive-headers").value);
  return { ...(apiKey ? { apiKey } : {}), ...(servicePassword ? { servicePassword } : {}), ...(Object.keys(sensitiveHeaders).length ? { sensitiveHeaders } : {}) };
}

function parseSensitiveHeaders(value) {
  const result = {};
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("敏感 header 必须按 name: value 每行填写一项。");
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function clearSecretInputs() {
  $("#profile-api-key").value = "";
  $("#profile-service-password").value = "";
  $("#profile-sensitive-headers").value = "";
}

async function reloadProfiles() {
  modelProfiles = await api.listProfiles();
  renderModelProfiles();
}

function setProfileResult(text, isError) {
  const result = $("#profile-test-result");
  result.textContent = text;
  result.classList.remove("hidden");
  result.classList.toggle("error-result", Boolean(isError));
  renderProfileEditorStatus();
}

function renderProfileEditorStatus() {
  const container = $("#profile-editor-status");
  if (!container) return;
  const id = $("#profile-id")?.value || "";
  const state = profileEditorState.resolveProfileEditorState({
    profiles: modelProfiles,
    profileId: id,
    activeProfileId: resolveActiveProfileId(),
    testResult: profileTestResults.get(id) || null,
  });
  const currentModelId = $("#profile-model-id")?.value.trim() || "";
  const testMatches = state.testResult && state.modelId === currentModelId;
  $("#profile-editor-title").textContent = `正在编辑：${state.name}`;
  $("#profile-editor-state").textContent = testMatches?.isError
    ? `${state.status} · 模型 ID：${currentModelId}`
    : state.active ? state.status : `状态：${state.status}`;
  container.classList.toggle("error-result", Boolean(testMatches?.isError));
}

function resolveActiveProfileId() {
  return snapshot?.engine?.activeProfile?.id
    || modelProfiles.find((item) => item.id === snapshot?.runtime?.selectedProfileId)?.id
    || "";
}

function renderEngine(engine, runtime) {
  const active = engine?.activeProfile;
  $("#engine-name").textContent = active ? runtimeLabel(active.runtimeId) : "尚未配置";
  if (runtime?.phase === "switching" && runtime.switchTransaction) {
    const remaining = Math.max(0, Math.ceil((Date.parse(runtime.switchTransaction.deadlineAt) - Date.now()) / 1000));
    $("#engine-detail").textContent = `正在${switchPhaseLabel(runtime.switchTransaction.phase)} · 最多等待 ${remaining} 秒`;
  } else {
    $("#engine-detail").textContent = active
      ? (active.runtimeId === "codebuddy" ? `WorkBuddy · ${active.modelId}` : `${providerLabel(active.providerId)} · ${active.modelId}`)
      : "请先连接 AI 模型";
  }
}

async function updateDiagnosticCapture(action) {
  const result = $("#diagnostic-capture-result");
  try {
    await api.setDiagnosticCapture({ action, consent: $("#diagnostic-consent").checked, durationMs: Number($("#diagnostic-duration").value), scope: "connection-test" });
    result.textContent = ({ enable: "临时诊断已启用。", disable: "已停止记录，现有记录仍会按期自动删除。", delete: "临时诊断记录已立即删除。" })[action];
  } catch (error) {
    result.textContent = error.message || "诊断设置失败。";
  }
  result.classList.remove("hidden");
}

function runtimeLabel(id, fallback = "") { return ({ "builtin-api": "内置 API", opencode: "OpenCode", codex: "Codex（兼容）", claudecode: "Claude Code（兼容）", codebuddy: "WorkBuddy" })[id] || fallback || id || "—"; }
function providerLabel(id) { return runtimeOptions.providers.find((item) => item.id === id)?.displayName || id || "—"; }
function profileStatusLabel(status) { return profileEditorState.profileStatusLabel(status); }
function switchPhaseLabel(phase) { return ({ draining: "等待当前工作完成", aborting: "停止超时工作", stopping_old: "停止原模型", starting_new: "启动新模型", probing_new: "确认新模型状态", rolling_back: "恢复原模型" })[phase] || "切换模型"; }

async function saveSettings() {
  renderSnapshot(await api.updateSettings({
    startWithWindows: $("#startup-setting").checked,
    randomCheckinsEnabled: $("#random-setting").checked,
    reportEnabled: $("#report-setting").checked,
    reportTime: $("#report-time").value,
    contextDurations: { meal: Number($("#meal-duration").value), shower: Number($("#shower-duration").value) },
  }));
}

async function savePersonaPack() {
  const result = await api.setPersonaPack($("#persona-setting").value);
  if (result?.personaPack) {
    renderPersonaPack(result.personaPack);
  }
  if (result && result.ok === false) {
    window.alert(result.error || "人格包切换失败。");
  }
}

function renderPersonaPack(personaPack) {
  const select = $("#persona-setting");
  if (!select) return;
  const state = personaPack || { activeId: "", packages: [] };
  const options = ['<option value="">不启用（默认人格）</option>'];
  for (const pack of state.packages || []) {
    options.push(`<option value="${escapeHtml(pack.id)}">${escapeHtml(pack.name || pack.id)}</option>`);
  }
  select.innerHTML = options.join("");
  select.value = state.activeId || "";
  const detail = $("#persona-detail");
  if (detail) {
    const active = (state.packages || []).find((pack) => pack.id === state.activeId);
    detail.textContent = active?.description
      ? `${active.description} · 对新会话生效`
      : "不启用时保持默认人格，对新会话生效";
  }
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
  showOperationResult(result.restored ? "恢复完成，艾迪保持停止状态。" : result.error || "恢复失败。");
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
