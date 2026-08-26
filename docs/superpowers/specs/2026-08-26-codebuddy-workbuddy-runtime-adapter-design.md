# CyberBoss CodeBuddy / WorkBuddy Runtime Adapter Design

## Context

CyberBoss already routes model turns through a runtime registry and supports
`builtin-api`, `opencode`, `codex`, and `claudecode`. The local WorkBuddy 5.3.14
installation includes CodeBuddy Code 2.115.0 under its application resources.
That bundled CLI exposes `--serve`, ACP, headless JSON output, model selection,
session control, and permission modes, but invoking it directly uses a separate
`.codebuddy` state directory rather than silently inheriting `.workbuddy`
credentials.

The official WorkBuddy HTTP API page labels the API as Beta and warns that
interfaces may change. It distinguishes public REST routes under `/api/v1/*`,
public ACP under `/api/v1/acp`, and unsupported internal routes under
`/internal/*`. CyberBoss must therefore isolate every WorkBuddy/CodeBuddy
protocol detail behind one runtime adapter so that a future API change does not
spread into the core, desktop supervisor, channel adapters, or services.

This isolation limits the repair surface but cannot guarantee availability.
A breaking upstream release may put every CodeBuddy profile into
`CODEBUDDY_API_INCOMPATIBLE` until CyberBoss gains a compatible protocol
strategy or the user selects a compatible CodeBuddy/WorkBuddy release. The
product explicitly accepts this runtime-specific outage rather than attempting
unsafe downgrade guesses or private API fallbacks.

References:

- <https://www.workbuddy.ai/docs/cli/http-api>
- <https://www.codebuddy.ai/docs/cli/acp>
- <https://www.codebuddy.ai/docs/cli/cli-reference>

## Goals

- Add CodeBuddy as an explicit fifth runtime without changing existing runtime
  behavior.
- Reuse a standalone CodeBuddy installation or the CLI bundled with WorkBuddy.
- Require one explicit CodeBuddy login with the user's chosen Tencent account;
  never copy or reverse-engineer WorkBuddy credentials.
- Run a CyberBoss-owned, loopback-only CodeBuddy service and communicate through
  the public HTTP ACP surface.
- Contain all Beta routes, request fields, response fields, compatibility
  shims, and event mapping inside the CodeBuddy runtime adapter.
- Preserve CyberBoss session isolation, streaming, cancellation, approval,
  instruction refresh, model selection, verification, and profile switching.
- Detect incompatible CodeBuddy releases before activation and fail with an
  actionable error instead of silently falling back to an internal API.
- Protect the local service with password authentication and the official
  `X-CodeBuddy-Request: 1` request header.

## Non-goals

- Calling WorkBuddy Electron, daemon, sidecar, or `/internal/*` endpoints.
- Reading `.workbuddy` authentication files, tokens, databases, or private IPC.
- Proving that a WorkBuddy promotion or free-credit campaign is shared with
  CodeBuddy before a live authenticated usage check succeeds.
- Supporting a different CodeBuddy login account per CyberBoss profile. All
  CodeBuddy profiles for one operating-system user share that user's global
  `.codebuddy` login state in this release.
- Installing or updating CodeBuddy automatically.
- Supporting a remote or user-managed CodeBuddy HTTP endpoint in this release.
- Falling back to one-process-per-turn `--print --output-format stream-json` in
  production.
- Refactoring the existing OpenCode, built-in API, Codex, or Claude Code
  adapters beyond the registry and factory additions required for CodeBuddy.

## Product decisions

### Runtime identity and naming

The internal runtime ID is `codebuddy`, and the implementation lives under
`src/adapters/runtime/codebuddy/`. The control center displays
“WorkBuddy / CodeBuddy” when the executable source is WorkBuddy and “CodeBuddy”
for a standalone installation. Core code never branches on the WorkBuddy
distribution name.

The factory exports `createCodeBuddyRuntimeAdapter`. A small distribution
locator inside the adapter recognizes WorkBuddy only as one source of the
public CodeBuddy CLI. This avoids introducing a misleading API-provider preset
or a second runtime with identical protocol behavior.

This adapter directory is the requested `WorkBuddyProvider/Runtime Adapter`
boundary: “WorkBuddyProvider” describes the product-facing integration, while
`codebuddy` remains the canonical runtime ID because the supported public
protocol and executable are CodeBuddy Code. The naming distinction never
creates two implementations.

### Explicit login boundary

CyberBoss provides a “登录 CodeBuddy” action that launches the detected CLI in
an interactive terminal. The user logs in once with the desired account. The
login belongs to CodeBuddy's own `.codebuddy` state. CyberBoss observes only a
documented authenticated identity or a not-authenticated result from a live
public probe; it never reads, exports, logs, backs up, or migrates the
credential.

The login terminal closing is not proof of success. The setup screen tells the
user to return and select “验证登录” after completing or abandoning the terminal
flow. That action starts a temporary managed public service and performs one
documented ACP authentication/identity probe. Terminal exit triggers the same
single final probe for convenience, but CyberBoss does not poll credential
files or repeatedly spend model quota. A failed, cancelled, or closed login
returns the UI to `CODEBUDDY_LOGIN_REQUIRED` and leaves the draft profile saved.

Important implicit constraint: CodeBuddy credentials are global to the current
operating-system user, not scoped to a CyberBoss profile. Every `codebuddy`
profile shares the same `.codebuddy` account. Logging in, logging out, or
switching accounts from any CodeBuddy CLI process or another application
configured to use the same `.codebuddy` state may affect all of those profiles.
The adapter stores the non-secret account identity from the documented ACP
authentication response as a one-way verification fingerprint. Startup,
activation, and the boundary before a new turn compare the current identity
with that fingerprint. A missing or changed identity invalidates all mismatched
CodeBuddy profiles and requires explicit reverification; CyberBoss cannot
isolate or restore the previous account.

Using the same Tencent account as WorkBuddy is recommended, but quota sharing is
reported only after the first successful model call and usage response. The UI
does not promise that a specific WorkBuddy promotion applies to CodeBuddy.

### Managed local only

The first release supports only a CyberBoss-owned child process bound to
`127.0.0.1` on a dynamically reserved port. CyberBoss stops only the child it
started. It never attaches to or terminates WorkBuddy Desktop, WorkBuddy
sidecars, or unrelated CodeBuddy processes.

The process host asks the operating system for an ephemeral loopback port,
releases the reservation immediately before spawning CodeBuddy, and treats the
remaining bind race as recoverable. It retries with a new port at most five
times only when startup evidence identifies an address-in-use failure. Other
startup failures are not mislabeled as conflicts. Failure to obtain an
ephemeral candidate counts as an attempt; five allocation or confirmed bind
conflicts produce `CODEBUDDY_PORT_UNAVAILABLE` and require Retry or profile
reactivation.

Remote and externally managed endpoints are deferred until the local adapter is
stable. This keeps the Beta compatibility and security surface small.

## Architecture

### Stable core boundary

The runtime registry adds one declarative `codebuddy` entry. The runtime factory
constructs the adapter from the active profile and secrets. All other core code
uses the existing runtime contract:

- `describe()`
- `onEvent(listener)`
- `getSessionStore()`
- `getTurnCapabilities()`
- `initialize()` and `close()`
- `startFreshThreadDraft()`
- `sendTurn()` and `sendTextTurn()`
- `resumeThread()` and `compactThread()`
- `refreshThreadInstructions()`
- `respondApproval()`
- `cancelTurn()`

No CodeBuddy route, JSON-RPC method, SSE field, WorkBuddy path, or CLI flag may
appear in `src/core/*`, channel adapters, generic services, or the desktop
supervisor.

### Adapter components

`src/adapters/runtime/codebuddy/` contains focused units:

- `index.js`: implements the stable CyberBoss runtime contract and owns session
  orchestration.
- `distribution-locator.js`: resolves an explicit command, `codebuddy`/`cbc` on
  `PATH`, then a WorkBuddy-bundled CLI discovered from the Windows uninstall
  registration and validated installation paths.
- `process-host.js`: starts, monitors, and stops only the managed
  `codebuddy --serve` child process.
- `client.js`: owns HTTP authentication, ACP connect/disconnect, JSON-RPC
  requests, SSE subscription, timeouts, and cancellation.
- `protocol-adapter.js`: contains public route constants, capability probes,
  request encoding, response decoding, and normalized event mapping for the
  currently supported Beta protocol shape.
- `events.js`: maps protocol-neutral adapter events into CyberBoss runtime
  events.

If a future release changes public routes or schemas, a new protocol strategy
is added behind `protocol-adapter.js`. The runtime contract and core callers do
not change.

### Executable discovery and compatibility

Discovery order is deterministic:

1. an explicit executable path saved in the profile;
2. `codebuddy` or `cbc` found on `PATH`;
3. the CodeBuddy CLI bundled with a registered WorkBuddy installation.

Every candidate must exist, be reopenable, report a parseable version, advertise
`--serve`, and pass live public-surface probes. WorkBuddy's currently observed
2.115.0 bundle is a candidate, not a declared-compatible version until its
actual `--serve` and ACP handshake pass.

Compatibility is capability-based rather than version-only. Initialization
checks:

1. `GET /api/v1/health` succeeds;
2. authentication is enforced and CyberBoss credentials work;
3. `/api/v1/acp/connect` establishes a connection;
4. ACP initialize and session creation succeed;
5. an SSE subscription receives a correlated notification;
6. prompt, cancellation, and permission capabilities are present.

The optional public OpenAPI document may improve diagnostics, but it is not the
sole compatibility test. Missing required capabilities produce
`CODEBUDDY_API_INCOMPATIBLE`; CyberBoss never tries `/internal/*` or guesses a
replacement route.

### Process and authentication security

The process binds only to `127.0.0.1`. Authentication remains enabled. A random
service password is generated for the managed instance and stored through the
existing DPAPI vault. CyberBoss supplies a minimal CodeBuddy settings overlay
for gateway authentication without modifying `.workbuddy` or copying login
credentials. The overlay is passed as an absolute file path through the
documented `--settings <file>` CLI option; inline JSON and passwords on the
process command line are prohibited.

Because the public interface does not guarantee a one-time “settings fully
loaded and never reread” event, CyberBoss does not guess an early deletion
moment. A fresh per-launch overlay directory is created with a current-user-only
ACL, retained only for the owned child's lifetime, and deleted after confirmed
process exit or failed startup. Startup garbage collection removes a stale
overlay only after its launch journal's PID, process creation time, executable
path, and launch nonce do not match a live owned process. The directory is
excluded from logs, diagnostics, backups, exports, and packaged artifacts. The
DPAPI vault remains the durable secret source; the ACL-protected plaintext
overlay is an acknowledged runtime-only exposure while the child is alive.

Every protected request includes:

- `X-CodeBuddy-Request: 1`
- `Authorization: Bearer <service-password>`

The password, headers, login data, and full process command are excluded from
renderer snapshots, normal logs, diagnostics, backups, and exports. The
adapter's `describe()` result contains only endpoint, version, executable
source, model, and health metadata.

### Data flow

1. The desktop supervisor resolves the active `codebuddy` profile.
2. The adapter locates and probes the executable.
3. If CodeBuddy login is absent, activation stops with `CODEBUDDY_LOGIN_REQUIRED`
   and offers the login action.
4. The process host starts the loopback service and waits for health.
5. The client authenticates, opens ACP, and subscribes to SSE before a prompt is
   sent.
6. `sendTurn()` creates or restores a CodeBuddy session scoped to the exact
   profile, credential generation, model, binding, and workspace.
7. The protocol adapter converts ACP updates into normalized streaming, tool,
   approval, usage, completion, failure, and session events.
8. CyberBoss channel and supervision code consume those normalized events
   without knowing that CodeBuddy is the runtime.

First-turn instructions continue to use CyberBoss's shared opening instruction
builder. Instruction refresh sends a normal correlated turn. Compaction uses a
documented ACP capability or slash command only when the compatibility probe
confirms support; otherwise the adapter reports compaction as unsupported
without affecting ordinary turns. Specifically, `compactThread()` rejects with
`CODEBUDDY_COMPACTION_UNSUPPORTED`; the caller keeps the original thread and
session mapping, does not call `sendTurn()`, and does not synthesize a compact
prompt. If context exhaustion makes compaction mandatory, the user receives an
actionable error and may start a fresh thread; ordinary turns are never
misreported as compaction.

### Sessions, models, tools, and approvals

Session IDs remain in the existing session store under runtime ID `codebuddy`.
They are never reused across different profile IDs, credential generations,
account-identity fingerprints, models, or workspaces. Resume failure clears
only the affected CodeBuddy
binding and creates a fresh session with opening instructions. “Affected
binding” means the exact persisted session-ID mapping in the existing session
store for the current profile, credential generation, model, binding key, and
workspace. The adapter removes that mapping and its in-memory handle but does
not delete the old CodeBuddy transcript or send a destructive server-side
delete. An abandoned upstream session may remain visible in CodeBuddy history;
cleaning it up requires an explicit user action outside this release.

The model catalog is read from documented service or ACP metadata when
available. If the detected release does not expose a complete catalog, the UI
allows a manual model ID and requires a real verification turn before
activation. The draft may be saved before verification, but activation remains
blocked. An unknown or unavailable model returned by the public service during
verification maps to `CODEBUDDY_MODEL_UNAVAILABLE`; it is not deferred to the
first ordinary `sendTurn()`. If a previously verified model later disappears,
the current turn fails with the same code, the profile becomes unverified, and
new turns remain blocked until the model is changed or reverified. Help text is
diagnostic evidence only and is never treated as a verified catalog.

CodeBuddy receives only the CyberBoss MCP configuration explicitly required for
the active workspace. Permission requests map to the existing
`runtime.approval.requested` event and flow through CyberBoss's existing approval
path. Unknown permission shapes default to denial. Cancellation maps to the
documented ACP cancellation method and must be acknowledged before a runtime
switch completes.

A turn is “in flight” from the moment `sendTurn()` is accepted until a
correlated terminal event has been processed. Streaming, tool execution,
cancellation acknowledgement, and waiting for a pending approval are all
in-flight states.

Usage fields exposed by the public service are preserved as raw CodeBuddy
`vendorUsage` metadata and mapped to generic CyberBoss token or cost fields only
when their meaning is documented. The adapter never merges, compares, converts,
or labels those values as WorkBuddy credits or promotions. Missing quota fields
remain unknown rather than being inferred from another product.

## Error handling

The adapter emits stable CyberBoss error codes:

- `CODEBUDDY_BINARY_NOT_FOUND`
- `CODEBUDDY_VERSION_UNREADABLE`
- `CODEBUDDY_LOGIN_REQUIRED`
- `CODEBUDDY_START_TIMEOUT`
- `CODEBUDDY_PORT_UNAVAILABLE`
- `CODEBUDDY_AUTH_FAILED`
- `CODEBUDDY_API_INCOMPATIBLE`
- `CODEBUDDY_CONNECTION_LOST`
- `CODEBUDDY_SESSION_FAILED`
- `CODEBUDDY_MODEL_UNAVAILABLE`
- `CODEBUDDY_TURN_FAILED`
- `CODEBUDDY_APPROVAL_EXPIRED`
- `CODEBUDDY_CANCEL_TIMEOUT`
- `CODEBUDDY_COMPACTION_UNSUPPORTED`

Failure of the loopback gateway password maps to `CODEBUDDY_AUTH_FAILED`.
Absence of a documented CodeBuddy account identity maps to
`CODEBUDDY_LOGIN_REQUIRED`; both block activation, but only the latter offers
the interactive account-login flow. A public API incompatibility blocks
activation and reports the detected CLI version and failed capability. Rate
limiting and quota exhaustion fail the current turn but do not erase login or
mark the executable incompatible. Child exit fails active turns, expires
pending approvals, and lets the supervisor perform its existing profile
rollback. Each expired approval is removed from the response map,
emits `CODEBUDDY_APPROVAL_EXPIRED`, and changes its UI card to
“请求已过期，模型服务已退出”. A later Approve or Reject action returns that stable
error and never starts a new process or replays the tool request.

Automatic restart is allowed once per failure incident only when there are zero
in-flight turns, which also means zero pending approvals and zero outstanding
cancellation acknowledgements. The restart repeats executable discovery,
process start, health, gateway authentication, ACP connection, identity match,
and the complete no-model capability probe; merely respawning the process is
not sufficient. A failed restart places the runtime in Error and requires the
user to select Retry or reactivate the profile. No second automatic restart is
attempted, and a failure during an in-flight turn is never automatically
replayed.

## Control-center experience

The model setup UI adds “WorkBuddy / CodeBuddy” with these states:

- Not found: explain how to install CodeBuddy or WorkBuddy and offer re-scan.
- Found, login required: show source and version, then offer “登录 CodeBuddy”.
- Logged in, unverified: select or enter a model, then run the existing runtime
  verification sequence.
- Manual model invalid: keep the profile as a saved draft, show
  `CODEBUDDY_MODEL_UNAVAILABLE`, and keep activation disabled.
- Verified: activate the profile and show runtime, executable source, version,
  model, and health.
- Incompatible: show the failed public capability and advise updating the
  relevant product; never advise editing internal files.

The login terminal is visible because the user must interact with it. Managed
service processes remain hidden. Passwords and token material never enter the
renderer.

## Testing and verification

### Automated tests

- Distribution discovery: explicit path, `PATH`, WorkBuddy fallback, missing
  files, update replacement, and version parsing.
- Process host: safe arguments, loopback binding, readiness timeout, early exit,
  five-attempt address-conflict recovery, exact-child shutdown, overlay ACL and
  lifetime cleanup, stale-overlay garbage collection, and secret redaction.
- Client: authentication headers, ACP connection lifecycle, SSE parsing,
  correlation, reconnect boundaries, timeout, and cancellation.
- Protocol adapter: current public schema, unknown fields, missing required
  fields, future-version incompatibility, and proof that `/internal/*` is never
  called.
- Boundary enforcement: a source scan fails if CodeBuddy route strings,
  `X-CodeBuddy-Request`, ACP method names, or WorkBuddy installation paths occur
  outside `src/adapters/runtime/codebuddy/` and its adapter-focused tests.
- Runtime adapter: new session, resume, fresh fallback, opening instructions,
  persisted binding removal without upstream deletion, streaming, approval,
  approval-expiry UI state, denial-by-default, usage without cross-product
  inference, compaction capability, and cancellation acknowledgement.
- Shared login: terminal cancellation, explicit login verification, account
  fingerprint change, external logout, and invalidation of every mismatched
  CodeBuddy profile.
- Restart policy: idle-only restart, pending approval and cancellation as
  in-flight work, full capability reprobe, one-attempt limit, and manual Retry
  after failure.
- Registry, profile verifier, model settings, supervisor switching, backup
  exclusion, and desktop IPC coverage for runtime ID `codebuddy`.

All network tests use a fake public CodeBuddy server. They must not depend on a
real account or spend quota.

### Local integration checks

An opt-in smoke test uses the detected WorkBuddy-bundled or standalone CLI:

1. confirm login interactively;
2. start a loopback password-protected service;
3. reopen the health and public OpenAPI endpoints;
4. complete ACP initialization and create a session;
5. send a no-tool prompt that must return exactly `TEST_OK`;
6. verify the correlated completion and usage record;
7. start a second turn, cancel it, and verify acknowledgement;
8. stop the managed child and confirm the port and process are gone.

The test reports quota sharing only from the authenticated response or usage
surface. Process completion, organized output, or file creation alone never
counts as success.

### Release verification

Run syntax checks, the CodeBuddy-focused test suite, the complete test suite,
desktop packaging, and artifact verification. Reopen the packaged application,
create and activate a CodeBuddy profile, reopen the generated profile metadata,
and confirm that no service password, WorkBuddy credential, `.codebuddy`
credential, or diagnostic secret appears in the package, logs, backup, or
export. The final portable artifact must exist, be reopenable, and pass the
managed-runtime smoke check before the feature is reported complete.

## Rollout

This work is one independently testable sub-project. Implementation order is:

1. protocol client and capability probe;
2. executable discovery and managed process host;
3. runtime contract and event mapping;
4. registry, profiles, verifier, and supervisor integration;
5. login and model setup UI;
6. documentation, packaging, and real-runtime smoke verification.

No CodeBuddy implementation is enabled by default. Existing profiles and active
runtimes remain unchanged after upgrade.

The rollout accepts that a breaking Beta API release can temporarily disable
this runtime. CyberBoss reports `CODEBUDDY_API_INCOMPATIBLE` with the detected
version and failed public capability; it does not promise backward emulation.
Recovery may require a CyberBoss adapter update or selection of a compatible
CodeBuddy/WorkBuddy release. Other runtimes remain available because the
failure is contained to `src/adapters/runtime/codebuddy/`.
