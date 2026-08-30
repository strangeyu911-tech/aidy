"use strict";

const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

const { computeVerificationFingerprint } = require("../core/provider-profile-store");
const { getRuntimeDefinition, listRuntimeDefinitions } = require("../core/runtime-registry");
const { PROVIDER_PRESETS, getProviderPreset } = require("../services/provider-catalog");

const MAX_IPC_PAYLOAD_BYTES = 32 * 1024;
const MAX_SECRET_VALUE_BYTES = 8 * 1024;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROFILE_NAME_LENGTH = 120;
const MAX_HEADER_COUNT = 16;
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization", "set-cookie", "transfer-encoding",
]);

const MODEL_IPC_CHANNELS = Object.freeze([
  "desktop:list-runtime-options",
  "desktop:list-profiles",
  "desktop:save-profile",
  "desktop:write-profile-secrets",
  "desktop:refresh-models",
  "desktop:test-profile",
  "desktop:activate-profile",
  "desktop:delete-profile",
  "desktop:set-diagnostic-capture",
]);

const ERROR_GUIDANCE = Object.freeze({
  INVALID_CREDENTIALS: guidance("credentials", "API Key 或服务凭据无效。", "重新输入凭据，然后再次测试连接。"),
  MISSING_CREDENTIALS: guidance("credentials", "缺少 API Key 或服务凭据。", "填写此供应商要求的凭据，然后再次测试。"),
  UNREACHABLE_BASE_URL: guidance("endpoint", "无法连接到模型服务地址。", "检查 Base URL、网络和本地服务是否正在运行。"),
  INVALID_BASE_URL: guidance("endpoint", "模型服务地址格式不正确。", "使用完整的 HTTP 或 HTTPS 地址，且不要在地址中放入用户名或密码。"),
  MODEL_UNAVAILABLE: guidance("model", "当前凭据无法使用所选模型。", "刷新模型列表，并选择当前可用的模型。"),
  MODEL_NOT_IN_LIVE_CATALOG: guidance("model", "所选模型不在最新的实时目录中。", "刷新模型列表并重新选择模型。"),
  QUOTA_EXHAUSTED: guidance("quota", "模型账户余额或配额不足。", "在供应商控制台补充余额或配额后重试。"),
  RATE_LIMITED: guidance("rate-limit", "模型服务暂时限流。", "稍后重试，或检查供应商的速率限制。"),
  TIMEOUT: guidance("network", "连接测试超时。", "检查网络与服务状态，然后再次测试。"),
  CANCELLED: guidance("cancelled", "连接测试已取消。", "需要时重新开始连接测试。"),
  INCOMPATIBLE_PROTOCOL: guidance("protocol", "服务响应与所选协议不兼容。", "确认供应商、Base URL 和协议类型是否匹配。"),
  STREAMING_UNSUPPORTED: guidance("capability", "所选模型不支持 CyberBoss 所需的流式回复。", "更换支持流式回复的模型。"),
  TOOL_CALLING_UNSUPPORTED: guidance("capability", "所选模型不支持 CyberBoss 所需的工具调用。", "更换支持原生工具调用的模型。"),
  TOOL_CALL_MALFORMED: guidance("capability", "模型返回了无法使用的工具参数。", "更换模型，或检查兼容服务的工具调用实现。"),
  TOOL_RESULT_UNAVAILABLE: guidance("capability", "运行时未确认工具执行结果。", "检查运行时版本和工具支持后再次测试。"),
  TOOL_CONTINUATION_UNSUPPORTED: guidance("capability", "模型无法在工具执行后继续回复。", "更换支持完整工具调用流程的模型。"),
  CANCELLATION_UNSUPPORTED: guidance("capability", "模型服务未正确响应取消请求。", "更换兼容服务或模型。"),
  UNSAFE_TOOL_REQUESTED: guidance("security", "验证期间请求了未获准的操作。", "检查运行时工具配置；验证只允许专用只读工具。"),
  APPROVAL_RESPONSE_FAILED: guidance("security", "无法安全拒绝或批准验证工具。", "检查运行时连接后重试；在修复前不要激活此配置。"),
  CREDENTIAL_CHANGED: guidance("credentials", "验证期间凭据发生变化。", "保存凭据后重新运行连接测试。"),
  PROFILE_CHANGED: guidance("profile", "验证期间配置发生变化。", "保存当前配置后重新运行连接测试。"),
  MODEL_SERVICE_TIMEOUT: guidance("network", "运行时验证超时。", "检查模型服务与本地运行时后再次测试。"),
  OPENCODE_UNHEALTHY: guidance("opencode", "OpenCode 服务当前不健康。", "确认 OpenCode 服务已启动并可访问。"),
  OPENCODE_INCOMPATIBLE: guidance("opencode", "OpenCode 版本或响应不兼容。", "升级 OpenCode，或检查外部服务地址。"),
  OPENCODE_SPAWN_FAILED: guidance("opencode", "无法启动托管 OpenCode。", "确认已安装兼容的 OpenCode，并检查可执行文件设置。"),
  RUNTIME_VERIFIER_UNAVAILABLE: guidance("runtime", "当前兼容运行时还不能完成安全验证。", "检查本机运行时安装；也可以先选择内置 API 或 OpenCode。"),
  CODEBUDDY_BINARY_NOT_FOUND: guidance("setup", "没有找到 WorkBuddy。", "安装并登录 WorkBuddy 后重新打开 CyberBoss。"),
  CODEBUDDY_LOGIN_REQUIRED: guidance("login", "还没有检测到可用的 WorkBuddy 登录。", "先在 WorkBuddy 中登录，然后回到这里再次测试。"),
  CODEBUDDY_AUTH_FAILED: guidance("connection", "无法建立本机模型连接。", "重新测试；CyberBoss 会自动管理本机连接所需的安全凭据。"),
  CODEBUDDY_API_INCOMPATIBLE: guidance("compatibility", "当前 WorkBuddy 版本暂时不兼容。", "升级或更换兼容版本后，再次测试连接。"),
  CODEBUDDY_MODEL_UNAVAILABLE: guidance("model", "WorkBuddy 当前无法使用这个模型。", "刷新模型目录并选择当前可用的模型；显示名称不一定是模型 ID。"),
  CODEBUDDY_SESSION_FAILED: guidance("connection", "WorkBuddy 无法创建模型会话。", "确认 WorkBuddy 已登录且网络正常，然后再次测试。"),
  CODEBUDDY_TURN_FAILED: guidance("connection", "WorkBuddy 没有完成连接测试。", "确认模型可用后再次测试；如果仍失败，请升级 WorkBuddy。"),
  CREDENTIAL_ENCRYPT_FAILED: guidance("vault", "无法安全保存凭据。", "使用当前 Windows 用户重新登录后再试。"),
  CREDENTIAL_DECRYPT_FAILED: guidance("vault", "无法读取已保存的凭据。", "重新输入凭据并再次验证。"),
});

class ModelSettingsService {
  constructor({ profileStore, credentialVault, catalog, verifier, supervisor, diagnosticCapture = null, runtimeVerifier = null } = {}) {
    requireMethod(profileStore, "listMasked", "profile store");
    requireMethod(profileStore, "get", "profile store");
    requireMethod(profileStore, "upsertDraft", "profile store");
    requireMethod(profileStore, "activate", "profile store");
    requireMethod(credentialVault, "write", "credential vault");
    requireMethod(catalog, "list", "provider catalog");
    requireMethod(verifier, "verify", "provider verifier");
    this.profileStore = profileStore;
    this.credentialVault = credentialVault;
    this.catalog = catalog;
    this.verifier = verifier;
    this.supervisor = supervisor || { phase: "stopped", desiredState: "stopped" };
    this.diagnosticCapture = diagnosticCapture;
    this.runtimeVerifier = runtimeVerifier;
  }

  async listRuntimeOptions() {
    return {
      runtimes: listRuntimeDefinitions().map((definition) => ({
        ...definition,
        isDefault: false,
        ...(definition.id === "codebuddy" ? {
          isRecommended: true,
          productLabel: "WorkBuddy",
          setupHint: "适合刚开始使用 CyberBoss 的用户：安装并登录 WorkBuddy 后返回这里即可。",
        } : { isRecommended: false }),
        ...(definition.id === "opencode" ? {
          ownershipModes: ["managed-local", "external"],
          externalCredentialNotice: "外部实例的 provider 凭据由外部实例配置；CyberBoss 不接收 provider key，只可保存可选的服务密码。",
        } : {}),
      })),
      providers: Object.values(PROVIDER_PRESETS).map((preset) => ({ ...preset })),
      activeProfileLimit: 1,
      defaultRuntimeId: "",
    };
  }

  async listProfiles() {
    return this.profileStore.listMasked().map((profile) => sanitizeProfileSnapshot(profile));
  }

  async saveProfile(input) {
    assertPayloadSize(input);
    const existing = this.profileStore.get(normalizeText(input?.id));
    const draft = validateProfileInput(input, existing);
    let saved = this.profileStore.upsertDraft(draft);
    const mustRemoveProviderSecrets = saved.runtimeId === "opencode" && saved.ownershipMode === "external"
      && Boolean(existing?.secretRefs?.apiKey || Object.keys(existing?.secretRefs?.sensitiveHeaders || {}).length);
    if (mustRemoveProviderSecrets) {
      const currentSecrets = await this.#readSecrets(saved.id);
      const retainedSecrets = normalizeText(currentSecrets.servicePassword)
        ? { servicePassword: currentSecrets.servicePassword }
        : {};
      const { generation } = await this.credentialVault.write(saved.id, retainedSecrets);
      saved = this.profileStore.markSecretWritten(saved.id, {
        generation,
        secretRefs: {
          apiKey: "",
          servicePassword: retainedSecrets.servicePassword ? `vault:${saved.id}:service-password` : "",
          sensitiveHeaders: {},
        },
      });
    }
    this.catalog.invalidate?.(saved.id);
    if (saved.runtimeId === "codebuddy" && !saved.secretRefs?.servicePassword) {
      const servicePassword = crypto.randomBytes(24).toString("base64url");
      const { generation } = await this.credentialVault.write(saved.id, { servicePassword });
      saved = this.profileStore.markSecretWritten(saved.id, {
        generation,
        secretRefs: {
          apiKey: "",
          servicePassword: `vault:${saved.id}:service-password`,
          sensitiveHeaders: {},
        },
      });
    }
    return sanitizeProfileSnapshot(this.profileStore.listMasked().find((item) => item.id === saved.id) || saved);
  }

  async writeProfileSecrets(profileId, input) {
    assertPayloadSize(input);
    const id = requireProfileId(profileId);
    const profile = requireProfile(this.profileStore, id);
    const secrets = validateSecrets(input);
    if (profile.runtimeId === "opencode" && profile.ownershipMode === "external"
      && (secrets.apiKey || Object.keys(secrets.sensitiveHeaders || {}).length)) {
      throw serviceError("EXTERNAL_OPENCODE_PROVIDER_KEY_REJECTED", "External OpenCode owns its provider credentials.");
    }
    const { generation } = await this.credentialVault.write(id, secrets);
    const secretRefs = {
      apiKey: secrets.apiKey ? `vault:${id}:api-key` : "",
      servicePassword: secrets.servicePassword ? `vault:${id}:service-password` : "",
      sensitiveHeaders: Object.fromEntries(Object.keys(secrets.sensitiveHeaders || {}).map((name) => [name, `vault:${id}:header:${name.toLowerCase()}`])),
    };
    if (typeof this.profileStore.markSecretWritten === "function") {
      this.profileStore.markSecretWritten(id, { generation, secretRefs });
    } else {
      this.profileStore.markUnverified?.(id, "credentials_changed");
    }
    this.catalog.invalidate?.(id);
    return { ok: true, generation, flags: secretFlags(secretRefs) };
  }

  async refreshModels(profileId, options = {}) {
    assertPayloadSize(options);
    const profile = requireProfile(this.profileStore, requireProfileId(profileId));
    const secrets = await this.#readSecrets(profile.id);
    const result = await this.catalog.list(profile, secrets, {
      reason: "manual-refresh",
      forceRefresh: true,
      query: normalizeText(options.query).slice(0, 200),
    });
    return sanitizeCatalog(result);
  }

  async testProfile(profileId) {
    const profile = requireProfile(this.profileStore, requireProfileId(profileId));
    let result;
    if (profile.runtimeId === "builtin-api") {
      result = await this.verifier.verify(profile.id);
    } else if (typeof this.runtimeVerifier === "function") {
      result = await this.runtimeVerifier(profile.id);
    } else {
      result = { ok: false, error: { code: "RUNTIME_VERIFIER_UNAVAILABLE" } };
    }
    if (result?.ok) return sanitizeVerificationResult(result);
    return { ok: false, error: normalizePublicError(result?.error) };
  }

  async activateProfile(profileId, options = {}) {
    assertPayloadSize(options);
    const id = requireProfileId(profileId);
    const profile = requireProfile(this.profileStore, id);
    assertVerified(profile);
    if (requiresStrictDynamicCatalog(profile)) {
      const catalog = await this.catalog.list(profile, await this.#readSecrets(id), { reason: "activation", forceRefresh: true });
      if (catalog?.stale || !Array.isArray(catalog?.models) || !catalog.models.some((model) => (
        normalizeText(model?.id) === profile.modelId
        && (profile.runtimeId !== "opencode" || normalizeText(model?.providerId) === profile.providerId)
      ))) {
        throw serviceError("MODEL_NOT_IN_LIVE_CATALOG", "The selected model is not present in the live catalog.");
      }
    }
    const isRunning = ["running", "quiet", "starting", "switching"].includes(this.supervisor?.phase)
      || ["running", "quiet"].includes(this.supervisor?.desiredState);
    if (isRunning && this.profileStore.getActive?.()) {
      await this.supervisor.switchProfile(id, { graceMs: options.graceMs });
    } else {
      this.profileStore.activate(id);
    }
    return {
      ok: true,
      activeProfileId: this.profileStore.getActive?.()?.id || id,
      runtime: typeof this.supervisor?.snapshot === "function" ? this.supervisor.snapshot() : null,
    };
  }

  async deleteProfile(profileId) {
    const id = requireProfileId(profileId);
    requireProfile(this.profileStore, id);
    const activeId = this.profileStore.getActive?.()?.id || "";
    if (activeId === id && (this.supervisor?.desiredState !== "stopped" || this.supervisor?.phase !== "stopped")) {
      throw serviceError("ACTIVE_PROFILE_DELETE_BLOCKED", "Stop CyberBoss or activate another verified profile before deleting the active profile.");
    }
    const vaultResult = typeof this.credentialVault.delete === "function" ? await this.credentialVault.delete(id) : null;
    const deleted = this.profileStore.delete(id);
    this.catalog.invalidate?.(id);
    return { ok: Boolean(deleted), generation: vaultResult?.generation || 0 };
  }

  async setDiagnosticCapture(input = {}) {
    assertPayloadSize(input);
    if (!this.diagnosticCapture) throw serviceError("DIAGNOSTIC_CAPTURE_UNAVAILABLE", "Diagnostic capture is unavailable.");
    if (input.action === "enable") {
      if (input.consent !== true) throw serviceError("DIAGNOSTIC_CAPTURE_CONSENT_REQUIRED", "Explicit consent is required.");
      return this.diagnosticCapture.enable({ scope: normalizeText(input.scope) || "connection-test", durationMs: Number(input.durationMs) });
    }
    if (input.action === "disable") return { disabled: await this.diagnosticCapture.disable() };
    if (input.action === "delete") return { deleted: await this.diagnosticCapture.delete?.() };
    throw serviceError("INVALID_DIAGNOSTIC_CAPTURE_ACTION", "Diagnostic capture action is invalid.");
  }

  async #readSecrets(profileId) {
    if (typeof this.credentialVault.read !== "function") return {};
    return await this.credentialVault.read(profileId) || {};
  }
}

function registerModelSettingsIpc({ ipcMain, service, getMainWindow, rendererUrl, onMutation = () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new TypeError("ipcMain.handle is required.");
  const expectedUrl = normalizeRendererUrl(rendererUrl);
  const routes = {
    "desktop:list-runtime-options": () => service.listRuntimeOptions(),
    "desktop:list-profiles": () => service.listProfiles(),
    "desktop:save-profile": (_event, input) => mutate(service.saveProfile(input)),
    "desktop:write-profile-secrets": (_event, id, input) => mutate(service.writeProfileSecrets(id, input)),
    "desktop:refresh-models": (_event, id, options) => service.refreshModels(id, options),
    "desktop:test-profile": (_event, id) => mutate(service.testProfile(id)),
    "desktop:activate-profile": (_event, id, options) => mutate(service.activateProfile(id, options)),
    "desktop:delete-profile": (_event, id) => mutate(service.deleteProfile(id)),
    "desktop:set-diagnostic-capture": (_event, input) => mutate(service.setDiagnosticCapture(input)),
  };
  for (const channel of MODEL_IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcEvent(event, { mainWindow: getMainWindow?.(), rendererUrl: expectedUrl });
      assertPayloadSize(args);
      return routes[channel](event, ...args);
    });
  }
  return MODEL_IPC_CHANNELS;

  async function mutate(operation) {
    const result = await operation;
    await onMutation();
    return result;
  }
}

function assertTrustedIpcEvent(event, { mainWindow, rendererUrl } = {}) {
  if (!mainWindow?.webContents || event?.sender !== mainWindow.webContents) {
    throw serviceError("IPC_SENDER_REJECTED", "IPC sender is not the CyberBoss window.");
  }
  if (!event.senderFrame || event.senderFrame.top !== event.senderFrame) {
    throw serviceError("IPC_FRAME_REJECTED", "IPC calls are allowed only from the top-level frame.");
  }
  if (!rendererUrl || event.senderFrame.url !== rendererUrl) {
    throw serviceError("IPC_ORIGIN_REJECTED", "IPC origin is not the CyberBoss renderer.");
  }
}

function buildEngineSnapshot({ activeProfile, runtime } = {}) {
  const verified = activeProfile?.status === "verified"
    && Boolean(activeProfile.verifiedFingerprint)
    && activeProfile.verifiedFingerprint === computeVerificationFingerprint(activeProfile);
  const masked = verified ? sanitizeProfileSnapshot(activeProfile) : null;
  return {
    configurationRequired: !masked,
    canRun: Boolean(masked) && runtime?.phase !== "switching",
    activeProfile: masked,
  };
}

function validateProfileInput(input, existing) {
  if (!isRecord(input)) throw serviceError("INVALID_PROFILE", "A profile object is required.");
  const runtimeId = getRuntimeDefinition(input.runtimeId ?? existing?.runtimeId).id;
  const providerId = normalizeText(input.providerId ?? existing?.providerId).toLowerCase();
  const ownershipMode = normalizeText(input.ownershipMode ?? existing?.ownershipMode).toLowerCase();
  const modelId = normalizeLimitedText(input.modelId ?? existing?.modelId, MAX_MODEL_ID_LENGTH, "MODEL_ID_TOO_LONG");
  const baseUrl = normalizeLimitedText(input.baseUrl ?? existing?.baseUrl, MAX_BASE_URL_LENGTH, "BASE_URL_TOO_LONG");
  const name = normalizeLimitedText(input.name ?? existing?.name, MAX_PROFILE_NAME_LENGTH, "PROFILE_NAME_TOO_LONG") || "未命名配置";
  let protocolId = normalizeText(input.protocolId ?? existing?.protocolId).toLowerCase();
  if (runtimeId === "builtin-api") {
    const preset = getProviderPreset(providerId);
    if (!preset) throw serviceError("UNKNOWN_PROVIDER", "The provider preset is not registered.");
    protocolId = preset.protocol;
  } else if (runtimeId === "opencode") {
    if (!new Set(["managed-local", "external"]).has(ownershipMode)) throw serviceError("INVALID_OWNERSHIP_MODE", "OpenCode ownership mode is required.");
    if (!providerId) throw serviceError("INVALID_PROVIDER", "An OpenCode provider is required.");
  } else if (providerId !== "compatibility") {
    throw serviceError("INVALID_PROVIDER", "Compatibility runtimes use the compatibility provider.");
  }
  if (!modelId) throw serviceError("MODEL_ID_REQUIRED", "A model ID is required.");
  if (baseUrl) validateBaseUrl(baseUrl, { externalOpenCode: runtimeId === "opencode" && ownershipMode === "external" });
  if (runtimeId === "opencode" && ownershipMode === "external" && !baseUrl) throw serviceError("BASE_URL_REQUIRED", "External OpenCode requires a service endpoint.");
  const options = sanitizeOptions(input.options ?? existing?.options);
  return {
    ...(existing ? { id: existing.id } : {}),
    name, runtimeId, ownershipMode, providerId, protocolId, baseUrl, options, modelId,
    modelVariant: normalizeLimitedText(input.modelVariant ?? existing?.modelVariant, 120, "MODEL_VARIANT_TOO_LONG"),
    visionProfileId: normalizeLimitedText(input.visionProfileId ?? existing?.visionProfileId, 120, "VISION_PROFILE_ID_TOO_LONG"),
  };
}

function validateSecrets(input) {
  if (!isRecord(input)) throw serviceError("INVALID_SECRETS", "A secret payload is required.");
  const apiKey = secretText(input.apiKey, "API_KEY_TOO_LARGE");
  const servicePassword = secretText(input.servicePassword, "SERVICE_PASSWORD_TOO_LARGE");
  const sourceHeaders = input.sensitiveHeaders === undefined ? {} : input.sensitiveHeaders;
  if (!isRecord(sourceHeaders) || Object.keys(sourceHeaders).length > MAX_HEADER_COUNT) {
    throw serviceError("INVALID_SENSITIVE_HEADER", "Sensitive headers are invalid or exceed the limit.");
  }
  const sensitiveHeaders = {};
  for (const [rawName, rawValue] of Object.entries(sourceHeaders)) {
    const name = normalizeText(rawName).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || FORBIDDEN_CUSTOM_HEADERS.has(name)) {
      throw serviceError("INVALID_SENSITIVE_HEADER", "A sensitive header name is not allowed.");
    }
    sensitiveHeaders[name] = secretText(rawValue, "SENSITIVE_HEADER_TOO_LARGE");
  }
  return { ...(apiKey ? { apiKey } : {}), ...(servicePassword ? { servicePassword } : {}), ...(Object.keys(sensitiveHeaders).length ? { sensitiveHeaders } : {}) };
}

function validateBaseUrl(value, { externalOpenCode = false } = {}) {
  let parsed;
  try { parsed = new URL(value); } catch { throw serviceError("INVALID_BASE_URL", "Base URL is invalid."); }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw serviceError("INVALID_BASE_URL", "Base URL must be HTTP(S) and contain no credentials, query, or fragment.");
  }
  if (externalOpenCode && parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw serviceError("INSECURE_EXTERNAL_OPENCODE_URL", "External OpenCode must use loopback HTTP or HTTPS.");
  }
}

function sanitizeOptions(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) continue;
    if (/authorization|api.?key|password|secret|token|header/i.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof item) || item === null) result[key] = typeof item === "string" ? item.slice(0, 2_048) : item;
  }
  return result;
}

function sanitizeProfileSnapshot(profile) {
  if (!isRecord(profile)) return null;
  const { secretRefs, ciphertext, ...safe } = profile;
  return {
    ...safe,
    options: sanitizeOptions(safe.options),
    hasApiKey: profile.hasApiKey === true || Boolean(secretRefs?.apiKey),
    hasServicePassword: profile.hasServicePassword === true || Boolean(secretRefs?.servicePassword),
    hasSensitiveHeaders: profile.hasSensitiveHeaders === true || Boolean(Object.keys(secretRefs?.sensitiveHeaders || {}).length),
  };
}

function sanitizeCatalog(value) {
  return {
    models: Array.isArray(value?.models) ? value.models.slice(0, 10_000).map((model) => ({
      id: normalizeLimitedText(model?.id, MAX_MODEL_ID_LENGTH, "MODEL_ID_TOO_LONG"),
      name: normalizeLimitedText(model?.name || model?.label, 512, "MODEL_NAME_TOO_LONG"),
      label: normalizeLimitedText(model?.label || model?.name || model?.id, 512, "MODEL_NAME_TOO_LONG"),
      providerId: normalizeLimitedText(model?.providerId, 120, "PROVIDER_ID_TOO_LONG"),
      inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.map((item) => normalizeText(item)).filter(Boolean).slice(0, 8) : [],
      contextWindow: Number.isSafeInteger(model?.contextWindow) ? model.contextWindow : null,
    })).filter((model) => model.id) : [],
    source: normalizeText(value?.source),
    refreshedAt: normalizeText(value?.refreshedAt),
    cached: value?.cached === true,
    stale: value?.stale === true,
  };
}

function sanitizeVerificationResult(result) {
  return {
    ok: true,
    capabilities: isRecord(result?.capabilities) ? { ...result.capabilities } : {},
    verifiedAt: normalizeText(result?.verifiedAt),
  };
}

function normalizePublicError(error) {
  const code = normalizeText(error?.code).toUpperCase() || "CONNECTION_TEST_FAILED";
  const mapped = ERROR_GUIDANCE[code] || guidance("connection", "连接测试未通过。", "检查配置后再次测试；如仍失败，请打开诊断查看稳定错误码。" );
  return { code, ...mapped };
}

function assertVerified(profile) {
  const matches = profile.status === "verified"
    && profile.verifiedFingerprint
    && profile.verifiedFingerprint === computeVerificationFingerprint(profile);
  if (!matches) {
    throw serviceError("PROFILE_NOT_VERIFIED", "The profile must pass a live connection test before activation.");
  }
}

function requiresStrictDynamicCatalog(profile) {
  return profile.providerId === "openrouter" || profile.runtimeId === "opencode";
}

function secretFlags(secretRefs) {
  return {
    hasApiKey: Boolean(secretRefs.apiKey),
    hasServicePassword: Boolean(secretRefs.servicePassword),
    hasSensitiveHeaders: Object.keys(secretRefs.sensitiveHeaders || {}).length > 0,
  };
}

function assertPayloadSize(value) {
  let json;
  try { json = JSON.stringify(value); } catch { throw serviceError("IPC_PAYLOAD_INVALID", "IPC payload must be JSON serializable."); }
  if (Buffer.byteLength(json ?? "", "utf8") > MAX_IPC_PAYLOAD_BYTES) throw serviceError("IPC_PAYLOAD_TOO_LARGE", "IPC payload exceeds the allowed size.");
}

function normalizeRendererUrl(value) {
  if (value instanceof URL) return value.href;
  const text = normalizeText(value);
  if (!text) return "";
  if (/^[a-z]+:/i.test(text)) return new URL(text).href;
  return pathToFileURL(text).href;
}

function requireProfile(store, id) {
  const profile = store.get(id);
  if (!profile) throw serviceError("PROFILE_NOT_FOUND", "Provider profile was not found.");
  return profile;
}

function requireProfileId(value) {
  const id = normalizeText(value);
  if (!id || id.length > 120) throw serviceError("INVALID_PROFILE_ID", "A valid profile ID is required.");
  return id;
}

function secretText(value, code) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) throw serviceError(code, "Secret value exceeds the allowed size.");
  return value.trim();
}

function normalizeLimitedText(value, maxLength, code) {
  const text = normalizeText(value);
  if (text.length > maxLength) throw serviceError(code, "Text value exceeds the allowed size.");
  return text;
}

function isLoopback(value) {
  const hostname = normalizeText(value).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function guidance(category, summary, repairAction) { return Object.freeze({ category, summary, repairAction }); }
function serviceError(code, message) { return Object.assign(new Error(message), { code }); }
function requireMethod(value, method, label) { if (!value || typeof value[method] !== "function") throw new TypeError(`ModelSettingsService requires a ${label}.`); }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

module.exports = {
  ERROR_GUIDANCE,
  MAX_IPC_PAYLOAD_BYTES,
  MODEL_IPC_CHANNELS,
  ModelSettingsService,
  assertTrustedIpcEvent,
  buildEngineSnapshot,
  normalizePublicError,
  registerModelSettingsIpc,
};
