# CyberBoss API-First Multi-Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the implicit Codex default with a verified, globally active API/runtime profile while adding built-in API and optional OpenCode execution without regressing existing CyberBoss tools, sessions, desktop supervision, or data safety.

**Architecture:** Add a runtime registry, atomic non-secret profile store, DPAPI credential vault, provider catalog/verifier, built-in API agent adapter, and OpenCode adapter behind the existing normalized runtime-event contract. The Electron controller owns activation, drain/switch/rollback, and a first-run configuration UI; the bridge resolves exactly one global active profile and never falls back to Codex.

**Tech Stack:** Node.js 22 CommonJS, Electron 43, native `fetch`, `node:http`, `node:test`, existing `AtomicJsonStore`, existing MCP/project tool host, Windows PowerShell DPAPI bridge, OpenCode HTTP/SSE API.

**Spec:** `docs/superpowers/specs/2026-08-25-api-first-multi-runtime-night-care-design.md`

## Global Constraints

- A clean state directory has no active engine and cannot enter Running or Quiet.
- Runtime IDs are only `builtin-api`, `opencode`, `codex`, and `claudecode`; unknown or empty values never fall back to Codex.
- Provider/model selection is global. Legacy per-workspace model settings never override the active profile.
- API keys, service passwords, sensitive headers, decrypted secrets, and vault ciphertext never enter renderer snapshots, normal logs, backup, or export.
- DPAPI uses the current Windows user; no macOS/Linux API-profile enablement is added in this release.
- External OpenCode uses credentials already owned by that service and forces a live catalog refresh on every activation.
- Only profiles verified for authentication, model access, streaming, tool calling, and tool-result continuation can activate.
- Profile switching defaults to a 120-second grace period configurable from 30 through 600 seconds and must restart/reconnect the old runtime on rollback.
- Preserve unrelated untracked `.superpowers/` and `scripts/cyberboss-background.ps1` files.
- Every persistence/export deliverable must be proven to exist and be reopened successfully before its task is complete.

---

## File map

### New core and security files

- `src/core/runtime-registry.js` — internal runtime definitions and strict lookup.
- `src/core/provider-profile-store.js` — profile schema, verification fingerprint, activation, invalidation, and masked snapshots.
- `src/security/windows-dpapi.js` — stdin-only PowerShell DPAPI bridge.
- `src/security/credential-vault.js` — encrypted per-profile secret payloads and monotonically increasing generations.
- `src/security/diagnostic-capture.js` — bounded, encrypted, expiring opt-in traces.
- `src/services/provider-catalog.js` — provider presets, model discovery, cache, and OpenCode cache policy.
- `src/services/provider-verifier.js` — live capability verification and normalized error categories.
- `src/services/vision-fallback.js` — optional child operation and usage attribution.

### New runtime files

- `src/adapters/runtime/api/protocol-client.js` — normalized protocol interface and SSE/JSON helpers.
- `src/adapters/runtime/api/protocols/openai.js` — Responses and Chat Completions requests.
- `src/adapters/runtime/api/protocols/anthropic.js` — Anthropic Messages requests.
- `src/adapters/runtime/api/protocols/gemini.js` — Gemini generateContent requests.
- `src/adapters/runtime/api/protocols/ollama.js` — Ollama model list and chat requests.
- `src/adapters/runtime/api/conversation-store.js` — committed message/tool history scoped by profile/model/generation.
- `src/adapters/runtime/api/tool-bridge.js` — schemas, approval gate, and project-tool invocation.
- `src/adapters/runtime/api/agent-loop.js` — bounded streamed model/tool/result loop.
- `src/adapters/runtime/api/index.js` — built-in API runtime adapter.
- `src/adapters/runtime/opencode/client.js` — OpenCode health/provider/session/event client.
- `src/adapters/runtime/opencode/index.js` — normalized OpenCode runtime adapter.
- `src/adapters/runtime/factory.js` — strict registry-based adapter construction.

### New desktop control files

- `src/desktop/model-settings-service.js` — profile CRUD, secret writes, catalog refresh, verification, and activation orchestration.
- `src/desktop/bridge-control-client.js` — authenticated drain/abort/readiness calls.
- `src/core/bridge-control-server.js` — bridge-side health, drain, and abort endpoints.

### Modified files

- `src/core/config.js`, `src/core/app.js`, `src/core/command-registry.js`, `src/core/thread-state-store.js`
- `src/adapters/runtime/codex/session-store.js`
- `src/desktop/main.js`, `src/desktop/preload.js`, `src/desktop/runtime-supervisor.js`
- `src/desktop/renderer/index.html`, `src/desktop/renderer/renderer.js`, `src/desktop/renderer/styles.css`
- `src/services/vision-context.js`, `src/services/backup-service.js`
- `package.json`, `README.md`, `README.zh-CN.md`, `README.en.md`

### New tests

- `test/runtime-registry.test.js`
- `test/provider-profile-store.test.js`
- `test/credential-vault.test.js`
- `test/diagnostic-capture.test.js`
- `test/provider-catalog.test.js`
- `test/provider-protocols.test.js`
- `test/provider-verifier.test.js`
- `test/api-agent-loop.test.js`
- `test/api-conversation-store.test.js`
- `test/opencode-runtime.test.js`
- `test/runtime-factory.test.js`
- `test/model-settings-service.test.js`
- `test/bridge-control.test.js`
- `test/runtime-profile-switch.test.js`
- `test/vision-fallback.test.js`
- `test/desktop-model-ipc.test.js`

---

### Task 1: Strict runtime registry and atomic provider profiles

**Files:**
- Create: `src/core/runtime-registry.js`
- Create: `src/core/provider-profile-store.js`
- Create: `test/runtime-registry.test.js`
- Create: `test/provider-profile-store.test.js`
- Modify: `src/core/config.js`

**Interfaces:**
- Produces: `RUNTIME_IDS`, `getRuntimeDefinition(runtimeId)`, `listRuntimeDefinitions()`.
- Produces: `ProviderProfileStore#get(id)`, `listMasked()`, `upsertDraft(input)`, `markVerified(id, result)`, `markUnverified(id, reason)`, `activate(id)`, `delete(id)`, `getActive()`.
- Produces: `computeVerificationFingerprint(profile)` and `normalizeProviderProfiles(value)`.

- [ ] **Step 1: Write failing registry and profile-state tests**

```js
test("unknown runtime never falls back to codex", () => {
  assert.throws(() => getRuntimeDefinition(""), /runtime/i);
  assert.throws(() => getRuntimeDefinition("made-up"), /runtime/i);
  assert.equal(getRuntimeDefinition("builtin-api").id, "builtin-api");
});

test("editing a verified field returns the profile to draft", () => {
  const store = makeProfileStore();
  const draft = store.upsertDraft({ runtimeId: "builtin-api", providerId: "openrouter", modelId: "openai/gpt-5" });
  store.markVerified(draft.id, { secretGeneration: 1, capabilities: { streaming: true, tools: true } });
  const edited = store.upsertDraft({ ...store.get(draft.id), modelId: "anthropic/claude-sonnet-4" });
  assert.equal(edited.status, "draft");
  assert.equal(store.getActive(), null);
});
```

- [ ] **Step 2: Run the focused tests and confirm missing-module failures**

Run: `node --test ./test/runtime-registry.test.js ./test/provider-profile-store.test.js`

Expected: FAIL because the registry and profile store do not exist.

- [ ] **Step 3: Implement strict definitions and schema-versioned profile state**

```js
const RUNTIME_IDS = Object.freeze(["builtin-api", "opencode", "codex", "claudecode"]);
const DEFINITIONS = new Map(RUNTIME_IDS.map((id) => [id, Object.freeze({
  id,
  processKind: id === "builtin-api" ? "none" : id === "opencode" ? "opencode" : id,
})]));

function getRuntimeDefinition(runtimeId) {
  const definition = DEFINITIONS.get(String(runtimeId || "").trim().toLowerCase());
  if (!definition) throw Object.assign(new Error("A registered runtime is required."), { code: "INVALID_RUNTIME" });
  return definition;
}
```

Use `AtomicJsonStore` with `{ schemaVersion: 1, activeProfileId: "", profiles: [] }`. Persist only the non-secret fields named in the spec. Make `activate(id)` reject non-verified profiles and make every masked result expose `hasApiKey`/`hasSensitiveHeaders` flags without secret references or ciphertext.

Add `providerProfilesFile`, `credentialVaultFile`, `diagnosticCaptureFile`, and `bridgeControlPort` paths/settings to `readConfig()`.

- [ ] **Step 4: Run tests and reopen persisted state with a fresh store**

Run: `node --test ./test/runtime-registry.test.js ./test/provider-profile-store.test.js`

Expected: PASS, including a test that constructs a second `ProviderProfileStore`, reads the same file, and sees the saved draft.

- [ ] **Step 5: Commit**

```powershell
git add src/core/runtime-registry.js src/core/provider-profile-store.js src/core/config.js test/runtime-registry.test.js test/provider-profile-store.test.js
git commit -m "Add strict runtime and provider profile stores"
```

---

### Task 2: DPAPI credential vault and bounded diagnostics

**Files:**
- Create: `src/security/windows-dpapi.js`
- Create: `src/security/credential-vault.js`
- Create: `src/security/diagnostic-capture.js`
- Create: `test/credential-vault.test.js`
- Create: `test/diagnostic-capture.test.js`
- Modify: `src/core/component-logger.js`

**Interfaces:**
- Produces: `protectText(text) -> Promise<string>` and `unprotectText(ciphertext) -> Promise<string>`.
- Produces: `CredentialVault#write(profileId, secrets) -> { generation }`, `read(profileId)`, `delete(profileId)`, `getGeneration(profileId)`.
- Produces: `DiagnosticCapture#enable({ scope, durationMs })`, `record(event)`, `read()`, `disable()`, `cleanupExpired()`.

- [ ] **Step 1: Write failing generation, reopen, tamper, and redaction tests**

```js
test("every vault write increments generation even for the same value", async () => {
  const vault = makeVaultWithIdentityProtector();
  assert.equal((await vault.write("p1", { apiKey: "same" })).generation, 1);
  assert.equal((await vault.write("p1", { apiKey: "same" })).generation, 2);
  assert.deepEqual(await vault.read("p1"), { apiKey: "same" });
});

test("diagnostic vision capture omits image bytes", async () => {
  const capture = makeCapture();
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  await capture.record({ kind: "vision", mimeType: "image/png", bytes: Buffer.from("secret-image"), responseText: "a desk" });
  const records = await capture.read();
  assert.equal(JSON.stringify(records).includes("secret-image"), false);
  assert.equal(records[0].responseText, "a desk");
});
```

- [ ] **Step 2: Run tests and confirm failures**

Run: `node --test ./test/credential-vault.test.js ./test/diagnostic-capture.test.js`

Expected: FAIL because security modules do not exist.

- [ ] **Step 3: Implement stdin-only DPAPI and atomic encrypted stores**

Use a fixed PowerShell script passed with `-Command`; pass plaintext only through child stdin:

```js
const PROTECT_SCRIPT = [
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))",
].join(";");
```

Vault entries are `{ profileId, generation, ciphertext, deleted, updatedAt }`.
Deletion writes a tombstone with an incremented generation instead of removing
the counter, so rewriting the same profile can never reuse an old generation.
After every non-deletion write, reread the file, decrypt the new ciphertext, and
compare the JSON payload before resolving. Diagnostic capture uses the same
protector, enforces 15 minutes maximum, 1 MiB maximum decrypted JSON, 24-hour
deletion, and replaces buffers with `{ mimeType, byteLength, sha256 }`.

Extend logger redaction to remove `authorization`, `apiKey`, `servicePassword`, sensitive header values, ciphertext, request body, and response body keys recursively.

- [ ] **Step 4: Run security tests and inspect the vault file**

Run: `node --test ./test/credential-vault.test.js ./test/diagnostic-capture.test.js ./test/component-logger.test.js`

Expected: PASS. The test must assert the vault file exists, can be reopened, contains no synthetic plaintext key, and decrypts only through the injected vault boundary.

- [ ] **Step 5: Commit**

```powershell
git add src/security src/core/component-logger.js test/credential-vault.test.js test/diagnostic-capture.test.js test/component-logger.test.js
git commit -m "Encrypt provider credentials with DPAPI"
```

---

### Task 3: Provider presets, model discovery, and cache rules

**Files:**
- Create: `src/services/provider-catalog.js`
- Create: `test/provider-catalog.test.js`

**Interfaces:**
- Produces: `PROVIDER_PRESETS`, `getProviderPreset(id)`, `ProviderCatalog#list(profile, secrets, options)`, `invalidate(profileId)`, `search(models, query)`.
- Consumes: masked profile fields from Task 1 and decrypted secrets only inside the service call.

- [ ] **Step 1: Write failing preset and cache-policy tests**

```js
test("named providers resolve to explicit protocols", () => {
  assert.equal(getProviderPreset("openai").protocol, "openai-responses");
  assert.equal(getProviderPreset("openrouter").protocol, "openai-chat");
  assert.equal(getProviderPreset("anthropic").protocol, "anthropic-messages");
  assert.equal(getProviderPreset("gemini").protocol, "gemini");
  assert.equal(getProviderPreset("ollama").protocol, "ollama");
  for (const id of ["deepseek", "kimi", "glm", "minimax", "hunyuan", "mimo", "qwen", "custom-openai"]) {
    assert.equal(getProviderPreset(id).protocol, "openai-chat");
  }
});

test("external opencode activation always bypasses cache", async () => {
  const calls = [];
  const catalog = makeCatalog({ fetchModels: async () => { calls.push(Date.now()); return [{ id: `m${calls.length}` }]; } });
  await catalog.list(externalProfile(), {}, { reason: "activation" });
  await catalog.list(externalProfile(), {}, { reason: "activation" });
  assert.equal(calls.length, 2);
});
```

- [ ] **Step 2: Run and confirm missing catalog failures**

Run: `node --test ./test/provider-catalog.test.js`

Expected: FAIL because provider catalog symbols do not exist.

- [ ] **Step 3: Implement data-driven presets and normalized model records**

```js
const PROVIDER_PRESETS = Object.freeze({
  openai: { protocol: "openai-responses", defaultBaseUrl: "https://api.openai.com/v1", requiresApiKey: true },
  openrouter: { protocol: "openai-chat", defaultBaseUrl: "https://openrouter.ai/api/v1", requiresApiKey: true },
  anthropic: { protocol: "anthropic-messages", defaultBaseUrl: "https://api.anthropic.com", requiresApiKey: true },
  gemini: { protocol: "gemini", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", requiresApiKey: true },
  ollama: { protocol: "ollama", defaultBaseUrl: "http://127.0.0.1:11434", requiresApiKey: false },
  deepseek: { protocol: "openai-chat", defaultBaseUrl: "https://api.deepseek.com/v1", requiresApiKey: true },
  kimi: { protocol: "openai-chat", defaultBaseUrl: "https://api.moonshot.cn/v1", requiresApiKey: true },
  glm: { protocol: "openai-chat", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", requiresApiKey: true },
  minimax: { protocol: "openai-chat", defaultBaseUrl: "", requiresApiKey: true },
  hunyuan: { protocol: "openai-chat", defaultBaseUrl: "", requiresApiKey: true },
  mimo: { protocol: "openai-chat", defaultBaseUrl: "", requiresApiKey: true },
  qwen: { protocol: "openai-chat", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", requiresApiKey: true },
  "custom-openai": { protocol: "openai-chat", defaultBaseUrl: "", requiresApiKey: false },
});
```

For providers whose official endpoint varies by account region or product, keep `defaultBaseUrl` empty and require the UI to collect it; this is not a runtime fallback. Normalize models to `{ id, name, providerId, inputModalities, contextWindow }`. Cache for 10 minutes, but bypass cache for every External OpenCode activation, live verification, manual refresh, endpoint/version change, and managed provider-auth change. Stale results are display-only.

- [ ] **Step 4: Run catalog tests**

Run: `node --test ./test/provider-catalog.test.js`

Expected: PASS for presets, manual model fallback, deduplication, search, stale labeling, and External activation refresh.

- [ ] **Step 5: Commit**

```powershell
git add src/services/provider-catalog.js test/provider-catalog.test.js
git commit -m "Add provider presets and model catalogs"
```

---

### Task 4: Normalized provider protocol clients and live verifier

**Files:**
- Create: `src/adapters/runtime/api/protocol-client.js`
- Create: `src/adapters/runtime/api/protocols/openai.js`
- Create: `src/adapters/runtime/api/protocols/anthropic.js`
- Create: `src/adapters/runtime/api/protocols/gemini.js`
- Create: `src/adapters/runtime/api/protocols/ollama.js`
- Create: `src/services/provider-verifier.js`
- Create: `test/provider-protocols.test.js`
- Create: `test/provider-verifier.test.js`

**Interfaces:**
- Produces: `createProtocolClient({ profile, secrets, fetchImpl, capture })`.
- Client methods: `listModels({ signal })`, `streamTurn({ messages, tools, signal, onDelta }) -> { message, toolCalls, usage }`.
- Produces: `ProviderVerifier#verify(profileId) -> { fingerprint, secretGeneration, capabilities, verifiedAt }`.

- [ ] **Step 1: Write failing mock-server protocol tests**

```js
test("openai chat client normalizes streamed text and tool calls", async () => {
  const server = await startMockSseServer(openAiToolChunks());
  const client = createProtocolClient({ profile: openRouterProfile(server.url), secrets: { apiKey: "test-key" } });
  const deltas = [];
  const result = await client.streamTurn({ messages: [{ role: "user", content: "ping" }], tools: [weatherTool], onDelta: (text) => deltas.push(text) });
  assert.equal(deltas.join(""), "Checking");
  assert.deepEqual(result.toolCalls[0], { id: "call-1", name: "weather", arguments: { city: "Shanghai" } });
});

test("verifier rejects a model that cannot continue after a tool result", async () => {
  const result = await verifier.verify(profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_CONTINUATION_UNSUPPORTED");
});
```

- [ ] **Step 2: Run tests and confirm failures**

Run: `node --test ./test/provider-protocols.test.js ./test/provider-verifier.test.js`

Expected: FAIL because protocol clients and verifier do not exist.

- [ ] **Step 3: Implement protocol mappings and strict error normalization**

Use one normalized message/tool shape:

```js
// message
{ role: "user" | "assistant" | "tool", content: [{ type: "text", text }], toolCallId?: "" }
// tool
{ name: "cyberboss_diary_append", description: "...", inputSchema: { type: "object" } }
// result
{ message: { role: "assistant", content: [] }, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }
```

Implement incremental UTF-8 SSE parsing that tolerates chunk boundaries. Map OpenAI Responses and Chat Completions, Anthropic content blocks, Gemini candidates/function calls, and Ollama JSON lines into that shape. Apply `AbortSignal`, overall timeout, and chunk timeout. Map 401/403 to `INVALID_CREDENTIALS`, 404 model failures to `MODEL_UNAVAILABLE`, 429 to `RATE_LIMITED` or `QUOTA_EXHAUSTED`, malformed streams to `INCOMPATIBLE_PROTOCOL`, and aborts to `CANCELLED`.

Verifier sends a synthetic prompt with a harmless in-memory tool named `cyberboss_capability_echo`, executes it locally, returns the result, confirms final streamed text, tests abort against a delayed response, and records image capability separately.

- [ ] **Step 4: Run protocol/verifier tests**

Run: `node --test ./test/provider-protocols.test.js ./test/provider-verifier.test.js`

Expected: PASS using only local mock servers and synthetic keys.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/runtime/api/protocol-client.js src/adapters/runtime/api/protocols src/services/provider-verifier.js test/provider-protocols.test.js test/provider-verifier.test.js
git commit -m "Normalize model provider protocols"
```

---

### Task 5: Conversation scope, committed history, and legacy migration

**Files:**
- Create: `src/adapters/runtime/api/conversation-store.js`
- Create: `test/api-conversation-store.test.js`
- Modify: `src/adapters/runtime/codex/session-store.js`
- Modify: `test/codex-session-store.test.js`

**Interfaces:**
- Produces: `buildRuntimeScopeKey({ runtimeId, profileId, modelId, secretGeneration })`.
- Produces: `ConversationStore#beginTurn(scope, input)`, `commitAssistant(turnId, message)`, `commitToolResult(turnId, result)`, `abortTurn(turnId)`, `resume(scope)`, `archiveProfile(profileId)`.
- Extends: `SessionStore` with exact-scope lookup and `listLegacyReadOnlySessions()`.

- [ ] **Step 1: Write failing exact-scope and incomplete-turn tests**

```js
test("only committed history resumes for an exact profile scope", () => {
  const store = makeConversationStore();
  const scope = scopeFor("p1", "gpt-5", 2);
  const turn = store.beginTurn(scope, userMessage("hello"));
  store.commitAssistant(turn.id, assistantMessage("done"));
  store.beginTurn(scope, userMessage("unfinished"));
  assert.deepEqual(store.resume(scope).messages.map((m) => m.text), ["hello", "done"]);
  assert.deepEqual(store.resume(scopeFor("p1", "gpt-5", 3)).messages, []);
});

test("ambiguous legacy sessions stay read-only", () => {
  const migrated = migrateLegacyBinding(legacyBinding(), []);
  assert.equal(migrated.legacySessions[0].readOnly, true);
  assert.equal(migrated.scopedThreadId, "");
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/api-conversation-store.test.js ./test/codex-session-store.test.js`

Expected: FAIL for new exact-scope behavior.

- [ ] **Step 3: Implement schema-versioned conversations and safe legacy binding**

Persist `{ schemaVersion: 1, conversations: [] }`. A turn remains `inflight` until assistant text and every tool result are committed, then becomes `committed`. On load, normalize every `inflight` turn to `aborted`. Scope keys include all four exact fields and use a SHA-256 digest only as the map key; retain readable scope fields in the record.

Bind legacy Codex/Claude sessions only when a verified compatibility profile matches runtime plus legacy model/provider metadata. Otherwise expose:

```js
{ threadId, runtimeId: "codex", readOnly: true, reason: "legacy_scope_ambiguous" }
```

Deleting a profile calls `archiveProfile` and never moves history to another profile.

- [ ] **Step 4: Run session tests and reopen the conversation file**

Run: `node --test ./test/api-conversation-store.test.js ./test/codex-session-store.test.js`

Expected: PASS, including fresh-instance reopen, crash normalization, credential-generation isolation, and legacy read-only labels.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/runtime/api/conversation-store.js src/adapters/runtime/codex/session-store.js test/api-conversation-store.test.js test/codex-session-store.test.js
git commit -m "Scope runtime sessions to verified profiles"
```

---

### Task 6: Project-tool bridge and built-in API agent runtime

**Files:**
- Create: `src/adapters/runtime/api/tool-bridge.js`
- Create: `src/adapters/runtime/api/agent-loop.js`
- Create: `src/adapters/runtime/api/index.js`
- Create: `test/api-agent-loop.test.js`
- Modify: `src/tools/tool-host.js`
- Modify: `src/tools/create-project-tooling.js`

**Interfaces:**
- Produces: `RuntimeToolBridge#listTools()`, `invoke({ call, context, signal })`.
- Produces: `runAgentTurn({ client, conversation, toolBridge, signal, emit, limits })`.
- Produces: `createApiRuntimeAdapter({ config, profile, secrets, projectToolHost, profileStore })` with the existing adapter methods.

- [ ] **Step 1: Write failing bounded-loop and approval tests**

```js
test("agent loop commits tool results and emits normalized lifecycle events", async () => {
  const events = [];
  const result = await runAgentTurn({ client: twoStepToolClient(), conversation: makeConversation(), toolBridge: echoToolBridge(), emit: (event) => events.push(event), limits: { maxToolSteps: 8, timeoutMs: 60_000 } });
  assert.equal(result.text, "finished");
  assert.deepEqual(events.map((event) => event.type), ["runtime.turn.started", "runtime.reply.delta", "runtime.reply.completed", "runtime.turn.completed"]);
});

test("agent loop aborts before a ninth tool step", async () => {
  await assert.rejects(runAgentTurn({ client: endlessToolClient(), toolBridge: echoToolBridge(), limits: { maxToolSteps: 8, timeoutMs: 60_000 } }), /TOOL_STEP_LIMIT/);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/api-agent-loop.test.js`

Expected: FAIL because the API runtime does not exist.

- [ ] **Step 3: Implement the common adapter contract**

```js
return {
  describe: () => ({ id: "builtin-api", profileId: profile.id, model: profile.modelId, provider: profile.providerId }),
  onEvent: (listener) => emitter.on("event", listener),
  getSessionStore: () => sessionStore,
  getTurnCapabilities: () => ({ nativeImageInput: verified.imageInput, toolImageRead: false }),
  initialize,
  close,
  sendTurn,
  sendTextTurn: sendTurn,
  cancelTurn,
  respondApproval,
  resumeThread,
  compactThread,
  startFreshThreadDraft,
};
```

Expose existing `ProjectToolHost` schemas without internal approval metadata. Preserve existing auto-approval behavior for CyberBoss-native project tools. Any tool marked `approval: "ask"` emits `runtime.approval.requested`, waits on a request-ID promise, and invokes only after `respondApproval`. Abort rejects every pending approval and marks the in-flight conversation turn aborted. Enforce eight tool steps, ten minutes overall, schema validation, and a 256 KiB serialized result limit.

On definitive 401/403 from the protocol client, call `profileStore.markUnverified(profile.id, "invalid_credentials")` before emitting `runtime.turn.failed`.

- [ ] **Step 4: Run agent/tool tests**

Run: `node --test ./test/api-agent-loop.test.js ./test/tool-host.test.js ./test/claudecode-approval.test.js`

Expected: PASS for streaming, tool continuation, approval, cancellation, limits, and unchanged existing project tools.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/runtime/api src/tools/tool-host.js src/tools/create-project-tooling.js test/api-agent-loop.test.js test/tool-host.test.js
git commit -m "Add built-in API agent runtime"
```

---

### Task 7: Managed and external OpenCode runtime

**Files:**
- Create: `src/adapters/runtime/opencode/client.js`
- Create: `src/adapters/runtime/opencode/index.js`
- Create: `test/opencode-runtime.test.js`

**Interfaces:**
- Produces: `OpenCodeClient#health()`, `listProviders()`, `createSession()`, `listMessages()`, `promptAsync()`, `abortSession()`, `respondPermission()`, `events()`.
- Produces: `createOpenCodeRuntimeAdapter({ config, profile, secrets, spawnImpl, fetchImpl })`.

- [ ] **Step 1: Write failing external/managed boundary tests**

```js
test("external opencode never writes provider auth", async () => {
  const requests = [];
  const adapter = createOpenCodeRuntimeAdapter(externalOptions({ requests }));
  await adapter.initialize();
  assert.equal(requests.some((request) => request.path.startsWith("/auth/")), false);
});

test("non-loopback plaintext external endpoint is rejected", async () => {
  await assert.rejects(createOpenCodeRuntimeAdapter(externalOptions({ endpoint: "http://192.168.1.10:4096" })).initialize(), /HTTPS|loopback/);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/opencode-runtime.test.js`

Expected: FAIL because the OpenCode adapter does not exist.

- [ ] **Step 3: Implement official HTTP/SSE mapping and process ownership**

Use `/global/health`, `/provider`, `/session`, `/session/:id/prompt_async`, `/session/:id/abort`, `/session/:id/permissions/:permissionID`, and `/event`. Basic Auth is built only from the external service username/password. Never call `/auth/:id` in External service mode.

Managed local spawns:

```js
spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: workspaceRoot,
  windowsHide: true,
  env: { ...sanitizedEnv, OPENCODE_CONFIG: isolatedConfigPath, OPENCODE_SERVER_PASSWORD: servicePassword },
  stdio: ["ignore", "pipe", "pipe"],
});
```

Write only non-secret config containing `{env:CYBERBOSS_OPENCODE_PROVIDER_KEY}` references into the isolated directory; inject decrypted provider values only into the owned process. Map SSE session/message/permission events to existing runtime events. Health response version participates in catalog invalidation.

- [ ] **Step 4: Run OpenCode tests**

Run: `node --test ./test/opencode-runtime.test.js`

Expected: PASS for health, forced external live provider listing, managed secret injection, no global-file mutation, session events, permission response, abort, endpoint security, and process exit.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/runtime/opencode test/opencode-runtime.test.js
git commit -m "Add optional OpenCode runtime"
```

---

### Task 8: Runtime factory, global profile resolution, and vision fallback

**Files:**
- Create: `src/adapters/runtime/factory.js`
- Create: `src/services/vision-fallback.js`
- Create: `test/runtime-factory.test.js`
- Create: `test/vision-fallback.test.js`
- Modify: `src/core/app.js`
- Modify: `src/core/command-registry.js`
- Modify: `src/services/vision-context.js`
- Modify: `src/core/thread-state-store.js`

**Interfaces:**
- Produces: `createRuntimeAdapter({ config, profileStore, vault, projectToolHost })`.
- Produces: `VisionFallback#describeAttachment({ attachment, parentTurn, signal })`.
- Changes: `/model` becomes inspect-only plus control-center guidance; no per-workspace model mutation.

- [ ] **Step 1: Write failing no-default/global-routing/vision tests**

```js
test("factory rejects an empty active profile", () => {
  assert.throws(() => createRuntimeAdapter({ profileStore: emptyProfileStore() }), /NO_ACTIVE_ENGINE/);
});

test("failed vision fallback preserves the attachment and skips the text model", async () => {
  const result = await fallback.describeAttachment({ attachment, parentTurn, signal: AbortSignal.timeout(1000) });
  assert.equal(result.ok, false);
  assert.equal(result.attachment.filePath, attachment.filePath);
  assert.equal(textRuntimeCalls.length, 0);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/runtime-factory.test.js ./test/vision-fallback.test.js`

Expected: FAIL because the strict factory and fallback do not exist.

- [ ] **Step 3: Replace `createRuntimeAdapter(config)` fallback and wire exact active scope**

Factory logic must be exhaustive:

```js
switch (profile.runtimeId) {
  case "builtin-api": return createApiRuntimeAdapter(options);
  case "opencode": return createOpenCodeRuntimeAdapter(options);
  case "codex": return createCodexRuntimeAdapter(withProfile(config, profile));
  case "claudecode": return createClaudeCodeRuntimeAdapter(withProfile(config, profile));
  default: throw runtimeError("INVALID_RUNTIME");
}
```

Construct project tooling before the adapter and inject `projectToolHost`. Every inbound/system/report/tool-triggered turn uses the active profile selected at app startup. Remove per-workspace model selection from `handleModelCommand`; `/model` reports the global profile and tells the user to switch in Control Center.

Vision fallback has a 30-second child timeout, one retry for transport/429 only, parent cancellation, separate profile usage attribution, no implicit substitute, and a user-facing image-processing error. Clear the reference when its profile is deleted.

- [ ] **Step 4: Run core and vision tests**

Run: `node --test ./test/runtime-factory.test.js ./test/vision-fallback.test.js ./test/codex-session-store.test.js ./test/stream-delivery.test.js`

Expected: PASS with no implicit Codex path and no legacy workspace model override.

- [ ] **Step 5: Commit**

```powershell
git add src/adapters/runtime/factory.js src/services/vision-fallback.js src/core/app.js src/core/command-registry.js src/services/vision-context.js src/core/thread-state-store.js test/runtime-factory.test.js test/vision-fallback.test.js
git commit -m "Route all turns through the active profile"
```

---

### Task 9: Bridge drain control and transactional runtime switching

**Files:**
- Create: `src/core/bridge-control-server.js`
- Create: `src/desktop/bridge-control-client.js`
- Create: `test/bridge-control.test.js`
- Create: `test/runtime-profile-switch.test.js`
- Modify: `src/core/app.js`
- Modify: `src/desktop/runtime-supervisor.js`
- Modify: `src/desktop/main.js`

**Interfaces:**
- Produces: authenticated `GET /health`, `POST /drain`, and `POST /abort` on loopback.
- Produces: `RuntimeSupervisor#switchProfile(profileId, { graceMs })`.
- Produces: `CyberbossApp#drainForSwitch({ deadlineAt })` and `abortActiveTurns(reason)`.

- [ ] **Step 1: Write failing gate, grace, and rollback tests**

```js
test("supervisor refuses Running without a verified active profile", async () => {
  await assert.rejects(supervisor.setDesiredState("running"), /NO_ACTIVE_ENGINE/);
  assert.equal(supervisor.snapshot().phase, "configuration_required");
});

test("failed new runtime restarts and probes the old runtime", async () => {
  await supervisor.switchProfile("new-profile", { graceMs: 120_000 });
  assert.deepEqual(calls, ["drain-old", "stop-old", "start-new", "probe-new", "restore-old-selection", "start-old", "probe-old", "resume-bridge"]);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/bridge-control.test.js ./test/runtime-profile-switch.test.js`

Expected: FAIL because bridge control and profile switching are absent.

- [ ] **Step 3: Implement authenticated loopback control and transaction states**

Pass a random `CYBERBOSS_BRIDGE_CONTROL_TOKEN` and reserved loopback port to the desktop-owned bridge. Reject missing token, non-loopback peers, oversized bodies, and unknown actions. Drain stops accepting new turns and waits for model streaming plus tools. At configured expiry, abort adapter turns, expire approvals, and continue only after cancellation acknowledgment. Return `{ draining, activeTurns, nonInterruptibleBoundary }` for responsive UI progress.

Refactor supervisor startup by `runtimeDefinition.processKind`; `builtin-api` skips App Server, `opencode` starts only managed OpenCode, `codex` retains App Server, and `claudecode` starts no Codex process. Implement a transaction journal with `oldProfileId`, `newProfileId`, and phase. Rollback restores selection, restarts/reconnects old runtime, probes it, and resumes bridge; rollback failure remains Error.

- [ ] **Step 4: Run supervisor/process tests**

Run: `node --test ./test/bridge-control.test.js ./test/runtime-profile-switch.test.js ./test/windows-process-host.test.js ./test/windows-task-service.test.js`

Expected: PASS for empty-engine gate, 30/120/600-second normalization, long tool abort, safety-boundary wait, startup matrix, successful switch, rollback restart, and rollback failure.

- [ ] **Step 5: Commit**

```powershell
git add src/core/bridge-control-server.js src/desktop/bridge-control-client.js src/core/app.js src/desktop/runtime-supervisor.js src/desktop/main.js test/bridge-control.test.js test/runtime-profile-switch.test.js
git commit -m "Switch runtime profiles transactionally"
```

---

### Task 10: Model settings service, secure IPC, and first-run UI

**Files:**
- Create: `src/desktop/model-settings-service.js`
- Create: `test/model-settings-service.test.js`
- Create: `test/desktop-model-ipc.test.js`
- Modify: `src/desktop/main.js`
- Modify: `src/desktop/preload.js`
- Modify: `src/desktop/renderer/index.html`
- Modify: `src/desktop/renderer/renderer.js`
- Modify: `src/desktop/renderer/styles.css`

**Interfaces:**
- Produces IPC: `desktop:list-runtime-options`, `desktop:list-profiles`, `desktop:save-profile`, `desktop:write-profile-secrets`, `desktop:refresh-models`, `desktop:test-profile`, `desktop:activate-profile`, `desktop:delete-profile`, `desktop:set-diagnostic-capture`.
- Renderer receives masked profiles and capability/error results only.

- [ ] **Step 1: Write failing service and IPC contract tests**

```js
test("renderer profile snapshot contains no secret material", async () => {
  const profiles = await service.listProfiles();
  const json = JSON.stringify(profiles);
  assert.equal(json.includes("sk-test-secret"), false);
  assert.equal(json.includes("ciphertext"), false);
  assert.equal(profiles[0].hasApiKey, true);
});

test("running controls stay disabled until activation", async () => {
  const snapshot = buildSnapshotWithNoProfile();
  assert.equal(snapshot.engine.configurationRequired, true);
  assert.equal(snapshot.engine.canRun, false);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/model-settings-service.test.js ./test/desktop-model-ipc.test.js`

Expected: FAIL because model settings APIs do not exist.

- [ ] **Step 3: Implement the wizard, profile cards, and dynamic Control card**

The service validates IPC input again in the main process, writes secrets through the vault, marks every secret write draft, refreshes catalogs, runs verifier, activates only matching fingerprints, and delegates running switches to `RuntimeSupervisor#switchProfile`.

Add a first-run panel shown when `configurationRequired`. Its ordered controls are runtime, ownership mode for OpenCode, provider, API Key/service password, Base URL, custom sensitive headers, model refresh/search/manual ID, test result, and activate. Use password inputs with `autocomplete="off"`; clear `.value` in `finally` after every submission.

Replace the static Agent card with:

```html
<article class="status-card">
  <span>模型引擎</span>
  <strong id="engine-name">尚未配置</strong>
  <small id="engine-detail">请先添加并验证 API</small>
</article>
```

Show switch progress and remaining grace time without freezing navigation. Label legacy read-only sessions in diagnostics. Add explicit diagnostic capture consent, duration, and delete controls.

- [ ] **Step 4: Run IPC tests and perform renderer syntax checks**

Run: `node --test ./test/model-settings-service.test.js ./test/desktop-model-ipc.test.js && node --check ./src/desktop/renderer/renderer.js && node --check ./src/desktop/preload.js`

Expected: PASS with no secret in snapshots and no enabled power/mode control before activation.

- [ ] **Step 5: Commit**

```powershell
git add src/desktop/model-settings-service.js src/desktop/main.js src/desktop/preload.js src/desktop/renderer test/model-settings-service.test.js test/desktop-model-ipc.test.js
git commit -m "Add model setup and switching UI"
```

---

### Task 11: Backup exclusion, documentation, full verification, and packaged artifact

**Files:**
- Modify: `src/services/backup-service.js`
- Modify: `test/backup-service.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`

**Interfaces:**
- Backup settings may include non-secret `provider-profiles.json`; vault and diagnostic capture files remain forbidden archive entries.
- Package scripts expose one complete multi-runtime test command.

- [ ] **Step 1: Extend failing backup/export inspection tests**

```js
test("settings export contains profiles but no vault or diagnostic capture", async () => {
  const result = await service.createBackup({ targetPath, classes: ["settings"] });
  assert.equal(fs.existsSync(targetPath), true);
  const entries = await reopenArchiveEntries(targetPath);
  assert.equal(entries.includes("provider-profiles.json"), true);
  assert.equal(entries.some((name) => /credential-vault|diagnostic-capture/i.test(name)), false);
  assert.equal((await readArchiveText(targetPath)).includes("sk-export-secret"), false);
});
```

- [ ] **Step 2: Run and confirm the new export assertion fails**

Run: `node --test ./test/backup-service.test.js`

Expected: FAIL because the non-secret profile file is not yet part of settings backup.

- [ ] **Step 3: Update backup allowlists, docs, and package checks**

Add `provider-profiles.json` to the settings class. Keep `credential-vault.json`, `diagnostic-capture.json`, generated OpenCode auth/config secrets, and decrypted traces outside `ALLOWED_TOP_LEVEL`. Restore profiles as drafts by clearing active ID, verification fingerprint, and capabilities during staged restore validation.

Document no-default first run, supported providers, OpenRouter, managed/external OpenCode, DPAPI scope, global selection, connection tests, visual fallback, `/model` behavior, and recovery errors in all three READMEs.

Install and pin the Windows packaging dependency:

```powershell
npm install --save-dev electron-builder
```

Add this Electron Builder configuration so the packaged executable starts the
desktop main process while the existing CommonJS package entry remains intact:

```json
"build": {
  "appId": "com.cyberboss.desktop",
  "productName": "CyberBoss",
  "directories": { "output": "dist" },
  "extraMetadata": { "main": "src/desktop/main.js" },
  "files": ["src/**/*", "bin/**/*", "native/**/*", "templates/**/*", "package.json"]
}
```

Add scripts:

```json
"test": "node --test ./test",
"desktop:package": "electron-builder --win dir",
"test:models": "node --test ./test/runtime-registry.test.js ./test/provider-profile-store.test.js ./test/credential-vault.test.js ./test/diagnostic-capture.test.js ./test/provider-catalog.test.js ./test/provider-protocols.test.js ./test/provider-verifier.test.js ./test/api-conversation-store.test.js ./test/api-agent-loop.test.js ./test/opencode-runtime.test.js ./test/runtime-factory.test.js ./test/model-settings-service.test.js ./test/bridge-control.test.js ./test/runtime-profile-switch.test.js ./test/vision-fallback.test.js ./test/desktop-model-ipc.test.js"
```

Extend `npm run check` with every new source file.

- [ ] **Step 4: Run the complete verification and physically inspect artifacts**

Run:

```powershell
npm run check
npm run test:models
npm test
npm run desktop:package
```

Then run a dedicated temporary-state smoke script through a package command, not an ad hoc in-memory assertion. It must:

1. create a synthetic profile and DPAPI vault entry;
2. assert both files exist;
3. construct fresh stores and reopen both;
4. confirm the secret decrypts only through the vault;
5. create a settings backup ZIP;
6. assert the ZIP exists and reopen its manifest and entries;
7. prove neither plaintext secret nor ciphertext is present;
8. run `npm run desktop:package`;
9. assert `dist/win-unpacked/CyberBoss.exe` exists, launch it with a temporary
   state directory in Stopped/configuration-required mode, reopen the generated
   state snapshot, close the process cleanly, and inspect packaged resources.

Expected: every command passes and the smoke output prints explicit
`exists=true`, `reopened=true`, `secretFree=true`, and `packaged=true` checks.

- [ ] **Step 5: Commit**

```powershell
git add src/services/backup-service.js test/backup-service.test.js package.json package-lock.json README.md README.zh-CN.md README.en.md
git commit -m "Verify API-first runtime release artifacts"
```

---

## Plan self-review checklist

- Every spec requirement for runtime registry, profiles, DPAPI, protocols, tools, sessions, OpenCode, switching, UI, diagnostics, vision, migration, backup, and final artifact reopening maps to a task above.
- No task permits an unknown runtime fallback or a renderer-visible secret.
- External OpenCode activation always bypasses cache and never mutates provider auth.
- The same `profileId/modelId/secretGeneration` scope is used by profile, conversation, runtime factory, and migration tasks.
- Runtime switch rollback explicitly restarts/reconnects and probes the old runtime.
- Final verification creates, reopens, and inspects real files and archives.
