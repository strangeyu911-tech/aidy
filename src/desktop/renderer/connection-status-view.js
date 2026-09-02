(function attachConnectionStatusView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.cyberbossConnectionStatusView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConnectionStatusView() {
  "use strict";

  function stateDisplay(phase, desired, onboarding = null, error = null) {
    if (onboarding?.complete && ["running", "quiet"].includes(phase)) {
      return { title: "CyberBoss 已配置完成并正在运行", short: "运行中", description: "AI 模型已连接，微信已连接。现在可以关闭控制中心，CyberBoss 会继续在托盘运行。" };
    }
    if (onboarding?.step === "wechat" && phase !== "starting") {
      return { title: "还差微信连接", short: "待连接", description: "模型已经准备好。连接微信后，才能接收和回复消息。" };
    }
    if (onboarding?.step === "start" && phase === "stopped") {
      return { title: "准备启动", short: "待启动", description: "模型和微信都已准备好，启动 CyberBoss 后才会开始工作。" };
    }
    if (phase === "configuration_required") return { title: "需要设置模型", short: "未配置", description: "请先连接 AI 模型并完成测试。" };
    if (phase === "switching") return { title: "正在切换模型", short: "切换中", description: "正在等待当前回复与工具安全结束，然后切换模型服务。" };
    if (phase === "starting") return { title: "正在启动", short: "启动中", description: "正在依次连接模型服务与微信，完成后会自动进入监管状态。" };
    if (phase === "stopping") return { title: "正在停止", short: "停止中", description: "正在安全关闭后台服务和当前任务。" };
    if (phase === "error") {
      return { title: "需要处理", short: "异常", description: normalizeText(error?.summary) || "连接状态无法确定，请查看诊断信息。" };
    }
    if (desired === "quiet") return { title: "静默运行中", short: "静默", description: "会回复你的消息，并继续同步、日记和报表；不会主动发起查岗。" };
    if (desired === "running") return { title: "监管运行中", short: "运行", description: "微信回复、随机查岗和固定安排都已启用。关闭窗口后仍会在托盘运行。" };
    return { title: "已停止", short: "停止", description: "后台服务已停止；控制中心仍留在托盘，可随时重新启动。" };
  }

  function resolveErrorView(error) {
    if (!error) return null;
    const capability = normalizeText(error.capability) || "runtime";
    const nextAction = normalizeText(error.nextAction) || "inspect_logs";
    return {
      code: normalizeText(error.code) || "UNKNOWN_ERROR",
      capabilityLabel: ["bridge", "wechat"].includes(capability) ? "微信连接" : capability === "runtime" ? "后台服务" : capability,
      summary: normalizeText(error.summary) || "无法确定具体故障原因。",
      repairAction: normalizeText(error.repairAction) || "请打开“数据与诊断”查看最近日志，记录诊断代码后再重试。",
      buttonAction: nextAction === "wechat_login" ? "wechat_login" : nextAction === "retry" ? "retry" : "",
      buttonLabel: nextAction === "wechat_login" ? "连接微信" : nextAction === "retry" ? "重试启动" : "",
    };
  }

  function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  return { resolveErrorView, stateDisplay };
});
