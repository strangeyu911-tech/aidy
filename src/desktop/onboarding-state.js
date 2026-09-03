"use strict";

function resolveWeixinAccountStatus({ config = {}, listAccounts, loadAccount } = {}) {
  try {
    const accounts = config.accountId
      ? [loadAccount?.(config, config.accountId)].filter(Boolean)
      : (listAccounts?.(config) || []);
    if (!accounts.length) return { state: "not_configured", configured: false, label: "尚未连接", detail: "需要先扫码登录微信。" };
    if (accounts.length > 1 && !config.accountId) {
      return { state: "needs_selection", configured: false, label: "需要选择账号", detail: "检测到多个微信账号，请设置默认账号后再启动。" };
    }
    const account = accounts[0];
    if (!account.token) return { state: "needs_login", configured: false, label: "需要重新登录", detail: "微信登录信息不完整，请重新扫码登录。" };
    return { state: "ready", configured: true, label: "已登录", detail: "启动艾迪后会连接微信。", accountId: account.accountId };
  } catch (error) {
    return { state: "error", configured: false, label: "微信状态异常", detail: "无法读取微信登录状态，请重新登录。", errorCode: error.code || "WECHAT_STATUS_FAILED" };
  }
}

function resolveOnboardingStatus({ engine, runtime, wechat, settings } = {}) {
  const modelReady = engine?.configurationRequired === false && Boolean(engine.activeProfile);
  const running = ["running", "quiet"].includes(runtime?.phase);
  const hasRunBefore = ["running", "quiet"].includes(settings?.lastStableState);
  if (!modelReady) return { step: "model", complete: false, title: "先连接一个你能使用的模型", description: "完成模型连接测试并激活后，下一步是连接微信。" };
  if (!wechat?.configured) return { step: "wechat", complete: false, title: "连接微信", description: "模型已经准备好。请扫码登录微信，艾迪才能接收和回复消息。" };
  if (!running && !hasRunBefore) return { step: "start", complete: false, title: "启动艾迪", description: "模型和微信都已准备好，启动后艾迪才会开始工作。" };
  return {
    step: "complete",
    complete: true,
    title: running ? "艾迪已配置完成并正在运行" : "艾迪已配置完成",
    description: running
      ? "AI 模型已连接，微信已连接。现在可以关闭控制中心，艾迪会继续在托盘运行。"
      : "AI 模型和微信均已连接。当前艾迪已停止，可随时启动。",
  };
}

module.exports = { resolveOnboardingStatus, resolveWeixinAccountStatus };
