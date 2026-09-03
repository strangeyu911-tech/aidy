"use strict";

const WECHAT_CAPABILITIES = new Set(["bridge", "wechat"]);

function createConnectionDiagnostic(error, { now = () => new Date() } = {}) {
  const code = normalizeText(error?.code) || "PROCESS_ERROR";
  const capability = normalizeText(error?.capability) || "runtime";
  const known = knownDiagnostic(code, capability);
  const suppliedRepair = normalizeText(error?.repairAction);
  const suppliedSummary = normalizeText(error?.summary || error?.message);
  return {
    category: known?.category || normalizeText(error?.category) || "process",
    code,
    capability,
    summary: known?.summary || suppliedSummary || "无法确定后台连接失败的具体原因。",
    repairAction: known?.repairAction || suppliedRepair || "请打开“数据与诊断”查看最近日志，记录诊断代码后再重试。",
    remediationKnown: Boolean(known || suppliedRepair),
    nextAction: known?.nextAction || (suppliedRepair ? "retry" : "inspect_logs"),
    timestamp: normalizeTimestamp(error?.timestamp, now),
  };
}

function knownDiagnostic(code, capability) {
  switch (code) {
    case "WECHAT_LOGIN_REQUIRED":
      return configuration("微信登录信息不可用。", "点击“连接微信”，重新扫码登录。", "wechat_login");
    case "WECHAT_ACCOUNT_SELECTION_REQUIRED":
      return configuration("检测到多个微信账号，艾迪无法确定要连接哪一个。", "设置默认微信账号后重试。", "inspect_logs");
    case "WECHAT_SESSION_EXPIRED":
      return configuration("微信连接已过期。", "点击“连接微信”，重新扫码登录。", "wechat_login");
    case "WECHAT_CLIENT_NOT_RUNNING":
      return configuration("电脑版微信没有运行。", "请先启动电脑版微信，然后重新检查。", "retry");
    case "WECHAT_CLIENT_NOT_LOGGED_IN":
      return configuration("电脑版微信尚未登录。", "请在电脑版微信完成登录，然后重新检查。", "retry");
    case "WECHAT_CONNECTION_UNAVAILABLE":
      return processDiagnostic("微信服务当前不可访问。", "请确认网络可用后点击“重试启动”；若微信登录已过期，请重新连接微信。", "retry");
    case "BRIDGE_RUNTIME_FILES_MISSING":
      return processDiagnostic("艾迪内部微信连接运行文件不可用。", "请完全退出艾迪，然后从原便携版文件重新启动；若仍失败，请重新下载或安装艾迪。", "restart_app");
    case "BRIDGE_NOT_READY":
      return processDiagnostic("艾迪内部微信连接服务未能完成启动。", "点击“重试启动”；若仍失败，请完全退出并重新启动艾迪。", "retry");
    case "BRIDGE_CONTROL_UNAVAILABLE":
    case "BRIDGE_CONTROL_TIMEOUT":
      return processDiagnostic("艾迪无法完成微信连接服务的健康检查。", "点击“重试启动”；若仍失败，请完全退出并重新启动艾迪。", "retry");
    case "RESTART_CIRCUIT_OPEN":
      if (WECHAT_CAPABILITIES.has(capability)) {
        return processDiagnostic("微信连接服务连续退出，艾迪已暂停自动重试。", "请先查看最近日志中的诊断代码，再完全退出并重新启动艾迪。", "inspect_logs");
      }
      return null;
    default:
      return null;
  }
}

function resolveWechatStatus(runtime = {}, account = {}) {
  if (["running", "quiet"].includes(runtime.phase)) {
    return { ...account, state: "connected", label: "已连接", detail: "微信回复和监管安排已启用。", diagnostic: null };
  }
  if (runtime.phase === "starting") {
    return { ...account, state: "connecting", label: "正在连接", detail: "正在连接微信和模型服务。", diagnostic: null };
  }
  if (runtime.phase === "error" && account.configured) {
    const diagnostic = createConnectionDiagnostic(runtime.error);
    if (!WECHAT_CAPABILITIES.has(diagnostic.capability)) {
      return {
        ...account,
        state: "blocked",
        label: "等待后台服务",
        detail: "微信登录状态正常，但艾迪尚未启动到微信连接阶段。",
        diagnostic: null,
      };
    }
    return {
      ...account,
      state: "error",
      label: "连接异常",
      detail: diagnostic.summary,
      diagnostic,
    };
  }
  if (!account.configured) return { ...account, diagnostic: null };
  return { ...account, state: "ready", label: "已登录", detail: "启动艾迪后会连接微信。", diagnostic: null };
}

function configuration(summary, repairAction, nextAction) {
  return { category: "configuration", summary, repairAction, nextAction };
}

function processDiagnostic(summary, repairAction, nextAction) {
  return { category: "process", summary, repairAction, nextAction };
}

function normalizeTimestamp(value, now) {
  if (Number.isFinite(Date.parse(value || ""))) return new Date(value).toISOString();
  const current = now();
  return (current instanceof Date ? current : new Date(current)).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  WECHAT_CAPABILITIES,
  createConnectionDiagnostic,
  resolveWechatStatus,
};
