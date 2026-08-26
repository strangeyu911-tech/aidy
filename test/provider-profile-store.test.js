const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ProviderProfileStore,
  computeVerificationFingerprint,
  normalizeProviderProfiles,
} = require("../src/core/provider-profile-store");
const { readConfig } = require("../src/core/config");

function makeProfileStore() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-provider-profile-test-"));
  return {
    filePath: path.join(stateDir, "provider-profiles.json"),
    stateDir,
    store: new ProviderProfileStore({ stateDir }),
  };
}

function validDraft(overrides = {}) {
  return {
    name: "OpenRouter primary",
    runtimeId: "builtin-api",
    providerId: "openrouter",
    protocolId: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    options: { reasoning: "high" },
    modelId: "openai/gpt-5",
    modelVariant: "standard",
    secretRefs: {
      apiKey: "vault:profile:api-key",
      sensitiveHeaders: { "X-Tenant": "vault:profile:header:x-tenant" },
    },
    ...overrides,
  };
}

test("editing a verified field returns the profile to draft", () => {
  const { store } = makeProfileStore();
  const draft = store.upsertDraft(validDraft());
  const verified = store.markVerified(draft.id, {
    secretGeneration: 1,
    capabilities: { streaming: true, tools: true },
  });
  store.activate(draft.id);

  assert.equal(verified.status, "verified");
  const edited = store.upsertDraft({ ...store.get(draft.id), modelId: "anthropic/claude-sonnet-4" });
  assert.equal(edited.status, "draft");
  assert.equal(edited.verifiedFingerprint, "");
  assert.equal(store.getActive(), null);
});

test("changing display-only fields preserves a matching verification", () => {
  const { store } = makeProfileStore();
  const draft = store.upsertDraft(validDraft());
  store.markVerified(draft.id, {
    secretGeneration: 4,
    capabilities: { streaming: true, tools: true },
  });

  const renamed = store.upsertDraft({ ...store.get(draft.id), name: "Renamed profile" });
  assert.equal(renamed.status, "verified");
  assert.equal(renamed.verifiedFingerprint, computeVerificationFingerprint(renamed));
});

test("activation rejects drafts and stale verification fingerprints", () => {
  const { store } = makeProfileStore();
  const draft = store.upsertDraft(validDraft());
  assert.throws(() => store.activate(draft.id), (error) => error.code === "PROFILE_NOT_VERIFIED");

  store.markVerified(draft.id, {
    secretGeneration: 1,
    capabilities: { streaming: true, tools: true },
  });
  const state = JSON.parse(fs.readFileSync(store.store.filePath, "utf8"));
  state.profiles[0].modelId = "tampered-model";
  fs.writeFileSync(store.store.filePath, JSON.stringify(state), "utf8");
  assert.throws(() => store.activate(draft.id), (error) => error.code === "PROFILE_NOT_VERIFIED");
});

test("masked snapshots expose secret-presence flags but no references or secret material", () => {
  const { store, filePath } = makeProfileStore();
  store.upsertDraft(validDraft({
    apiKey: "must-not-persist",
    ciphertext: "must-not-persist",
    authorization: "Bearer must-not-persist",
  }));

  const [masked] = store.listMasked();
  const maskedJson = JSON.stringify(masked);
  const persistedJson = fs.readFileSync(filePath, "utf8");
  assert.equal(masked.hasApiKey, true);
  assert.equal(masked.hasSensitiveHeaders, true);
  assert.equal(maskedJson.includes("secretRefs"), false);
  assert.equal(maskedJson.includes("vault:profile"), false);
  assert.equal(persistedJson.includes("must-not-persist"), false);
});

test("draft persists atomically and can be reopened by a fresh store", () => {
  const { store, stateDir, filePath } = makeProfileStore();
  const draft = store.upsertDraft(validDraft());
  assert.equal(fs.existsSync(filePath), true);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, "utf8")));
  assert.deepEqual(
    fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const reopened = new ProviderProfileStore({ stateDir });
  assert.equal(reopened.get(draft.id).modelId, "openai/gpt-5");
  assert.equal(reopened.get(draft.id).status, "draft");
});

test("markUnverified and delete clear the active selection", () => {
  const { store } = makeProfileStore();
  const draft = store.upsertDraft(validDraft());
  store.markVerified(draft.id, { secretGeneration: 1, capabilities: { tools: true } });
  store.activate(draft.id);
  const unverified = store.markUnverified(draft.id, "invalid_credentials");
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.verificationError, "invalid_credentials");
  assert.equal(store.getActive(), null);

  assert.equal(store.delete(draft.id), true);
  assert.equal(store.get(draft.id), null);
  assert.equal(store.delete(draft.id), false);
});

test("markRuntimeProfilesUnverified invalidates only matching runtime profiles atomically", () => {
  const { store } = makeProfileStore();
  const firstCodeBuddy = store.upsertDraft(validDraft({
    name: "CodeBuddy primary",
    runtimeId: "codebuddy",
    providerId: "codebuddy",
    protocolId: "codebuddy-acp",
    baseUrl: "",
    modelId: "codebuddy/default",
  }));
  const secondCodeBuddy = store.upsertDraft(validDraft({
    name: "CodeBuddy secondary",
    runtimeId: "codebuddy",
    providerId: "codebuddy",
    protocolId: "codebuddy-acp",
    baseUrl: "",
    modelId: "codebuddy/fast",
  }));
  const codex = store.upsertDraft(validDraft({
    name: "Codex",
    runtimeId: "codex",
    providerId: "openai",
    protocolId: "codex-app-server",
    baseUrl: "",
    modelId: "gpt-5",
  }));

  for (const profile of [firstCodeBuddy, secondCodeBuddy, codex]) {
    store.markVerified(profile.id, {
      secretGeneration: 2,
      capabilities: { tools: true, runtime: profile.runtimeId },
    });
  }
  store.activate(firstCodeBuddy.id);
  const codexBefore = store.get(codex.id);

  const invalidated = store.markRuntimeProfilesUnverified(" CODEBUDDY ", "account_identity_changed");

  assert.deepEqual(invalidated.map((profile) => profile.id), [firstCodeBuddy.id, secondCodeBuddy.id]);
  for (const profileId of [firstCodeBuddy.id, secondCodeBuddy.id]) {
    const profile = store.get(profileId);
    assert.equal(profile.status, "unverified");
    assert.equal(profile.verifiedFingerprint, "");
    assert.deepEqual(profile.capabilities, {});
    assert.equal(profile.verifiedAt, "");
    assert.equal(profile.verificationError, "account_identity_changed");
  }
  assert.equal(store.getActive(), null);
  assert.deepEqual(store.get(codex.id), codexBefore);
});

test("a secret write records the new generation, masks references, and requires reverification", () => {
  const { store } = makeProfileStore();
  const draft = store.upsertDraft({ runtimeId: "builtin-api", providerId: "openai", modelId: "gpt-5" });
  store.markVerified(draft.id, { secretGeneration: 1, capabilities: { tools: true } });
  store.activate(draft.id);

  const updated = store.markSecretWritten(draft.id, {
    generation: 2,
    secretRefs: { apiKey: "vault:profile:api-key", servicePassword: "", sensitiveHeaders: {} },
  });

  assert.equal(updated.status, "draft");
  assert.equal(updated.secretGeneration, 2);
  assert.equal(store.getActive(), null);
  const masked = store.listMasked()[0];
  assert.equal(masked.hasApiKey, true);
  assert.equal(masked.hasServicePassword, false);
  assert.equal(JSON.stringify(masked).includes("vault:profile"), false);
});

test("profile normalization rejects arbitrary runtimes and stale active IDs", () => {
  const normalized = normalizeProviderProfiles({
    schemaVersion: 99,
    activeProfileId: "bad-profile",
    profiles: [validDraft({ id: "bad-profile", runtimeId: "made-up", status: "verified" })],
  });
  assert.deepEqual(normalized, { schemaVersion: 1, activeProfileId: "", profiles: [] });
});

test("readConfig exposes provider state paths and the bridge control port", () => {
  const previousStateDir = process.env.CYBERBOSS_STATE_DIR;
  const previousPort = process.env.CYBERBOSS_BRIDGE_CONTROL_PORT;
  const stateDir = path.join(os.tmpdir(), "cyberboss-config-profile-test");
  process.env.CYBERBOSS_STATE_DIR = stateDir;
  process.env.CYBERBOSS_BRIDGE_CONTROL_PORT = "48765";
  try {
    const config = readConfig();
    assert.equal(config.providerProfilesFile, path.join(stateDir, "provider-profiles.json"));
    assert.equal(config.credentialVaultFile, path.join(stateDir, "credential-vault.json"));
    assert.equal(config.diagnosticCaptureFile, path.join(stateDir, "diagnostic-capture.json"));
    assert.equal(config.bridgeControlPort, 48765);
  } finally {
    if (previousStateDir === undefined) delete process.env.CYBERBOSS_STATE_DIR;
    else process.env.CYBERBOSS_STATE_DIR = previousStateDir;
    if (previousPort === undefined) delete process.env.CYBERBOSS_BRIDGE_CONTROL_PORT;
    else process.env.CYBERBOSS_BRIDGE_CONTROL_PORT = previousPort;
  }
});
