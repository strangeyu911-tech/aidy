"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createRuntimeAdapter } = require("../src/adapters/runtime/factory");
const { CyberbossApp } = require("../src/core/app");
const { ProviderProfileStore } = require("../src/core/provider-profile-store");
const { CredentialVault } = require("../src/security/credential-vault");

function profile(runtimeId, overrides = {}) {
  return {
    id: `${runtimeId}-profile`,
    runtimeId,
    providerId: runtimeId === "codex" || runtimeId === "claudecode" ? "compatibility" : "synthetic",
    protocolId: "openai-chat",
    modelId: "synthetic-model",
    secretGeneration: 2,
    status: "verified",
    capabilities: { streaming: true, tools: true },
    ...overrides,
  };
}

function makeStore(active) {
  return {
    getActive: () => active,
    get: (id) => active?.id === id ? active : null,
    markUnverifiedCalls: [],
    markUnverified(id, reason) {
      this.markUnverifiedCalls.push({ id, reason });
    },
  };
}

function makeVault({ generation = 2, secrets = { apiKey: "synthetic-secret" }, readError = null } = {}) {
  return {
    getGeneration: () => generation,
    async read() {
      if (readError) throw readError;
      return secrets;
    },
  };
}

test("factory rejects an empty active profile synchronously and never defaults to Codex", () => {
  assert.throws(
    () => createRuntimeAdapter({ profileStore: makeStore(null), vault: makeVault() }),
    (error) => error.code === "NO_ACTIVE_ENGINE" && /NO_ACTIVE_ENGINE/.test(error.message),
  );
});

test("factory rejects draft and unverified active profiles before reading credentials", () => {
  for (const status of ["draft", "unverified"]) {
    let reads = 0;
    assert.throws(
      () => createRuntimeAdapter({
        profileStore: makeStore(profile("builtin-api", { status })),
        vault: { getGeneration: () => 2, read: async () => { reads += 1; return {}; } },
      }),
      (error) => error.code === "PROFILE_NOT_VERIFIED",
    );
    assert.equal(reads, 0);
  }
});

test("factory exhaustively constructs all registered runtimes with the exact active profile", async () => {
  const calls = [];
  const adapterFactories = Object.fromEntries(
    ["builtin-api", "opencode", "codex", "claudecode"].map((runtimeId) => [runtimeId, (options) => {
      calls.push({ runtimeId, options });
      return { describe: () => ({ id: runtimeId, profileId: options.profile?.id }) };
    }]),
  );
  const projectToolHost = { listTools: () => [], invokeTool: async () => null };

  for (const runtimeId of Object.keys(adapterFactories)) {
    const active = profile(runtimeId);
    const adapter = await createRuntimeAdapter({
      config: { stateDir: "D:\\state", sessionsFile: "D:\\state\\sessions.json" },
      profileStore: makeStore(active),
      vault: makeVault(),
      projectToolHost,
      adapterFactories,
    });
    assert.deepEqual(adapter.describe(), { id: runtimeId, profileId: active.id });
  }

  assert.deepEqual(calls.map((call) => call.runtimeId), ["builtin-api", "opencode", "codex", "claudecode"]);
  assert.equal(calls[0].options.profile.id, "builtin-api-profile");
  assert.equal(calls[0].options.secrets.apiKey, "synthetic-secret");
  assert.equal(calls[0].options.projectToolHost, projectToolHost);
  assert.equal(calls[2].options.config.codexModel, "synthetic-model");
  assert.equal(calls[3].options.config.claudeModel, "synthetic-model");
});

test("factory invalidates generation drift but preserves verified state across transient vault failures", async () => {
  const active = profile("builtin-api");
  const generationStore = makeStore(active);
  await assert.rejects(
    Promise.resolve().then(() => createRuntimeAdapter({
      profileStore: generationStore,
      vault: makeVault({ generation: 3 }),
      projectToolHost: { listTools: () => [], invokeTool: async () => null },
    })),
    (error) => error.code === "PROFILE_NOT_VERIFIED",
  );
  assert.deepEqual(generationStore.markUnverifiedCalls, [{ id: active.id, reason: "credential_generation_changed" }]);

  const vaultStore = makeStore(active);
  await assert.rejects(
    Promise.resolve().then(() => createRuntimeAdapter({
      profileStore: vaultStore,
      vault: makeVault({ readError: Object.assign(new Error("decrypt failed"), { code: "CREDENTIAL_DECRYPT_FAILED" }) }),
      projectToolHost: { listTools: () => [], invokeTool: async () => null },
    })),
    (error) => error.code === "CREDENTIAL_DECRYPT_FAILED",
  );
  assert.deepEqual(vaultStore.markUnverifiedCalls, []);
});

test("factory reopens persisted profile and vault files before constructing the real built-in adapter", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-runtime-factory-"));
  const protector = {
    async protectText(text) { return Buffer.from(text, "utf8").toString("base64"); },
    async unprotectText(value) { return Buffer.from(value, "base64").toString("utf8"); },
  };
  const store = new ProviderProfileStore({ stateDir, randomUUID: () => "persisted-profile" });
  const draft = store.upsertDraft(profile("builtin-api", {
    id: "persisted-profile",
    baseUrl: "https://provider.example.test/v1",
  }));
  const vault = new CredentialVault({ stateDir, protector });
  const write = await vault.write(draft.id, { apiKey: "persisted-synthetic-secret" });
  store.markVerified(draft.id, { secretGeneration: write.generation, capabilities: { streaming: true, tools: true } });
  store.activate(draft.id);

  assert.equal(fs.existsSync(path.join(stateDir, "provider-profiles.json")), true);
  assert.equal(fs.existsSync(path.join(stateDir, "credential-vault.json")), true);
  const reopenedStore = new ProviderProfileStore({ stateDir });
  const reopenedVault = new CredentialVault({ stateDir, protector });
  const adapter = await createRuntimeAdapter({
    config: { stateDir },
    profileStore: reopenedStore,
    vault: reopenedVault,
    projectToolHost: { listTools: () => [], invokeTool: async () => null },
  });
  assert.deepEqual(adapter.describe(), {
    id: "builtin-api",
    profileId: "persisted-profile",
    model: "synthetic-model",
    provider: "synthetic",
  });
  await adapter.close();
});

test("/model is inspect-only and directs mutations to Control Center", async () => {
  const sent = [];
  let workspaceModelWrites = 0;
  const app = Object.create(CyberbossApp.prototype);
  app.activeProfile = profile("builtin-api", { name: "Primary", providerId: "openrouter", modelId: "openai/gpt-5" });
  app.runtimeAdapter = {
    describe: () => ({ id: "builtin-api", profileId: app.activeProfile.id, provider: "openrouter", model: "openai/gpt-5" }),
    getSessionStore: () => ({
      buildBindingKey: () => "binding",
      getActiveWorkspaceRoot: () => "D:\\workspace",
      setRuntimeParamsForWorkspace: () => { workspaceModelWrites += 1; },
    }),
  };
  app.config = { workspaceRoot: "D:\\workspace" };
  app.channelAdapter = { async sendText(message) { sent.push(message.text); } };

  await app.handleModelCommand({ workspaceId: "w", accountId: "a", senderId: "s", contextToken: "c" }, { args: "other-model" });
  assert.equal(workspaceModelWrites, 0);
  assert.match(sent[0], /openai\/gpt-5/);
  assert.match(sent[0], /桌面控制中心/);
  assert.match(sent[0], /只能看，不能改/);
});
