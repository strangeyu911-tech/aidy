# CodeBuddy Runtime Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a managed-local `codebuddy` runtime that can reuse standalone CodeBuddy or WorkBuddy's bundled CodeBuddy CLI, expose the existing CyberBoss runtime contract through the documented public HTTP ACP surface, and provide safe discovery, login, verification, model, approval, cancellation, restart, and UI flows.

**Architecture:** Keep every Beta route, header, ACP method, CodeBuddy CLI flag, WorkBuddy installation path, and upstream response shape inside `src/adapters/runtime/codebuddy/`. The runtime adapter owns its hidden `--serve` child and translates it into the stable CyberBoss contract; the desktop layer only consumes sanitized discovery/login results and normalized runtime errors. Extend the shared session scope with a non-secret runtime identity fingerprint so sessions cannot cross CodeBuddy accounts.

**Tech Stack:** Node.js CommonJS, Electron IPC/renderer, built-in `fetch`, `node:test`, existing `AtomicJsonStore`, `CredentialVault`/Windows DPAPI, existing `SessionStore`, Windows `reg.exe`/`icacls.exe`, fake loopback HTTP/SSE servers for automated tests.

**Spec:** [2026-08-26-codebuddy-workbuddy-runtime-adapter-design.md](../specs/2026-08-26-codebuddy-workbuddy-runtime-adapter-design.md)

## Global Constraints

- Production code may use only documented public `/api/v1/*` routes. No `/internal/*`, WorkBuddy Electron IPC, daemon, sidecar, credential database, or `.workbuddy` file is in scope.
- Route strings, `X-CodeBuddy-Request`, ACP JSON-RPC method strings, gateway password configuration, `--serve` flags, and WorkBuddy installation knowledge stay under `src/adapters/runtime/codebuddy/`.
- The adapter must bind to `127.0.0.1`, keep password authentication enabled, and never put the service password in CLI arguments, renderer payloads, logs, diagnostics, backups, or exports.
- CodeBuddy's OS-user-level `.codebuddy` login is shared by all CodeBuddy profiles. Store only a SHA-256 identity fingerprint derived from the documented ACP `authenticate` response; never read credential files.
- Automated tests use injected fake processes and fake public HTTP/ACP servers. A real login or model turn is opt-in and must never run from `npm test` or CI by default.
- Every unknown permission shape is denied. Every missing required protocol field fails closed as `CODEBUDDY_API_INCOMPATIBLE`.
- A pending approval and an outstanding cancellation acknowledgement both count as in-flight. No automatic restart or turn replay is allowed while either exists.
- The adapter gets one automatic restart attempt per failure incident only when no work is in flight. The attempt repeats the complete compatibility and identity probe.
- Preserve unrelated files and existing runtime behavior. Do not modify `.superpowers/` or `scripts/cyberboss-background.ps1` unless a later explicit task asks for it.
- Each task starts with a failing focused test, implements only enough to pass, runs the focused test, then commits.

---

## Task 1: Register CodeBuddy and make account identity part of persisted runtime scope

**Files:**

- Modify: `src/core/runtime-registry.js`
- Modify: `src/core/provider-profile-store.js`
- Modify: `src/adapters/runtime/api/conversation-store.js`
- Modify: `src/adapters/runtime/codex/session-store.js`
- Modify: `test/runtime-registry.test.js`
- Modify: `test/provider-profile-store.test.js`
- Modify: `test/api-conversation-store.test.js`
- Modify: `test/codex-session-store.test.js`

**Interfaces:**

```js
ProviderProfileStore.prototype.markRuntimeProfilesUnverified = function markRuntimeProfilesUnverified(runtimeId, reason) {};

normalizeRuntimeScope({
  runtimeId,
  profileId,
  modelId,
  secretGeneration,
  runtimeIdentityFingerprint,
});
```

- [ ] Add a failing registry test asserting the exact immutable IDs are `builtin-api`, `opencode`, `codex`, `claudecode`, and `codebuddy`, and that CodeBuddy has `processKind: "codebuddy"` and display name `CodeBuddy`.
- [ ] Add a failing profile-store test that creates two CodeBuddy profiles and one Codex profile, activates one CodeBuddy profile, calls `markRuntimeProfilesUnverified("codebuddy", "account_identity_changed")`, and asserts only both CodeBuddy profiles become unverified and the active profile is cleared.
- [ ] Add failing session-scope tests proving the same binding/workspace/model/profile/generation with different `runtimeIdentityFingerprint` values cannot reuse a session, while existing runtimes with an empty fingerprint retain their current keys.
- [ ] Run the failing tests:

```powershell
node --test ./test/runtime-registry.test.js ./test/provider-profile-store.test.js ./test/api-conversation-store.test.js ./test/codex-session-store.test.js
```

Expected: failures for the missing runtime, bulk invalidation method, and identity-scope field.

- [ ] Add the declarative runtime entry:

```js
const RUNTIME_IDS = Object.freeze(["builtin-api", "opencode", "codex", "claudecode", "codebuddy"]);

Object.freeze({ id: "codebuddy", name: "CodeBuddy", processKind: "codebuddy" });
```

- [ ] Implement `markRuntimeProfilesUnverified` as one atomic store update. Normalize the runtime through `getRuntimeDefinition`, clear `verifiedFingerprint`, `capabilities`, `verifiedAt`, and matching `activeProfileId`, and leave other runtimes byte-for-byte equivalent after normalization.
- [ ] Extend `normalizeRuntimeScope`, `buildRuntimeScopeKey`, and `sameRuntimeScope` with `runtimeIdentityFingerprint`. Normalize it as a lowercase 64-hex SHA-256 string or `""`; include it in new keys without changing old empty-fingerprint semantics.
- [ ] Re-run the focused tests and confirm all pass.
- [ ] Commit:

```powershell
git add src/core/runtime-registry.js src/core/provider-profile-store.js src/adapters/runtime/api/conversation-store.js src/adapters/runtime/codex/session-store.js test/runtime-registry.test.js test/provider-profile-store.test.js test/api-conversation-store.test.js test/codex-session-store.test.js
git commit -m "feat: register CodeBuddy runtime identity"
```

---

## Task 2: Implement deterministic CodeBuddy/WorkBuddy distribution discovery

**Files:**

- Create: `src/adapters/runtime/codebuddy/distribution-locator.js`
- Create: `test/codebuddy-distribution-locator.test.js`

**Interfaces:**

```js
async function locateCodeBuddyDistribution({
  explicitExecutablePath = "",
  env = process.env,
  platform = process.platform,
  fsImpl,
  execFileImpl,
  queryWindowsInstallations,
} = {}) {}

async function probeCodeBuddyCandidate(candidate, { fsImpl, execFileImpl } = {}) {}
```

Successful result fields are `source`, `sourceLabel`, `version`, `executablePath`, `command`, `argsPrefix`, and `shell`.

- [ ] Write table-driven failing tests for this exact precedence: saved explicit path; `codebuddy` on `PATH`; `cbc` on `PATH`; registered WorkBuddy bundled CLI; known validated WorkBuddy installation path.
- [ ] Add failing cases for missing files, unreadable/replaced files, an unparseable version, help output without `--serve`, a WorkBuddy bundle whose node runner is missing, and all candidates failing with `CODEBUDDY_BINARY_NOT_FOUND`.
- [ ] Assert returned UI metadata contains only `source`, `sourceLabel`, `version`, and `executablePath`; it must not contain environment variables, registry dumps, full help output, or process output.
- [ ] Run `node --test ./test/codebuddy-distribution-locator.test.js`; expect module-not-found.
- [ ] Implement discovery with injected filesystem/process/registry dependencies. On Windows, query uninstall registration with `reg.exe` without PowerShell script interpolation, then validate candidate files under the resolved install location.
- [ ] Represent a bundled invocation explicitly:

```js
const distribution = Object.freeze({
  source: "workbuddy-bundled",
  sourceLabel: "WorkBuddy / CodeBuddy",
  version: "2.115.0",
  executablePath: cliEntryPath,
  command: bundledNodePath,
  argsPrefix: [cliEntryPath],
  shell: false,
});
```

- [ ] Reopen each candidate immediately before probing, call version/help with argument arrays and `shell: false`, cap captured output, and map errors to `CODEBUDDY_VERSION_UNREADABLE` or aggregate not-found.
- [ ] Export only locator/probe/sanitizer functions; keep registry keys and WorkBuddy path suffixes private to this file.
- [ ] Re-run the focused test and commit:

```powershell
git add src/adapters/runtime/codebuddy/distribution-locator.js test/codebuddy-distribution-locator.test.js
git commit -m "feat: discover CodeBuddy distributions"
```

---

## Task 3: Build the secure managed process host and overlay lifecycle

**Files:**

- Create: `src/adapters/runtime/codebuddy/process-host.js`
- Create: `test/codebuddy-process-host.test.js`

**Interfaces:**

```js
class CodeBuddyProcessHost {
  constructor({ stateDir, spawnImpl, fsImpl, netImpl, execFileImpl, inspectProcess, now, randomUUID, logger } = {}) {}
  async start({ distribution, workspaceRoot, servicePassword, mcpConfigPath, onExit } = {}) {}
  async stop() {}
  snapshot() {}
  async collectStaleOverlays() {}
}

function buildServeArguments({ port, overlayPath, mcpConfigPath }) {}
function redactProcessFailure(error) {}
```

- [ ] Write failing tests asserting the child invocation contains `--serve`, `--host 127.0.0.1`, `--port`, `--auth password`, an absolute `--settings` path, `--strict-mcp-config`, and an absolute `--mcp-config` path. Assert neither password nor inline JSON appears in arguments.
- [ ] Add tests for OS-assigned ephemeral port, startup timeout mapped to `CODEBUDDY_START_TIMEOUT`, early exit, confirmed address-in-use retry, non-address startup failure, exactly five allocation/bind-conflict attempts, and terminal `CODEBUDDY_PORT_UNAVAILABLE`.
- [ ] Add tests that a reservation is released only immediately before spawn and every retry uses a fresh port.
- [ ] Add overlay tests verifying `{"gateway":{"auth":"password","password":"test-only-password"}}` is written under `stateDir/codebuddy/runtime-overlays/<launchNonce>/settings.json`, reopened before spawn, protected with current-user-only ACL, retained while alive, and deleted only after confirmed exit or failed startup.
- [ ] Add stale-collection tests with PID, process creation time, executable path, and nonce. A live exact match survives; dead, reused-PID, wrong-executable, and wrong-creation-time records are deleted.
- [ ] Assert snapshots/logs never contain password, overlay body, inherited environment, auth header, or full command.
- [ ] Run `node --test ./test/codebuddy-process-host.test.js`; expect module-not-found.
- [ ] Implement the only production argument builder for managed serve:

```js
return [
  "--serve",
  "--host", "127.0.0.1",
  "--port", String(port),
  "--auth", "password",
  "--settings", path.resolve(overlayPath),
  "--strict-mcp-config",
  "--mcp-config", path.resolve(mcpConfigPath),
];
```

- [ ] Apply ACL before writing plaintext: remove inherited access and grant full control only to the current user SID. Treat ACL failure as startup failure.
- [ ] Write and reopen settings and launch journal atomically. Never delete early solely because `spawn()` returned.
- [ ] Detect address-in-use only from structured error or bounded tested output. Redact output before public error mapping.
- [ ] Stop only the exact owned child; on Windows verify recorded identity before forced tree termination.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/process-host.js test/codebuddy-process-host.test.js
git commit -m "feat: host managed CodeBuddy securely"
```

---

## Task 4: Encode the public Beta protocol behind one strategy

**Files:**

- Create: `src/adapters/runtime/codebuddy/protocol-adapter.js`
- Create: `test/codebuddy-protocol-adapter.test.js`

**Interfaces:**

```js
function createCodeBuddyProtocolStrategy({ version } = {}) {
  return {
    routes,
    encodeConnect,
    decodeConnect,
    encodeInitialize,
    encodeAuthenticate,
    decodeIdentity,
    encodeNewSession,
    encodeLoadSession,
    encodePrompt,
    encodeCancel,
    encodeApprovalResponse,
    decodeNotification,
    decodeCatalog,
    assertCapabilities,
  };
}

function fingerprintAccountIdentity(userInfo) {}
```

- [ ] Build fixture-based failing tests for documented public health, ACP connect, ACP SSE, ACP request, and disconnect shapes, including `_meta["codebuddy.ai/userinfo"]`.
- [ ] Add tests for additive unknown fields, missing `connectionId`, missing `sessionToken`, missing authenticated `userId`, malformed JSON-RPC IDs, absent cancel/permission capability, incomplete catalog, and future incompatible schema.
- [ ] Assert identity hashing uses a stable canonical documented identity object and never returns raw identity fields.
- [ ] Assert all routes start `/api/v1/` and `/internal/` is absent.
- [ ] Run `node --test ./test/codebuddy-protocol-adapter.test.js`; expect module-not-found.
- [ ] Define private frozen route/method maps here. Public HTTP routes are `/api/v1/health`, `/api/v1/auth/status`, `/api/v1/acp/connect`, and `/api/v1/acp`; ACP names are selected only by this versioned strategy.
- [ ] Normalize decoders to CyberBoss-owned records. Preserve bounded unknown diagnostics only under `vendor`; never pass raw responses to core/renderer.
- [ ] Return catalog state as:

```js
{
  models: normalizedModels,
  complete: catalogWasExplicitlyReported,
  source: catalogWasExplicitlyReported ? "codebuddy-acp" : "manual-required",
}
```

- [ ] Fail missing required capability with `CODEBUDDY_API_INCOMPATIBLE`, sanitized version, and failed capability; never guess fallback methods.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/protocol-adapter.js test/codebuddy-protocol-adapter.test.js
git commit -m "feat: isolate CodeBuddy public protocol"
```

---

## Task 5: Implement authenticated HTTP ACP and SSE correlation

**Files:**

- Create: `src/adapters/runtime/codebuddy/client.js`
- Create: `test/codebuddy-client.test.js`

**Interfaces:**

```js
class CodeBuddyClient {
  constructor({ endpoint, servicePassword, protocol, fetchImpl, now, randomUUID, setTimer, clearTimer } = {}) {}
  async health({ signal } = {}) {}
  async connect({ signal } = {}) {}
  async request(operation, payload, { signal, timeoutMs } = {}) {}
  subscribe(listener, { signal } = {}) {}
  async disconnect() {}
}
```

- [ ] Create a fake loopback server and failing tests for health, ACP connect, JSON-RPC request/response correlation, SSE framing across chunks, comments/heartbeats, multiple events in one chunk, disconnect, timeout, and abort.
- [ ] Assert every protected request includes exactly `X-CodeBuddy-Request: 1` and `Authorization: Bearer <password>`, while password never appears in URL or error text.
- [ ] Test `401`/`403` as `CODEBUDDY_AUTH_FAILED`, missing authenticated identity as `CODEBUDDY_LOGIN_REQUIRED`, incompatible envelopes as `CODEBUDDY_API_INCOMPATIBLE`, dropped transport as `CODEBUDDY_CONNECTION_LOST`, and cancel timeout as `CODEBUDDY_CANCEL_TIMEOUT`.
- [ ] Test a wrong JSON-RPC ID cannot settle another request and disconnect rejects all pending requests once.
- [ ] Run `node --test ./test/codebuddy-client.test.js`; expect module-not-found.
- [ ] Implement one bounded request helper with consistent abort propagation and sanitized errors. Never log headers or bodies.
- [ ] Subscribe to SSE before prompts. Carry `acp-connection-id` and session token only in headers selected by protocol strategy.
- [ ] Keep correlation maps inside client; expose normalized notifications, not `Response`, readers, or raw headers.
- [ ] Do not reconnect transparently while work is in flight; adapter coordinates the single restart.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/client.js test/codebuddy-client.test.js
git commit -m "feat: add CodeBuddy ACP client"
```

---

## Task 6: Normalize stream, tool, approval, usage, and terminal events

**Files:**

- Create: `src/adapters/runtime/codebuddy/events.js`
- Create: `test/codebuddy-events.test.js`

**Interfaces:**

```js
function mapCodeBuddyNotification(notification, context = {}) {}
function mapCodeBuddyFailure(error, context = {}) {}
function normalizeCodeBuddyUsage(value) {}
```

- [ ] Add failing fixtures for turn started, text delta, completed reply, tool started/completed, permission requested, usage, completion, cancellation, session failure mapped to `CODEBUDDY_SESSION_FAILED`, model rejection mapped to `CODEBUDDY_MODEL_UNAVAILABLE`, rate limit, and quota exhaustion.
- [ ] Assert mapped events use existing `runtime.*` names and correlated thread/turn/profile/tool/approval IDs.
- [ ] Assert unknown permission shapes return a denial instruction and never become approvable CyberBoss events.
- [ ] Assert only documented `inputTokens`/`outputTokens` populate generic `usage`; retain bounded upstream usage under `vendorUsage` with no WorkBuddy credit/promotion interpretation.
- [ ] Assert no session token, service password, auth header, raw identity, or full upstream error enters event payloads.
- [ ] Run `node --test ./test/codebuddy-events.test.js`; expect module-not-found.
- [ ] Implement pure mapping functions with no HTTP/process/filesystem/profile-store dependency.
- [ ] Map unknown failures to `CODEBUDDY_TURN_FAILED`; preserve only explicitly tested stable codes.
- [ ] Return arrays when one upstream notification maps to final reply plus terminal completion.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/events.js test/codebuddy-events.test.js
git commit -m "feat: normalize CodeBuddy runtime events"
```

---

## Task 7: Implement the stable runtime contract and failure policy

**Files:**

- Create: `src/adapters/runtime/codebuddy/index.js`
- Create: `test/codebuddy-runtime.test.js`
- Modify: `src/core/thread-state-store.js`
- Modify: `test/thread-state-store.test.js`

**Interfaces:**

```js
function createCodeBuddyRuntimeAdapter({
  config,
  profile,
  secrets,
  projectToolHost,
  profileStore,
  locator,
  processHostFactory,
  clientFactory,
  protocolFactory,
  now,
  randomUUID,
} = {}) {}
```

Required adapter methods:

```js
[
  "describe", "onEvent", "getSessionStore", "getTurnCapabilities",
  "initialize", "close", "startFreshThreadDraft", "sendTurn",
  "sendTextTurn", "resumeThread", "compactThread",
  "refreshThreadInstructions", "respondApproval", "cancelTurn",
]
```

- [ ] Build a fake dependency harness. Assert full contract, sanitized `describe`, and `initialize` order: discovery, process start, health, gateway auth, ACP connect, ACP initialize, authenticate/identity, SSE subscription, no-model session/capability probe, catalog.
- [ ] Test startup, activation, and every new-turn boundary compare live account fingerprint with `profile.capabilities.accountIdentityFingerprint`. Missing/changed identity invalidates all CodeBuddy profiles and blocks new turns.
- [ ] Test scope includes runtime ID, profile ID, model ID, secret generation, account fingerprint, binding, and workspace. Resume failure clears only the exact mapping and creates a fresh session without upstream deletion.
- [ ] Test first-turn opening instructions, ordinary turn, attachment, instruction refresh, model unavailable, and manual-model verification.
- [ ] Test cancellation requires correlated acknowledgement and times out as `CODEBUDDY_CANCEL_TIMEOUT`.
- [ ] Test approval accept/decline, pending approval as in-flight, process exit expiration/removal, tombstoned later response returning `CODEBUDDY_APPROVAL_EXPIRED`, and user text `请求已过期，模型服务已退出`.
- [ ] Test supported compaction invokes only documented compact operation. Unsupported compaction rejects `CODEBUDDY_COMPACTION_UNSUPPORTED`, keeps mapping, and never calls `sendTurn` or sends a fake prompt.
- [ ] Test process exit during active work fails but never replays. Idle exit gets exactly one automatic restart with full probe; pending approval, cancel acknowledgement, or failed restart disables automatic restart loops.
- [ ] Test terminal expiration clears thread state's pending approval and cannot leave `waiting_approval`.
- [ ] Run `node --test ./test/codebuddy-runtime.test.js ./test/thread-state-store.test.js`; expect missing adapter and expiration failures.
- [ ] Construct `SessionStore` with runtime ID `codebuddy` and exact scope:

```js
function runtimeScope() {
  return {
    runtimeId: "codebuddy",
    profileId: normalizedProfile.id,
    modelId: normalizedProfile.modelId,
    secretGeneration: normalizedProfile.secretGeneration,
    runtimeIdentityFingerprint: verifiedIdentityFingerprint,
  };
}
```

- [ ] Build a strict MCP JSON file inside the per-launch overlay directory. In normal mode it invokes `process.execPath` with `bin/cyberboss.js tool-mcp-server --runtime-id codebuddy`; in verification mode it contains only `config.verification.mcpServer`. Reopen/validate the file before passing its absolute path to `process-host`, and delete it with the overlay lifecycle.
- [ ] Track `activeTurns`, `pendingApprovals`, `expiredApprovalIds`, and `pendingCancelAcks` separately. Finish a turn only after its correlated terminal event.
- [ ] On unexpected exit, emit `runtime.approval.expired` for every pending request and correlated `runtime.turn.failed` with `CODEBUDDY_APPROVAL_EXPIRED`, then clear response maps. Extend `ThreadStateStore` for expiration.
- [ ] Implement restart with incident generation plus `restartAttempted`; reset only after later successful user-initiated boundary, not its own failure.
- [ ] Keep `vendorUsage` as terminal metadata; pass only documented generic tokens to usage accumulator.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/index.js src/core/thread-state-store.js test/codebuddy-runtime.test.js test/thread-state-store.test.js
git commit -m "feat: implement CodeBuddy runtime adapter"
```

---

## Task 8: Wire factory, catalog, vault secret, and live verification

**Files:**

- Modify: `src/adapters/runtime/factory.js`
- Modify: `src/desktop/runtime-profile-verifier.js`
- Modify: `src/desktop/main.js`
- Modify: `src/desktop/model-settings-service.js`
- Modify: `test/runtime-factory.test.js`
- Modify: `test/runtime-profile-verifier.test.js`
- Modify: `test/model-settings-service.test.js`

**Interfaces:**

```js
DEFAULT_ADAPTER_FACTORIES.codebuddy = (options) => createCodeBuddyRuntimeAdapter(options);

async function listCodeBuddyCatalog(profile, secrets, options = {}) {}
```

- [ ] Update exhaustive factory test for all five runtimes. Assert CodeBuddy receives exact profile, service password, profile store, project tool host, state/session paths, and model.
- [ ] Add verifier test: CodeBuddy uses dedicated Echo MCP server, performs real stream/tool/result/continuation/cancel sequence, and persists account fingerprint plus compatibility capabilities.
- [ ] Add service tests for managed-local validation, compatibility provider, optional executable path in `options`, manual model when catalog incomplete, invalid model blocking activation, and disappeared verified model becoming unverified.
- [ ] Test first CodeBuddy draft generates a random service password in `CredentialVault`, later edits preserve it, and snapshots never return it.
- [ ] Test public guidance for all CodeBuddy design errors, especially binary/login/API/port/model/approval/cancel/compaction codes.
- [ ] Run `node --test ./test/runtime-factory.test.js ./test/runtime-profile-verifier.test.js ./test/model-settings-service.test.js`; expect unsupported runtime/factory/catalog/guidance failures.
- [ ] Register the adapter in global and verification factories. Add `codebuddyModel` to `withProfile` without changing Codex/Claude fields.
- [ ] Add `codebuddy` to verifier support. Pass verification MCP through `config.verification` and isolated state/session paths.
- [ ] Route catalog refresh through a temporary adapter:

```js
async function listCodeBuddyCatalog(profile, secrets, options = {}) {
  const adapter = createCodeBuddyRuntimeAdapter({
    config: { ...config, stateDir, workspaceRoot: rootDir },
    profile,
    secrets,
    profileStore,
  });
  try {
    return await adapter.listCatalog({ reason: options.reason || "display" });
  } finally {
    await adapter.close();
  }
}
```

- [ ] Sanitize catalog fields `complete` and `manualModelAllowed`. Keep OpenCode/OpenRouter strict behavior; incomplete CodeBuddy catalog requires successful real verification.
- [ ] Generate gateway password with `crypto.randomBytes(24).toString("base64url")` in trusted service layer, write it as vault `servicePassword`, expose only `hasServicePassword`.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/factory.js src/desktop/runtime-profile-verifier.js src/desktop/main.js src/desktop/model-settings-service.js test/runtime-factory.test.js test/runtime-profile-verifier.test.js test/model-settings-service.test.js
git commit -m "feat: verify CodeBuddy profiles"
```

---

## Task 9: Add the explicit interactive login workflow

**Files:**

- Create: `src/adapters/runtime/codebuddy/login.js`
- Create: `src/desktop/codebuddy-login-service.js`
- Create: `test/codebuddy-login.test.js`
- Modify: `src/desktop/main.js`
- Modify: `src/desktop/model-settings-service.js`
- Modify: `src/desktop/preload.js`
- Modify: `test/desktop-model-ipc.test.js`

**Interfaces:**

```js
async function launchCodeBuddyInteractiveLogin({ distribution, spawnImpl, platform } = {}) {}

class CodeBuddyLoginService {
  constructor({ stateDir, profileStore, credentialVault, locateDistribution, launchInteractiveLogin, probeLogin } = {}) {}
  async discover(profileId) {}
  async launch(profileId) {}
  async verify(profileId) {}
}
```

New trusted preload methods are `discoverCodeBuddy(profileId)`, `loginCodeBuddy(profileId)`, and `verifyCodeBuddyLogin(profileId)`.

- [ ] Write failing tests that validated distribution opens a visible interactive terminal, sends no secret/token in arguments, and treats close/exit as a trigger for one final public identity probe—not proof of login.
- [ ] Test manual close, abandoned login, failed probe, changed account, and success. Failure keeps draft and returns `CODEBUDDY_LOGIN_REQUIRED`.
- [ ] Assert launch never polls `.codebuddy`, inspects `.workbuddy`, copies credentials, or consumes a model turn.
- [ ] Add IPC allowlist/trusted-origin/payload-size tests for all three methods.
- [ ] Run `node --test ./test/codebuddy-login.test.js ./test/desktop-model-ipc.test.js`; expect missing service/routes.
- [ ] Keep invocation details in adapter `login.js`. Windows terminal uses `windowsHide: false` because it is interactive; managed serve stays hidden.
- [ ] Return only sanitized discovery/login state:

```js
{
  found: true,
  source: "workbuddy-bundled",
  sourceLabel: "WorkBuddy / CodeBuddy",
  version: "2.115.0",
  executablePath: "C:\\validated\\codebuddy",
  loginState: "required",
}
```

- [ ] Store only account fingerprint through normal runtime verification; never send identity fields to renderer.
- [ ] Register IPC through the existing trusted top-frame/origin gate and frozen preload API.
- [ ] Re-run focused tests and commit:

```powershell
git add src/adapters/runtime/codebuddy/login.js src/desktop/codebuddy-login-service.js src/desktop/main.js src/desktop/model-settings-service.js src/desktop/preload.js test/codebuddy-login.test.js test/desktop-model-ipc.test.js
git commit -m "feat: add CodeBuddy login workflow"
```

---

## Task 10: Add the non-technical WorkBuddy/CodeBuddy control-center experience

**Files:**

- Modify: `src/desktop/renderer/index.html`
- Modify: `src/desktop/renderer/renderer.js`
- Modify: `src/desktop/renderer/styles.css`
- Create: `test/codebuddy-control-center.test.js`

- [ ] Write failing DOM/source tests for discovery result, optional explicit path, re-scan, shared-login warning, Login CodeBuddy, Verify Login, source/version, manual-model help, Beta guidance, and absence of password/token fields.
- [ ] Add pure presenter or renderer tests for `not-found`, `login-required`, `logged-in-unverified`, `manual-model-invalid`, `verified`, and `incompatible` states.
- [ ] Assert labels are `WorkBuddy / CodeBuddy` for bundled and `CodeBuddy` for standalone; runtime ID remains `codebuddy`.
- [ ] Assert expired approval displays `请求已过期，模型服务已退出`, failures keep activation disabled, and UI never promises shared WorkBuddy promotion/quota.
- [ ] Run `node --test ./test/codebuddy-control-center.test.js`; expect missing controls/presenter.
- [ ] Add CodeBuddy rows/notices hidden for other runtimes; preserve existing layouts.
- [ ] Update `renderProfileFields`: compatibility provider; hide API key/custom headers/base URL/service password; show discovery/login controls; allow manual model only for incomplete catalog.
- [ ] Render these exact constraints:

```text
CodeBuddy 登录属于当前 Windows 用户；所有 CyberBoss CodeBuddy 配置共享同一个账号。你在外部登录、退出或切换账号后，需要重新验证这些配置。

CodeBuddy 的 HTTP API 目前为 Beta。上游升级可能暂时造成不兼容；CyberBoss 不会尝试内部接口或猜测降级。

CyberBoss 只展示 CodeBuddy 返回的用量信息，不合并或推断 WorkBuddy 活动额度。
```

- [ ] Re-scan discovers without credential writes. Login leaves visible Verify Login action regardless of terminal exit.
- [ ] Re-run focused test and commit:

```powershell
git add src/desktop/renderer/index.html src/desktop/renderer/renderer.js src/desktop/renderer/styles.css test/codebuddy-control-center.test.js
git commit -m "feat: add CodeBuddy setup experience"
```

---

## Task 11: Enforce boundaries, backup exclusions, and opt-in live smoke

**Files:**

- Create: `test/codebuddy-boundary.test.js`
- Modify: `test/backup-service.test.js`
- Create: `scripts/codebuddy-live-smoke.js`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-08-26-codebuddy-workbuddy-runtime-adapter-design.md`

- [ ] Add a failing scan of `src/` production JavaScript allowing Beta strings only under `src/adapters/runtime/codebuddy/`. Outside that adapter reject `/api/v1/acp`, `/internal/`, `X-CodeBuddy-Request`, ACP method literals, CodeBuddy `--serve`, WorkBuddy install suffixes, `CODEBUDDY_GATEWAY_PASSWORD`, and `gateway.password`; documentation and test fixtures are intentionally outside this scan.
- [ ] Recursively fail if `/internal/` appears anywhere in adapter source, including fallback/error branches.
- [ ] Extend backup tests with synthetic overlay password, auth header, account identity, launch journal, MCP config, and token. Assert none enters archive; sanitized profile source/version may remain.
- [ ] Assert smoke script exits without side effects unless `CYBERBOSS_CODEBUDDY_LIVE_SMOKE=1`; a real turn also requires `CYBERBOSS_CODEBUDDY_LIVE_TURN=1`.
- [ ] Run `node --test ./test/codebuddy-boundary.test.js ./test/backup-service.test.js`; expect missing enforcement/script entries.
- [ ] Implement smoke phases: discover/reopen executable; managed service plus full no-model ACP/identity probe; optional real verification turn. Always close and reopen the smoke report before success.
- [ ] Add package scripts:

```json
{
  "test:codebuddy": "node --test ./test/codebuddy-distribution-locator.test.js ./test/codebuddy-process-host.test.js ./test/codebuddy-protocol-adapter.test.js ./test/codebuddy-client.test.js ./test/codebuddy-events.test.js ./test/codebuddy-runtime.test.js ./test/codebuddy-login.test.js ./test/codebuddy-control-center.test.js ./test/codebuddy-boundary.test.js",
  "smoke:codebuddy": "node ./scripts/codebuddy-live-smoke.js"
}
```

- [ ] Add every production JS file to `npm run check`, focused tests to `test:models`, and never enable live smoke by default.
- [ ] Append Rollout/Risk statement: breaking Beta release may invalidate all CodeBuddy profiles; OS-user login is global; process death expires approvals; no private fallback/per-profile account isolation.
- [ ] Re-run focused tests and `npm run check`, then commit:

```powershell
git add test/codebuddy-boundary.test.js test/backup-service.test.js scripts/codebuddy-live-smoke.js package.json docs/superpowers/specs/2026-08-26-codebuddy-workbuddy-runtime-adapter-design.md
git commit -m "test: enforce CodeBuddy runtime boundary"
```

---

## Task 12: Run full regression, packaged-app smoke, and artifact verification

**Files:** Modify only if regression exposes a CodeBuddy-scoped defect. Do not commit generated `dist/`, overlays, smoke reports, credentials, or runtime state.

- [ ] Confirm no unexpected changes with `git status --short`.
- [ ] Run focused coverage: `npm run test:codebuddy`.
- [ ] Run syntax and full suite: `npm run check` then `npm test`.
- [ ] Build unpacked/portable Windows app with repository build command and existing artifact smoke. Do not run live model turn without both explicit opt-ins.
- [ ] Verify output exists and enumerate/reopen artifact paths:

```powershell
Test-Path -LiteralPath '.\dist'
Get-ChildItem -LiteralPath '.\dist' -Recurse -File | Where-Object { $_.Name -match 'CyberBoss|codebuddy' } | Select-Object -ExpandProperty FullName
```

- [ ] Confirm package contains all seven adapter files plus `codebuddy-login-service.js`.
- [ ] Search repository/package for leaked synthetic/real secrets and forbidden internal routes; investigate every match.
- [ ] Reopen plan and spec:

```powershell
Get-Content -Raw -LiteralPath '.\docs\superpowers\plans\2026-08-26-codebuddy-runtime-adapter-implementation.md' | Out-Null
Get-Content -Raw -LiteralPath '.\docs\superpowers\specs\2026-08-26-codebuddy-workbuddy-runtime-adapter-design.md' | Out-Null
```

- [ ] Review every design error code against implementation/tests; confirm no untested fallback, replay, account crossing, or approval resurrection.
- [ ] Commit only genuine focused fixes, one defect per commit.
- [ ] Handoff evidence: focused/full/syntax/package results, reopened artifact paths, live smoke status (`not run`, `probe only`, or `probe + verification turn`), and unchanged unrelated files.

## Final self-review checklist

- [ ] Every Beta protocol/distribution detail is confined to `src/adapters/runtime/codebuddy/`.
- [ ] All 14 stable `CODEBUDDY_*` design errors have a producer, user guidance, and focused test.
- [ ] Global login sharing, identity invalidation, session isolation, manual model verification, overlay lifetime, five port retries, one idle restart, approval expiration, unsupported compaction, and raw `vendorUsage` each have explicit tests.
- [ ] No placeholder implementation, private endpoint, unbounded capture, credential copy, or automatic quota-consuming call exists in the plan.
- [ ] Function names and records are consistent across locator, host, protocol, client, adapter, verifier, services, and renderer.
- [ ] Existing runtimes retain current factory, verification, catalog, session, and UI behavior.
- [ ] Plan file exists, can be reopened, and is committed separately from implementation.
