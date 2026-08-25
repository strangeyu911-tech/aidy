"use strict";

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_PAGE_SIZE = 500;
const MAX_CATALOG_PAGES = 1_000;
const FORCE_REFRESH_REASONS = new Set([
  "connection",
  "endpoint-change",
  "manual-refresh",
  "provider-auth-change",
  "verification",
  "version-change",
]);
const LIVE_ONLY_REASONS = new Set([
  "activation",
  "connection",
  "endpoint-change",
  "manual-refresh",
  "provider-auth-change",
  "verification",
  "version-change",
]);

const PROVIDER_PRESETS = freezePresets({
  openai: {
    displayName: "OpenAI / ChatGPT API",
    protocol: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    authentication: "bearer-api-key",
    discovery: "openai-models",
    helpText: "Uses an OpenAI API key; a ChatGPT subscription is not assumed.",
  },
  openrouter: {
    displayName: "OpenRouter",
    protocol: "openai-chat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    authentication: "bearer-api-key",
    discovery: "openrouter-models",
    helpText: "Loads the searchable OpenRouter model catalog dynamically.",
  },
  anthropic: {
    displayName: "Anthropic Claude",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    requiresApiKey: true,
    authentication: "anthropic-api-key",
    discovery: "anthropic-models",
    helpText: "Uses the Anthropic Messages API and model catalog.",
  },
  gemini: {
    displayName: "Google Gemini",
    protocol: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requiresApiKey: true,
    authentication: "google-api-key",
    discovery: "gemini-models",
    helpText: "Uses the Gemini generateContent API and model catalog.",
  },
  ollama: {
    displayName: "Ollama",
    protocol: "ollama",
    defaultBaseUrl: "http://127.0.0.1:11434",
    requiresApiKey: false,
    authentication: "none",
    discovery: "ollama-models",
    helpText: "Connects to a local Ollama service.",
  },
  deepseek: compatiblePreset("DeepSeek", "https://api.deepseek.com/v1"),
  kimi: compatiblePreset("Kimi", "https://api.moonshot.cn/v1"),
  glm: compatiblePreset("GLM", "https://open.bigmodel.cn/api/paas/v4"),
  minimax: compatiblePreset("MiniMax", ""),
  hunyuan: compatiblePreset("Tencent Hunyuan (混元)", ""),
  mimo: compatiblePreset("Xiaomi MiMo", ""),
  qwen: compatiblePreset("Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
  "custom-openai": {
    ...compatiblePreset("Generic OpenAI-compatible", ""),
    requiresApiKey: false,
    helpText: "Requires an explicit base URL and model ID; an API key is optional.",
  },
});

class ProviderCatalog {
  constructor({
    fetch: fetchImplementation = globalThis.fetch,
    fetchModels,
    now = Date.now,
    ttlMs = DEFAULT_CACHE_TTL_MS,
    pageSize = DEFAULT_PAGE_SIZE,
  } = {}) {
    if (fetchModels !== undefined && typeof fetchModels !== "function") {
      throw new TypeError("ProviderCatalog fetchModels must be a function.");
    }
    if (typeof fetchImplementation !== "function" && !fetchModels) {
      throw new TypeError("ProviderCatalog requires fetch or fetchModels.");
    }
    this.fetch = fetchImplementation;
    this.fetchModels = fetchModels || null;
    this.now = now;
    this.ttlMs = normalizePositiveInteger(ttlMs, DEFAULT_CACHE_TTL_MS);
    this.pageSize = Math.min(1_000, normalizePositiveInteger(pageSize, DEFAULT_PAGE_SIZE));
    this.cache = new Map();
  }

  async list(profile, secrets = {}, options = {}) {
    const normalizedProfile = normalizeProfile(profile);
    const normalizedOptions = normalizeOptions(options);
    const preset = getProviderPreset(normalizedProfile.providerId);
    if (!preset && normalizedProfile.runtimeId !== "opencode") {
      throw catalogError("UNKNOWN_PROVIDER", "The provider preset is not registered.");
    }

    const cacheKey = buildCacheKey(normalizedProfile, normalizedOptions);
    const cachedEntry = this.cache.get(cacheKey) || null;
    const nowMs = normalizeTimestamp(this.now());
    const fresh = cachedEntry && nowMs - cachedEntry.refreshedAtMs < this.ttlMs;
    const forceRefresh = shouldForceRefresh(normalizedProfile, normalizedOptions);
    if (fresh && !forceRefresh) return catalogSnapshot(cachedEntry, { cached: true, stale: false });

    try {
      const rawResult = this.fetchModels
        ? await this.fetchModels({
          profile: { ...normalizedProfile },
          secrets,
          options: { ...normalizedOptions },
          preset,
        })
        : await this.fetchProviderModels(normalizedProfile, secrets, preset);
      const unpacked = unpackCatalogResult(rawResult);
      let models = normalizeModels(unpacked.models, normalizedProfile.providerId);
      let source = normalizeText(unpacked.source) || catalogSource(normalizedProfile);
      if (!models.length && canUseManualFallback(normalizedProfile)) {
        models = normalizeModels([{ id: normalizedProfile.modelId }], normalizedProfile.providerId);
        source = "manual";
      }
      const refreshedAtMs = nowMs;
      const entry = {
        profileId: normalizedProfile.id,
        models,
        source,
        refreshedAt: new Date(refreshedAtMs).toISOString(),
        refreshedAtMs,
      };
      this.cache.set(cacheKey, entry);
      return catalogSnapshot(entry, { cached: false, stale: false });
    } catch (error) {
      const mapped = normalizeCatalogError(error);
      if (cachedEntry && !requiresLiveResult(normalizedProfile, normalizedOptions)) {
        return catalogSnapshot(cachedEntry, { cached: true, stale: true });
      }
      throw mapped;
    }
  }

  invalidate(profileId) {
    const normalizedProfileId = normalizeText(profileId);
    if (!normalizedProfileId) return 0;
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (entry.profileId !== normalizedProfileId) continue;
      this.cache.delete(key);
      removed += 1;
    }
    return removed;
  }

  search(models, query) {
    return search(models, query);
  }

  async fetchProviderModels(profile, secrets, preset) {
    switch (preset.discovery) {
      case "openrouter-models":
        return this.fetchOpenRouterModels(profile, secrets);
      case "anthropic-models":
        return this.fetchAnthropicModels(profile, secrets);
      case "gemini-models":
        return this.fetchGeminiModels(profile, secrets);
      case "ollama-models":
        return this.fetchOllamaModels(profile);
      case "openai-models":
        return this.fetchOpenAiCompatibleModels(profile, secrets);
      default:
        return [];
    }
  }

  async fetchOpenRouterModels(profile, secrets) {
    const models = [];
    let offset = 0;
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const url = new URL(joinEndpoint(resolveBaseUrl(profile, getProviderPreset("openrouter")), "models"));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(this.pageSize));
      const response = await this.requestJson(url.toString(), {
        headers: bearerHeaders(secrets),
      });
      if (!Array.isArray(response.data)) throw incompatibleCatalog();
      const totalCount = normalizeNonNegativeInteger(response.total_count);
      if (response.data.length === 0 && totalCount !== null && offset < totalCount) throw incompatibleCatalog();
      models.push(...response.data);
      offset += response.data.length;
      if (totalCount !== null ? offset >= totalCount : response.data.length < this.pageSize) return models;
      if (response.data.length === 0) throw incompatibleCatalog();
    }
    throw catalogError("INCOMPATIBLE_PROTOCOL", "The model catalog exceeded its pagination limit.");
  }

  async fetchOpenAiCompatibleModels(profile, secrets) {
    const body = await this.requestJson(joinEndpoint(resolveBaseUrl(profile, getProviderPreset(profile.providerId)), "models"), {
      headers: bearerHeaders(secrets),
    });
    if (!Array.isArray(body.data)) throw incompatibleCatalog();
    return body.data;
  }

  async fetchAnthropicModels(profile, secrets) {
    const models = [];
    let afterId = "";
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const url = new URL(joinEndpoint(resolveBaseUrl(profile, getProviderPreset("anthropic")), "v1/models"));
      url.searchParams.set("limit", String(Math.min(this.pageSize, 1_000)));
      if (afterId) url.searchParams.set("after_id", afterId);
      const body = await this.requestJson(url.toString(), {
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": normalizeText(secrets?.apiKey),
        },
      });
      if (!Array.isArray(body.data)) throw incompatibleCatalog();
      models.push(...body.data);
      if (!body.has_more) return models;
      const nextId = normalizeText(body.last_id) || normalizeText(body.data.at(-1)?.id);
      if (!nextId || nextId === afterId) throw incompatibleCatalog();
      afterId = nextId;
    }
    throw catalogError("INCOMPATIBLE_PROTOCOL", "The model catalog exceeded its pagination limit.");
  }

  async fetchGeminiModels(profile, secrets) {
    const models = [];
    let pageToken = "";
    for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
      const url = new URL(joinEndpoint(resolveBaseUrl(profile, getProviderPreset("gemini")), "models"));
      url.searchParams.set("pageSize", String(Math.min(this.pageSize, 1_000)));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.requestJson(url.toString(), {
        headers: { "x-goog-api-key": normalizeText(secrets?.apiKey) },
      });
      if (!Array.isArray(body.models)) throw incompatibleCatalog();
      models.push(...body.models.map((model) => ({
        ...model,
        id: normalizeText(model?.name).replace(/^models\//, ""),
        name: normalizeText(model?.displayName) || normalizeText(model?.name).replace(/^models\//, ""),
        inputModalities: model?.inputModalities || model?.supportedGenerationMethods,
      })));
      const nextPageToken = normalizeText(body.nextPageToken);
      if (!nextPageToken) return models;
      if (nextPageToken === pageToken) throw incompatibleCatalog();
      pageToken = nextPageToken;
    }
    throw catalogError("INCOMPATIBLE_PROTOCOL", "The model catalog exceeded its pagination limit.");
  }

  async fetchOllamaModels(profile) {
    const body = await this.requestJson(joinEndpoint(resolveBaseUrl(profile, getProviderPreset("ollama")), "api/tags"));
    if (!Array.isArray(body.models)) throw incompatibleCatalog();
    return body.models.map((model) => ({ ...model, id: model?.model || model?.name }));
  }

  async requestJson(url, init = {}) {
    let response;
    try {
      response = await this.fetch(url, { method: "GET", ...init });
    } catch (error) {
      throw normalizeCatalogError(error);
    }
    if (!response || typeof response !== "object") throw incompatibleCatalog();
    if (!response.ok) throw await httpCatalogError(response);
    if (typeof response.json !== "function") throw incompatibleCatalog();
    try {
      return await response.json();
    } catch {
      throw incompatibleCatalog();
    }
  }
}

function compatiblePreset(displayName, defaultBaseUrl) {
  return {
    displayName,
    protocol: "openai-chat",
    defaultBaseUrl,
    requiresApiKey: true,
    authentication: "bearer-api-key",
    discovery: "openai-models",
    helpText: defaultBaseUrl
      ? "Uses the provider's OpenAI-compatible API."
      : "Requires the account- and region-specific OpenAI-compatible base URL.",
  };
}

function freezePresets(presets) {
  return Object.freeze(Object.fromEntries(
    Object.entries(presets).map(([id, preset]) => [id, Object.freeze({ id, ...preset })]),
  ));
}

function getProviderPreset(id) {
  return PROVIDER_PRESETS[normalizeText(id).toLowerCase()] || null;
}

function normalizeProfile(profile) {
  if (!isRecord(profile)) throw catalogError("INVALID_PROFILE", "A provider profile is required.");
  const normalized = {
    id: normalizeText(profile.id),
    runtimeId: normalizeText(profile.runtimeId).toLowerCase(),
    ownershipMode: normalizeText(profile.ownershipMode).toLowerCase(),
    providerId: normalizeText(profile.providerId).toLowerCase(),
    baseUrl: normalizeText(profile.baseUrl),
    modelId: normalizeText(profile.modelId),
    options: isRecord(profile.options) ? { ...profile.options } : {},
  };
  if (!normalized.id || !normalized.runtimeId || !normalized.providerId) {
    throw catalogError("INVALID_PROFILE", "The provider profile is incomplete.");
  }
  return normalized;
}

function normalizeOptions(options) {
  const source = isRecord(options) ? options : {};
  return {
    reason: normalizeText(source.reason).toLowerCase(),
    forceRefresh: source.forceRefresh === true,
    reportedVersion: normalizeText(source.reportedVersion),
    connectedProviderFingerprint: normalizeText(source.connectedProviderFingerprint),
  };
}

function shouldForceRefresh(profile, options) {
  if (options.forceRefresh || FORCE_REFRESH_REASONS.has(options.reason)) return true;
  return profile.runtimeId === "opencode"
    && profile.ownershipMode === "external"
    && options.reason === "activation";
}

function requiresLiveResult(profile, options) {
  if (options.forceRefresh || LIVE_ONLY_REASONS.has(options.reason)) return true;
  return profile.runtimeId === "opencode"
    && profile.ownershipMode === "external"
    && options.reason === "activation";
}

function buildCacheKey(profile, options) {
  const preset = getProviderPreset(profile.providerId);
  const endpoint = normalizeEndpoint(profile.baseUrl || preset?.defaultBaseUrl || "");
  return JSON.stringify([
    profile.id,
    profile.runtimeId,
    profile.ownershipMode,
    profile.providerId,
    endpoint,
    options.reportedVersion,
    options.connectedProviderFingerprint,
  ]);
}

function normalizeModels(models, fallbackProviderId) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of Array.isArray(models) ? models : []) {
    const model = normalizeModel(candidate, fallbackProviderId);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    normalized.push(model);
  }
  return normalized;
}

function normalizeModel(candidate, fallbackProviderId) {
  const source = typeof candidate === "string" ? { id: candidate } : candidate;
  if (!isRecord(source)) return null;
  const id = normalizeText(source.id || source.model || source.slug);
  if (!id) return null;
  const modalities = source.inputModalities
    || source.input_modalities
    || source.architecture?.input_modalities
    || source.modalities?.input;
  const inputModalities = [...new Set(
    (Array.isArray(modalities) ? modalities : [])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  )];
  const contextWindow = normalizePositiveIntegerOrNull(
    source.contextWindow
      ?? source.context_window
      ?? source.context_length
      ?? source.top_provider?.context_length,
  );
  return {
    id,
    name: normalizeText(source.name || source.displayName) || id,
    providerId: normalizeText(source.providerId || source.provider_id).toLowerCase() || fallbackProviderId,
    inputModalities,
    contextWindow,
  };
}

function search(models, query) {
  const needle = normalizeText(query).toLocaleLowerCase();
  const normalized = normalizeModels(models, "");
  if (!needle) return normalized;
  return normalized.filter((model) => [model.id, model.name, model.providerId]
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}

function unpackCatalogResult(value) {
  if (Array.isArray(value)) return { models: value, source: "" };
  if (isRecord(value) && Array.isArray(value.models)) return value;
  throw incompatibleCatalog();
}

function catalogSource(profile) {
  return profile.runtimeId === "opencode" ? "opencode" : profile.providerId;
}

function canUseManualFallback(profile) {
  return Boolean(profile.modelId)
    && profile.runtimeId !== "opencode"
    && profile.providerId !== "openrouter";
}

function catalogSnapshot(entry, { cached, stale }) {
  return {
    models: entry.models.map((model) => ({ ...model, inputModalities: [...model.inputModalities] })),
    source: entry.source,
    refreshedAt: entry.refreshedAt,
    cached,
    stale,
  };
}

function resolveBaseUrl(profile, preset) {
  const baseUrl = profile.baseUrl || preset?.defaultBaseUrl || "";
  if (!baseUrl) throw catalogError("BASE_URL_REQUIRED", "This provider requires an explicit base URL.");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw catalogError("INVALID_BASE_URL", "The provider base URL is invalid.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw catalogError("INVALID_BASE_URL", "The provider base URL must be HTTP(S) and contain no credentials.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function joinEndpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, "")}/${String(suffix).replace(/^\//, "")}`;
}

function bearerHeaders(secrets) {
  const apiKey = normalizeText(secrets?.apiKey);
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function httpCatalogError(response) {
  const status = Number(response.status) || 0;
  let body = null;
  try {
    body = typeof response.json === "function" ? await response.json() : null;
  } catch {
    body = null;
  }
  const providerType = normalizeText(
    body?.error_type
      || body?.error?.error_type
      || body?.error?.metadata?.error_type,
  );
  const code = mapCatalogErrorCode(status, providerType);
  const error = catalogError(code, catalogErrorMessage(code));
  error.status = status;
  const retryAfter = Number.parseInt(readHeader(response.headers, "retry-after"), 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterSeconds = retryAfter;
  return error;
}

function mapCatalogErrorCode(status, providerType) {
  switch (providerType) {
    case "authentication": return "INVALID_CREDENTIALS";
    case "permission_denied": return "INVALID_CREDENTIALS";
    case "payment_required": return "QUOTA_EXHAUSTED";
    case "rate_limit_exceeded": return "RATE_LIMITED";
    case "not_found": return "MODEL_UNAVAILABLE";
    case "timeout": return "MODEL_SERVICE_TIMEOUT";
    case "provider_overloaded":
    case "provider_unavailable":
    case "server": return "MODEL_SERVICE_UNAVAILABLE";
    default: break;
  }
  if (status === 401 || status === 403) return "INVALID_CREDENTIALS";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 408 || status === 504) return "MODEL_SERVICE_TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "MODEL_SERVICE_UNAVAILABLE";
  if (status >= 400) return "INVALID_REQUEST";
  return "INCOMPATIBLE_PROTOCOL";
}

function normalizeCatalogError(error) {
  if (error?.code && typeof error.code === "string") return error;
  if (error?.name === "AbortError") return catalogError("CANCELLED", "Model catalog refresh was cancelled.");
  return catalogError("MODEL_SERVICE_UNAVAILABLE", "The model catalog could not be refreshed.");
}

function catalogErrorMessage(code) {
  const messages = {
    INVALID_CREDENTIALS: "The provider credentials were rejected.",
    QUOTA_EXHAUSTED: "The provider account has insufficient quota or credits.",
    RATE_LIMITED: "The provider rate-limited the model catalog request.",
    MODEL_UNAVAILABLE: "The provider model catalog endpoint is unavailable.",
    MODEL_SERVICE_TIMEOUT: "The model catalog request timed out.",
    MODEL_SERVICE_UNAVAILABLE: "The model service is unavailable.",
    INVALID_REQUEST: "The provider rejected the model catalog request.",
    INCOMPATIBLE_PROTOCOL: "The provider returned an incompatible model catalog.",
  };
  return messages[code] || "The model catalog request failed.";
}

function incompatibleCatalog() {
  return catalogError("INCOMPATIBLE_PROTOCOL", "The provider returned an incompatible model catalog.");
}

function catalogError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readHeader(headers, name) {
  if (headers && typeof headers.get === "function") return normalizeText(headers.get(name));
  if (!isRecord(headers)) return "";
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return matchingKey ? normalizeText(headers[matchingKey]) : "";
}

function normalizeEndpoint(value) {
  const text = normalizeText(value);
  if (!text) return "";
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return text.replace(/\/$/, "");
  }
}

function normalizeTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  PROVIDER_PRESETS,
  ProviderCatalog,
  getProviderPreset,
  search,
};
