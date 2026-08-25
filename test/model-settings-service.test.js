"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ModelSettingsService,
  buildEngineSnapshot,
} = require("../src/desktop/model-settings-service");
const { ProviderProfileStore, computeVerificationFingerprint } = require("../src/core/provider-profile-store");
const { CredentialVault } = require("../src/security/credential-vault");

test("renderer profile snapshot contains flags but no secret material", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({
    secretRefs: { apiKey: "vault:p1:apiKey", servicePassword: "", sensitiveHeaders: { "x-private": "vault:p1:x-private" } },
  }));

  const profiles = await harness.service.listProfiles();
  const serialized = JSON.stringify(profiles);
  assert.equal(serialized.includes("sk-test-secret"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("vault:p1"), false);
  assert.equal(profiles[0].hasApiKey, true);
  assert.equal(profiles[0].hasSensitiveHeaders, true);
  assert.equal(profiles[0].hasServicePassword, false);
});

test("runtime options have no default and include the complete approved provider set", async () => {
  const options = await createHarness().service.listRuntimeOptions();
  assert.equal(options.defaultRuntimeId, "");
  assert.deepEqual(options.runtimes.map((item) => item.id), ["builtin-api", "opencode", "codex", "claudecode"]);
  for (const id of ["openai", "openrouter", "anthropic", "gemini", "ollama", "deepseek", "kimi", "glm", "minimax", "hunyuan", "mimo", "qwen", "custom-openai"]) {
    assert.equal(options.providers.some((item) => item.id === id), true, id);
  }
  assert.equal(options.runtimes.some((item) => item.isDefault), false);
});

test("service-generated profile and vault files exist and reopen through fresh stores", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-model-service-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const protector = {
    async protectText(text) { return Buffer.from(text, "utf8").toString("base64"); },
    async unprotectText(ciphertext) { return Buffer.from(ciphertext, "base64").toString("utf8"); },
  };
  const profileStore = new ProviderProfileStore({ stateDir });
  const credentialVault = new CredentialVault({ stateDir, protector });
  const service = new ModelSettingsService({
    profileStore,
    credentialVault,
    catalog: { list: async () => ({ models: [] }), invalidate() {} },
    verifier: { verify: async () => ({ ok: false, error: { code: "INVALID_CREDENTIALS" } }) },
  });
  const saved = await service.saveProfile({
    name: "Reopen test", runtimeId: "builtin-api", providerId: "deepseek",
    baseUrl: "https://api.deepseek.com/v1", modelId: "manual-model",
  });
  await service.writeProfileSecrets(saved.id, { apiKey: "sk-reopen-only-in-vault" });

  const profilePath = path.join(stateDir, "provider-profiles.json");
  const vaultPath = path.join(stateDir, "credential-vault.json");
  assert.equal(fs.existsSync(profilePath), true);
  assert.equal(fs.existsSync(vaultPath), true);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(profilePath, "utf8")));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(vaultPath, "utf8")));
  assert.equal(fs.readFileSync(profilePath, "utf8").includes("sk-reopen-only-in-vault"), false);

  const reopenedProfiles = new ProviderProfileStore({ stateDir });
  const reopenedVault = new CredentialVault({ stateDir, protector });
  assert.equal(reopenedProfiles.get(saved.id).status, "draft");
  assert.equal((await reopenedVault.read(saved.id)).apiKey, "sk-reopen-only-in-vault");
  assert.equal(JSON.stringify(reopenedProfiles.listMasked()).includes("sk-reopen-only-in-vault"), false);
});

test("saving validates registered choices, URLs, sizes, and sensitive headers", async () => {
  const harness = createHarness();
  await assert.rejects(harness.service.saveProfile({ runtimeId: "made-up" }), hasCode("INVALID_RUNTIME"));
  await assert.rejects(harness.service.saveProfile({ runtimeId: "builtin-api", providerId: "made-up", modelId: "m" }), hasCode("UNKNOWN_PROVIDER"));
  await assert.rejects(harness.service.saveProfile({
    runtimeId: "builtin-api", providerId: "openai", baseUrl: "https://user:pass@example.test/v1", modelId: "m",
  }), hasCode("INVALID_BASE_URL"));
  await assert.rejects(harness.service.saveProfile({
    runtimeId: "opencode", ownershipMode: "external", providerId: "opencode", baseUrl: "http://example.test", modelId: "p/m",
  }), hasCode("INSECURE_EXTERNAL_OPENCODE_URL"));
  harness.state.profiles.push(profile());
  await assert.rejects(harness.service.writeProfileSecrets("p1", {
    sensitiveHeaders: { Host: "forbidden" },
  }), hasCode("INVALID_SENSITIVE_HEADER"));
});

test("every secret write uses the vault and makes the profile a draft", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({ status: "verified", verifiedFingerprint: "old", secretGeneration: 1 }));

  const result = await harness.service.writeProfileSecrets("p1", {
    apiKey: "sk-test-secret",
    sensitiveHeaders: { "x-private": "private-value" },
  });

  assert.deepEqual(harness.calls.vaultWrites, [{
    profileId: "p1",
    secrets: { apiKey: "sk-test-secret", sensitiveHeaders: { "x-private": "private-value" } },
  }]);
  assert.equal(harness.state.profiles[0].status, "draft");
  assert.equal(harness.state.profiles[0].secretGeneration, 2);
  assert.deepEqual(result, { ok: true, generation: 2, flags: { hasApiKey: true, hasServicePassword: false, hasSensitiveHeaders: true } });
  assert.equal(JSON.stringify(result).includes("sk-test-secret"), false);
});

test("external OpenCode explains credential ownership and rejects provider keys", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({ runtimeId: "opencode", ownershipMode: "external", providerId: "opencode" }));

  await assert.rejects(harness.service.writeProfileSecrets("p1", { apiKey: "not-accepted" }), hasCode("EXTERNAL_OPENCODE_PROVIDER_KEY_REJECTED"));
  const options = await harness.service.listRuntimeOptions();
  assert.match(options.runtimes.find((item) => item.id === "opencode").externalCredentialNotice, /外部实例/);
});

test("changing a managed OpenCode profile to external removes provider credentials", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({
    runtimeId: "opencode", ownershipMode: "managed-local", providerId: "openai",
    secretRefs: { apiKey: "vault:p1:api-key", servicePassword: "vault:p1:service-password", sensitiveHeaders: { "x-private": "vault:p1:x" } },
  }));
  harness.vaultSecrets = { apiKey: "provider-key", servicePassword: "service-only", sensitiveHeaders: { "x-private": "private" } };

  const saved = await harness.service.saveProfile({
    id: "p1", runtimeId: "opencode", ownershipMode: "external", providerId: "openai",
    baseUrl: "https://opencode.example.test", modelId: "model-1",
  });

  assert.deepEqual(harness.calls.vaultWrites.at(-1).secrets, { servicePassword: "service-only" });
  assert.equal(saved.hasApiKey, false);
  assert.equal(saved.hasSensitiveHeaders, false);
  assert.equal(saved.hasServicePassword, true);
  assert.equal(saved.status, "draft");
});

test("OpenRouter and OpenCode require a live dynamic model while other providers allow manual IDs", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({ providerId: "openrouter", modelId: "missing" }));
  harness.catalogResult = { models: [{ id: "available" }], stale: false, source: "openrouter" };
  await assert.rejects(harness.service.activateProfile("p1"), hasCode("MODEL_NOT_IN_LIVE_CATALOG"));

  harness.state.profiles[0] = profile({ providerId: "deepseek", modelId: "manual-model" });
  await harness.service.activateProfile("p1");
  assert.equal(harness.state.activeProfileId, "p1");
});

test("connection tests return stable error categories and repair suggestions", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile());
  harness.verificationResult = { ok: false, error: { code: "INVALID_CREDENTIALS", message: "raw provider message" } };

  const result = await harness.service.testProfile("p1");
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "INVALID_CREDENTIALS",
      category: "credentials",
      summary: "API Key 或服务凭据无效。",
      repairAction: "重新输入凭据，然后再次测试连接。",
    },
  });
});

test("running activation delegates to the transactional supervisor and preserves rollback selection", async () => {
  const harness = createHarness();
  harness.state.profiles.push(profile({ id: "old" }), profile({ id: "new" }));
  harness.state.activeProfileId = "old";
  harness.supervisor.phase = "running";
  harness.supervisor.desiredState = "running";
  harness.supervisor.switchProfile = async (id) => {
    harness.calls.switches.push(id);
    harness.state.activeProfileId = "old";
    throw Object.assign(new Error("new service unavailable"), { code: "UNREACHABLE_BASE_URL" });
  };

  await assert.rejects(harness.service.activateProfile("new"), hasCode("UNREACHABLE_BASE_URL"));
  assert.deepEqual(harness.calls.switches, ["new"]);
  assert.equal(harness.state.activeProfileId, "old");
});

test("running controls stay disabled until one verified profile is active", () => {
  assert.deepEqual(buildEngineSnapshot({ activeProfile: null, runtime: { phase: "stopped" } }), {
    configurationRequired: true,
    canRun: false,
    activeProfile: null,
  });
  const active = profile({ status: "verified" });
  const engine = buildEngineSnapshot({ activeProfile: active, runtime: { phase: "stopped" } });
  assert.equal(engine.configurationRequired, false);
  assert.equal(engine.canRun, true);
  assert.equal(engine.activeProfile.id, "p1");
  assert.equal(JSON.stringify(engine).includes("secretRefs"), false);
});

function createHarness() {
  const state = { profiles: [], activeProfileId: "" };
  const calls = { vaultWrites: [], switches: [] };
  const profileStore = {
    get(id) { return state.profiles.find((item) => item.id === id) || null; },
    getActive() { return this.get(state.activeProfileId); },
    listMasked() { return state.profiles.map(mask); },
    upsertDraft(input) {
      const existing = this.get(input.id);
      const next = { ...(existing || profile({ id: input.id || "created" })), ...input, status: "draft", verifiedFingerprint: "" };
      if (existing) state.profiles = state.profiles.map((item) => item.id === next.id ? next : item);
      else state.profiles.push(next);
      if (state.activeProfileId === next.id) state.activeProfileId = "";
      return next;
    },
    markSecretWritten(id, { generation, secretRefs }) {
      const item = this.get(id);
      Object.assign(item, { secretGeneration: generation, secretRefs, status: "draft", verifiedFingerprint: "" });
      if (state.activeProfileId === id) state.activeProfileId = "";
      return item;
    },
    activate(id) { state.activeProfileId = id; return this.get(id); },
    delete(id) { state.profiles = state.profiles.filter((item) => item.id !== id); if (state.activeProfileId === id) state.activeProfileId = ""; return true; },
  };
  const vault = {
    generation: 1,
    async write(profileId, secrets) { calls.vaultWrites.push({ profileId, secrets }); this.generation += 1; return { generation: this.generation }; },
    async delete() { this.generation += 1; return { generation: this.generation }; },
  };
  const supervisor = { phase: "stopped", desiredState: "stopped", async switchProfile(id) { calls.switches.push(id); state.activeProfileId = id; } };
  const harness = {
    state,
    calls,
    supervisor,
    catalogResult: { models: [{ id: "model-1" }], stale: false, source: "live" },
    verificationResult: { ok: true, capabilities: { streaming: true, tools: true } },
    vaultSecrets: {},
  };
  harness.service = new ModelSettingsService({
    profileStore,
    credentialVault: { ...vault, read: async () => harness.vaultSecrets },
    catalog: { list: async () => harness.catalogResult },
    verifier: { verify: async () => harness.verificationResult },
    supervisor,
  });
  return harness;
}

function profile(overrides = {}) {
  const value = {
    id: "p1", name: "主要模型", runtimeId: "builtin-api", ownershipMode: "", providerId: "openai",
    protocolId: "openai-responses", baseUrl: "https://api.openai.com/v1", options: {}, modelId: "model-1",
    modelVariant: "", visionProfileId: "", secretRefs: { apiKey: "", servicePassword: "", sensitiveHeaders: {} },
    secretGeneration: 1, status: "verified", verifiedFingerprint: "verified", capabilities: {}, verificationError: "",
    catalogMetadata: {}, createdAt: "", updatedAt: "", verifiedAt: "", ...overrides,
  };
  if (!Object.hasOwn(overrides, "verifiedFingerprint")) value.verifiedFingerprint = computeVerificationFingerprint(value);
  return value;
}

function mask(value) {
  const { secretRefs, ...rest } = value;
  return { ...rest, hasApiKey: Boolean(secretRefs.apiKey), hasServicePassword: Boolean(secretRefs.servicePassword), hasSensitiveHeaders: Object.keys(secretRefs.sensitiveHeaders).length > 0 };
}

function hasCode(code) { return (error) => error?.code === code; }
