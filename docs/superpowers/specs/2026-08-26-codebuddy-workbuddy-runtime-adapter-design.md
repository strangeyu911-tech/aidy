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
coarse authenticated/not-authenticated result from a documented command or live
probe; it never reads, exports, logs, backs up, or migrates the credential.

Using the same Tencent account as WorkBuddy is recommended, but quota sharing is
reported only after the first successful model call and usage response. The UI
does not promise that a specific WorkBuddy promotion applies to CodeBuddy.

### Managed local only

The first release supports only a CyberBoss-owned child process bound to
`127.0.0.1` on a dynamically reserved port. CyberBoss stops only the child it
started. It never attaches to or terminates WorkBuddy Desktop, WorkBuddy
sidecars, or unrelated CodeBuddy processes.

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
credentials. Any temporary plaintext overlay uses a current-user-only ACL and
is removed after the child has loaded it or when startup fails.

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
without affecting ordinary turns.

### Sessions, models, tools, and approvals

Session IDs remain in the existing session store under runtime ID `codebuddy`.
They are never reused across different profile IDs, credential generations,
models, or workspaces. Resume failure clears only the affected CodeBuddy
binding and creates a fresh session with opening instructions.

The model catalog is read from documented service or ACP metadata when
available. If the detected release does not expose a complete catalog, the UI
allows a manual model ID and requires a real verification turn before
activation. Help text is diagnostic evidence only and is never treated as a
verified catalog.

CodeBuddy receives only the CyberBoss MCP configuration explicitly required for
the active workspace. Permission requests map to the existing
`runtime.approval.requested` event and flow through CyberBoss's existing approval
path. Unknown permission shapes default to denial. Cancellation maps to the
documented ACP cancellation method and must be acknowledged before a runtime
switch completes.

## Error handling

The adapter emits stable CyberBoss error codes:

- `CODEBUDDY_BINARY_NOT_FOUND`
- `CODEBUDDY_VERSION_UNREADABLE`
- `CODEBUDDY_LOGIN_REQUIRED`
- `CODEBUDDY_START_TIMEOUT`
- `CODEBUDDY_AUTH_FAILED`
- `CODEBUDDY_API_INCOMPATIBLE`
- `CODEBUDDY_CONNECTION_LOST`
- `CODEBUDDY_SESSION_FAILED`
- `CODEBUDDY_TURN_FAILED`
- `CODEBUDDY_CANCEL_TIMEOUT`

An authentication failure blocks activation and offers login again. A public
API incompatibility blocks activation and reports the detected CLI version and
failed capability. Rate limiting and quota exhaustion fail the current turn but
do not erase login or mark the executable incompatible. Child exit fails active
turns, expires pending approvals, and lets the supervisor perform its existing
profile rollback. Automatic restart is limited to one attempt when no turn was
in flight; restart loops are prohibited.

## Control-center experience

The model setup UI adds “WorkBuddy / CodeBuddy” with these states:

- Not found: explain how to install CodeBuddy or WorkBuddy and offer re-scan.
- Found, login required: show source and version, then offer “登录 CodeBuddy”.
- Logged in, unverified: select or enter a model, then run the existing runtime
  verification sequence.
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
  exact-child shutdown, and secret redaction.
- Client: authentication headers, ACP connection lifecycle, SSE parsing,
  correlation, reconnect boundaries, timeout, and cancellation.
- Protocol adapter: current public schema, unknown fields, missing required
  fields, future-version incompatibility, and proof that `/internal/*` is never
  called.
- Boundary enforcement: a source scan fails if CodeBuddy route strings,
  `X-CodeBuddy-Request`, ACP method names, or WorkBuddy installation paths occur
  outside `src/adapters/runtime/codebuddy/` and its adapter-focused tests.
- Runtime adapter: new session, resume, fresh fallback, opening instructions,
  streaming, approval, denial-by-default, usage, compaction capability, and
  cancellation acknowledgement.
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
