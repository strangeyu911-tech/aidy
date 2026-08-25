"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROVIDER_PRESETS,
  ProviderCatalog,
  getProviderPreset,
} = require("../src/services/provider-catalog");

const NAMED_OPENAI_COMPATIBLE = [
  "deepseek",
  "kimi",
  "glm",
  "minimax",
  "hunyuan",
  "mimo",
  "qwen",
  "custom-openai",
];

function builtinProfile(overrides = {}) {
  return {
    id: "profile-1",
    runtimeId: "builtin-api",
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelId: "openai/gpt-5",
    ...overrides,
  };
}

function externalProfile(overrides = {}) {
  return {
    id: "external-1",
    runtimeId: "opencode",
    ownershipMode: "external",
    providerId: "openrouter",
    baseUrl: "http://127.0.0.1:4096",
    modelId: "openai/gpt-5",
    ...overrides,
  };
}

function makeClock() {
  let value = Date.parse("2026-08-25T01:00:00.000Z");
  return {
    now: () => value,
    advance: (milliseconds) => { value += milliseconds; },
  };
}

test("all approved direct API providers resolve to explicit protocols and presets", () => {
  assert.equal(getProviderPreset("openai").protocol, "openai-responses");
  assert.equal(getProviderPreset("openrouter").protocol, "openai-chat");
  assert.equal(getProviderPreset("anthropic").protocol, "anthropic-messages");
  assert.equal(getProviderPreset("gemini").protocol, "gemini");
  assert.equal(getProviderPreset("ollama").protocol, "ollama");
  for (const id of NAMED_OPENAI_COMPATIBLE) {
    assert.equal(getProviderPreset(id).protocol, "openai-chat");
  }
  assert.equal(Object.keys(PROVIDER_PRESETS).length, 13);
  assert.equal(Object.hasOwn(PROVIDER_PRESETS, "codex"), false);
  assert.equal(getProviderPreset("unknown"), null);
});

test("provider defaults are explicit and region-dependent providers require a base URL", () => {
  assert.equal(getProviderPreset("openai").defaultBaseUrl, "https://api.openai.com/v1");
  assert.equal(getProviderPreset("openrouter").defaultBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(getProviderPreset("minimax").defaultBaseUrl, "");
  assert.equal(getProviderPreset("hunyuan").defaultBaseUrl, "");
  assert.equal(getProviderPreset("mimo").defaultBaseUrl, "");
  assert.equal(getProviderPreset("custom-openai").defaultBaseUrl, "");
});

test("catalog normalizes, deduplicates, and searches model records", async () => {
  const catalog = new ProviderCatalog({
    fetchModels: async () => [
      { id: "openai/gpt-5", name: "GPT 5", architecture: { input_modalities: ["text", "image"] }, context_length: 400_000 },
      { id: "openai/gpt-5", name: "duplicate" },
      { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet", inputModalities: ["text"], contextWindow: 200_000 },
      { id: "" },
    ],
  });

  const result = await catalog.list(builtinProfile(), { apiKey: "synthetic-secret" });
  assert.deepEqual(result.models, [
    { id: "openai/gpt-5", name: "GPT 5", providerId: "openrouter", inputModalities: ["text", "image"], contextWindow: 400_000 },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet", providerId: "openrouter", inputModalities: ["text"], contextWindow: 200_000 },
  ]);
  assert.deepEqual(catalog.search(result.models, "ClAuDe"), [result.models[1]]);
  assert.deepEqual(catalog.search(result.models, "openai/gpt"), [result.models[0]]);
});

test("manual model fallback remains available for providers without a catalog", async () => {
  const catalog = new ProviderCatalog({ fetchModels: async () => [] });
  const result = await catalog.list(builtinProfile({
    providerId: "custom-openai",
    baseUrl: "https://models.example.test/v1",
    modelId: "tenant-model-v2",
  }), { apiKey: "synthetic-secret" });

  assert.equal(result.source, "manual");
  assert.deepEqual(result.models, [{
    id: "tenant-model-v2",
    name: "tenant-model-v2",
    providerId: "custom-openai",
    inputModalities: [],
    contextWindow: null,
  }]);
});

test("fresh catalogs cache for ten minutes without putting credentials in cache identity", async () => {
  const clock = makeClock();
  const calls = [];
  const catalog = new ProviderCatalog({
    now: clock.now,
    fetchModels: async ({ secrets }) => {
      calls.push(secrets.apiKey);
      return [{ id: `model-${calls.length}` }];
    },
  });
  const profile = builtinProfile();
  const first = await catalog.list(profile, { apiKey: "first-secret" });
  clock.advance(9 * 60_000);
  const second = await catalog.list(profile, { apiKey: "rotated-secret" });

  assert.equal(calls.length, 1);
  assert.deepEqual(second.models, first.models);
  assert.equal(second.cached, true);
  assert.equal(JSON.stringify([...catalog.cache.keys()]).includes("first-secret"), false);
  assert.equal(JSON.stringify([...catalog.cache.keys()]).includes("rotated-secret"), false);
});

test("manual refresh, verification, endpoint changes, and managed auth changes bypass cache", async () => {
  const calls = [];
  const catalog = new ProviderCatalog({
    fetchModels: async () => [{ id: `m${calls.push("fetch")}` }],
  });
  const profile = builtinProfile();
  await catalog.list(profile, {});
  await catalog.list(profile, {}, { reason: "manual-refresh" });
  await catalog.list(profile, {}, { reason: "verification" });
  await catalog.list({ ...profile, baseUrl: "https://router.example.test/v1" }, {});
  await catalog.list({ ...profile, runtimeId: "opencode", ownershipMode: "managed" }, {}, { reason: "provider-auth-change" });
  assert.equal(calls.length, 5);
});

test("external opencode activation always bypasses cache", async () => {
  const calls = [];
  const catalog = new ProviderCatalog({
    fetchModels: async () => [{ id: `m${calls.push(Date.now())}` }],
  });
  await catalog.list(externalProfile(), {}, { reason: "activation" });
  await catalog.list(externalProfile(), {}, { reason: "activation" });
  assert.equal(calls.length, 2);
});

test("stale results are labeled for display but rejected for live operations", async () => {
  const clock = makeClock();
  let fail = false;
  const catalog = new ProviderCatalog({
    now: clock.now,
    fetchModels: async () => {
      if (fail) throw Object.assign(new Error("offline"), { code: "MODEL_SERVICE_UNAVAILABLE" });
      return [{ id: "available-model" }];
    },
  });
  const profile = builtinProfile();
  await catalog.list(profile, {});
  clock.advance(10 * 60_000 + 1);
  fail = true;

  const stale = await catalog.list(profile, {}, { reason: "display" });
  assert.equal(stale.stale, true);
  assert.equal(stale.cached, true);
  await assert.rejects(
    catalog.list(profile, {}, { reason: "activation" }),
    (error) => error.code === "MODEL_SERVICE_UNAVAILABLE",
  );
});

test("invalidate removes every cache variant for only the selected profile", async () => {
  let calls = 0;
  const catalog = new ProviderCatalog({ fetchModels: async () => [{ id: `m${++calls}` }] });
  await catalog.list(builtinProfile(), {});
  await catalog.list(builtinProfile({ baseUrl: "https://router.example.test/v1" }), {});
  await catalog.list(builtinProfile({ id: "profile-2" }), {});
  assert.equal(catalog.invalidate("profile-1"), 2);
  await catalog.list(builtinProfile({ id: "profile-2" }), {});
  assert.equal(calls, 3);
});

test("OpenRouter discovery paginates by offset and maps catalog errors", async () => {
  const requested = [];
  const responses = [
    { ok: true, status: 200, json: async () => ({ data: [{ id: "a" }, { id: "b" }], total_count: 3 }) },
    { ok: true, status: 200, json: async () => ({ data: [{ id: "c" }], total_count: 3 }) },
  ];
  const catalog = new ProviderCatalog({
    pageSize: 2,
    fetch: async (url, init) => {
      requested.push({ url, authorization: init.headers.Authorization });
      return responses.shift();
    },
  });
  const result = await catalog.list(builtinProfile(), { apiKey: "synthetic-key" }, { reason: "manual-refresh" });
  assert.deepEqual(result.models.map((model) => model.id), ["a", "b", "c"]);
  assert.match(requested[0].url, /offset=0/);
  assert.match(requested[0].url, /limit=2/);
  assert.match(requested[1].url, /offset=2/);
  assert.equal(requested[0].authorization, "Bearer synthetic-key");

  const failing = new ProviderCatalog({
    fetch: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name.toLowerCase() === "retry-after" ? "17" : null },
      json: async () => ({ error: { message: "slow down" } }),
    }),
  });
  await assert.rejects(
    failing.list(builtinProfile(), { apiKey: "synthetic-key" }, { reason: "manual-refresh" }),
    (error) => error.code === "RATE_LIMITED" && error.retryAfterSeconds === 17,
  );
});

test("OpenRouter HTTP failures use stable catalog error codes without exposing response details", async (t) => {
  const cases = [
    [401, "INVALID_CREDENTIALS"],
    [403, "INVALID_CREDENTIALS"],
    [402, "QUOTA_EXHAUSTED"],
    [404, "MODEL_UNAVAILABLE"],
    [408, "MODEL_SERVICE_TIMEOUT"],
    [429, "RATE_LIMITED"],
    [502, "MODEL_SERVICE_UNAVAILABLE"],
    [503, "MODEL_SERVICE_UNAVAILABLE"],
  ];
  for (const [status, expectedCode] of cases) {
    await t.test(String(status), async () => {
      const catalog = new ProviderCatalog({
        fetch: async () => ({
          ok: false,
          status,
          headers: { get: () => null },
          json: async () => ({ error: { message: "provider included synthetic-key in its detail" } }),
        }),
      });
      await assert.rejects(
        catalog.list(builtinProfile(), { apiKey: "synthetic-key" }, { reason: "manual-refresh" }),
        (error) => error.code === expectedCode && !error.message.includes("synthetic-key"),
      );
    });
  }
});

test("OpenRouter malformed pagination fails closed instead of looping", async () => {
  let calls = 0;
  const catalog = new ProviderCatalog({
    pageSize: 2,
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ data: [], total_count: 3 }) };
    },
  });
  await assert.rejects(
    catalog.list(builtinProfile(), { apiKey: "synthetic-key" }, { reason: "manual-refresh" }),
    (error) => error.code === "INCOMPATIBLE_PROTOCOL",
  );
  assert.equal(calls, 1);
});
