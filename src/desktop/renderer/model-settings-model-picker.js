"use strict";

(function exposeModelSettingsModelPicker(global) {
  const DEFAULT_CODEBUDDY_MODEL = Object.freeze({ id: "auto", name: "Auto", label: "Auto" });

  function normalizeModelOption(value) {
    const source = value && typeof value === "object" ? value : {};
    const id = normalizeText(source.id || source.modelId);
    if (!id) return null;
    const label = normalizeText(source.label || source.name || source.displayName) || id;
    return {
      id,
      name: normalizeText(source.name || source.displayName) || label,
      label,
      providerId: normalizeText(source.providerId),
    };
  }

  function buildCodeBuddyModelOptions(models, currentModelId = "") {
    const result = [];
    const seen = new Set();
    for (const candidate of Array.isArray(models) ? models : []) {
      const model = normalizeModelOption(candidate);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      result.push(model);
    }
    if (!seen.has(DEFAULT_CODEBUDDY_MODEL.id)) result.unshift({ ...DEFAULT_CODEBUDDY_MODEL });
    const current = normalizeText(currentModelId);
    if (current && !seen.has(current) && current !== DEFAULT_CODEBUDDY_MODEL.id) {
      result.push({ id: current, name: current, label: `${current}（当前配置，目录未返回）`, providerId: "" });
    }
    return result;
  }

  function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }

  const api = { DEFAULT_CODEBUDDY_MODEL, buildCodeBuddyModelOptions, normalizeModelOption };
  global.cyberbossModelSettingsModelPicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
