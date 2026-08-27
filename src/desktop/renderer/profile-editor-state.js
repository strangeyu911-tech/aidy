"use strict";

(function exposeProfileEditorState(global) {
  function resolveProfileEditorState({ profiles = [], profileId = "", activeProfileId = "", testResult = null } = {}) {
    const profile = profiles.find((item) => item?.id === profileId) || null;
    const activeProfile = profiles.find((item) => item?.id === activeProfileId) || null;
    const currentTest = profile && testResult?.profileId === profile.id && testResult.modelId === profile.modelId
      ? testResult
      : null;
    const active = Boolean(profile && profile.id === activeProfileId);
    return {
      profile,
      activeProfile,
      name: profile?.name || "未命名配置",
      modelId: profile?.modelId || "",
      active,
      status: active ? "当前使用 · 已验证" : currentTest?.isError ? "测试失败" : profileStatusLabel(profile?.status),
      testResult: currentTest,
    };
  }

  function formatProfileTestFailure({ profile, activeProfile, error } = {}) {
    const name = profile?.name || "未命名配置";
    const modelId = profile?.modelId || "未填写";
    const code = error?.code || "CONNECTION_TEST_FAILED";
    const summary = error?.summary || "连接测试未通过。";
    const issue = code === "CODEBUDDY_MODEL_UNAVAILABLE"
      ? `模型 ID “${modelId}”不可用。`
      : `模型 ID “${modelId}”未通过连接测试。`;
    const impact = activeProfile && activeProfile.id !== profile?.id
      ? `当前仍在使用“${activeProfile.name || "未命名配置"}”，本次失败不会影响它。`
      : "此配置尚未激活，不会改变当前运行配置。";
    return `配置“${name}”测试失败：${issue}${summary} ${impact} 修复建议：${error?.repairAction || "检查配置后再次测试"}（${code}）`;
  }

  function profileStatusLabel(status) {
    return ({ verified: "已验证", draft: "草稿 · 需要测试", unverified: "验证已失效" })[status] || "草稿 · 需要测试";
  }

  const api = { formatProfileTestFailure, profileStatusLabel, resolveProfileEditorState };
  global.cyberbossProfileEditorState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
