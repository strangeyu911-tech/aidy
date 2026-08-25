# CyberBoss API-first multi-runtime and night-care design

## Context

CyberBoss currently treats Codex as the desktop control center's default agent
and starts a Codex App Server before the WeChat bridge. The command-line core can
also use Claude Code, and Codex accepts a configured model and model provider,
but there is no first-class API provider store, encrypted credential vault,
connection test, model catalog, or control-center model switcher.

**CyberBoss must no longer assume that a user owns a Codex subscription or has
OpenCode installed.** A new user starts with no active engine and must configure
and verify an API or an explicitly selected local runtime before CyberBoss can
run. **OpenCode is an optional enhanced runtime, not a prerequisite.** Codex and
Claude Code remain compatibility choices and are never selected by default.

OpenCode's official provider documentation says it uses AI SDK and Models.dev to
support more than 75 providers, supports custom base URLs, and identifies models
as `provider/model`. OpenRouter exposes a unified API and a programmatic model
catalog. The design uses those capabilities without making either product a
mandatory dependency.

References:

- <https://opencode.ai/docs/providers/>
- <https://opencode.ai/docs/models/>
- <https://opencode.ai/docs/server/>
- <https://opencode.ai/docs/sdk/>
- <https://openrouter.ai/docs/quickstart>

## Goals

- Remove Codex subscription access as the default engine.
- Start every fresh installation with no active engine.
- Require a verified engine, provider, and model before Running or Quiet can be
  entered.
- Let users save several connection profiles and select one global active
  runtime/provider/model from the control center.
- Work without OpenCode by providing a built-in API agent runtime.
- Detect and support an installed or externally running OpenCode instance as an
  optional runtime, including its available `provider/model` catalog.
- Support OpenRouter as a first-class provider with a searchable dynamic model
  catalog.
- Support OpenAI, Anthropic Claude, Google Gemini, Ollama, DeepSeek, Kimi, GLM,
  MiniMax, Tencent Hunyuan, Xiaomi MiMo, Qwen, and custom OpenAI-compatible APIs.
- Preserve Codex and Claude Code as optional compatibility runtimes.
- Encrypt API keys and other sensitive headers with Windows DPAPI, keep them
  out of renderer snapshots and logs, and exclude them from backup/export.
- Preserve the existing WeChat, supervision, diary, report, MCP/tool, approval,
  and session behavior through a stable runtime adapter contract.
- Add a night-care policy from 00:00 through 06:00 that replaces task pressure
  with natural sleep encouragement and stops all proactive messages after the
  user is considered asleep.

## Non-goals

- Automatically installing OpenCode.
- Making OpenCode, Codex, Claude Code, or any paid subscription the default.
- Maintaining a separate agent implementation for every provider brand.
- Guaranteeing that a model without reliable streaming and tool calling can be
  activated as a CyberBoss agent.
- Exporting, backing up, or synchronizing API keys.
- Adding per-contact or per-workspace active model selection in this release.
- Adding macOS Keychain or Linux Secret Service storage in the Windows-first
  desktop release.
- Replaying task reminders that were suppressed or replaced during night care.

## Product decisions

### No default engine

A new state store contains no active runtime or connection profile. The desktop
opens the model setup experience and disables Running and Quiet. It does not
start a Codex App Server, an OpenCode service, the bridge, or any model client.

An existing installation migrates without silently declaring Codex to be the
new API default. Its legacy runtime information remains available as a
compatibility profile, but the user must explicitly verify and activate a
profile through the control center before the new engine gate is satisfied.

### Multiple profiles, one active selection

Users may save several profiles. One global selection identifies the runtime,
provider profile, and model used for all contacts and workspaces. Switching the
selection applies after the active turn finishes. The affected workspace starts
a session scoped to the new runtime/provider/model; old sessions remain stored
and can be resumed if the old selection is activated again.

“Resume” means reusing only the committed user, assistant, and completed-tool
history that belongs to the exact same runtime ID, provider profile ID, model
ID, and credential generation. An in-flight model turn is marked aborted during
a runtime loss or application restart. Unfinished tool calls and pending model
approval requests expire and are never replayed or moved to another profile.
Durable supervision checkpoints are not conversation state: they remain in the
unified supervision plan and continue under the current policy, except for the
explicit night-care suppression rules in this design.

If a profile becomes unverified because its credential expires, its bound
sessions remain archived but cannot accept a new turn until that same profile is
successfully reverified. If the profile is deleted, its sessions become
read-only diagnostic history and cannot be resumed under another profile. A new
session on the current profile never silently imports unfinished state from the
deleted profile.

### Strict activation gate

A profile may be saved as a draft. It can become active only after a live test
confirms authentication, model availability, minimal streaming, native tool
calling, and tool-result continuation. Image input is optional: failure of the
image capability test selects the visual fallback behavior rather than blocking
activation.

## Architecture

### Runtime registry

A runtime registry replaces branches that implicitly fall back to Codex. It
registers four explicit runtime IDs:

- `builtin-api`: CyberBoss-owned streaming agent and tool loop.
- `opencode`: optional connection to a CyberBoss-owned or external OpenCode
  service.
- `codex`: existing Codex App Server compatibility adapter.
- `claudecode`: existing Claude Code compatibility adapter.

Each entry declares availability detection, configuration requirements,
process ownership, adapter construction, health checks, and a user-facing name.
Runtime IDs are internal constants enumerated by the registry; users cannot type
or persist arbitrary runtime IDs. An unknown or empty runtime ID is invalid and
never resolves to Codex.

### Provider profile store

A dedicated provider profile store persists non-secret configuration in an
atomic JSON document. Storage ownership is explicit:

| Location | Contents |
| --- | --- |
| Profile JSON | IDs, runtime, protocol, provider, base URL, non-sensitive options, selected model/variant, vision-profile reference, verification state, capability summary, timestamps, and cached catalog metadata |
| DPAPI vault | API keys, OpenCode service passwords, sensitive custom header values, and a monotonically increasing secret generation |
| Never persisted | Decrypted credentials in renderer state, request Authorization headers, and transient plaintext secret form values after submission |

Each profile contains:

- stable profile ID and user-visible name;
- runtime ID;
- provider preset ID and protocol ID;
- base URL and non-sensitive options;
- selected model ID and optional model variant;
- visual fallback profile ID when configured;
- verification status, verified fingerprint, capability result, and timestamps;
- cached model catalog metadata without credentials.

The active selection is a profile ID. A verification fingerprint covers every
field that affects connectivity or behavior, including the vault's monotonic
secret generation rather than the secret value. Editing any covered field
returns the profile to draft status. A vault decrypt/integrity failure also
returns the profile to draft. A definitive provider authentication response,
such as HTTP 401 or 403 mapped to invalid credentials, immediately marks the
profile unverified, blocks new turns, and puts an active runtime into an
actionable Error state. Rate limiting, quota exhaustion, and transient network
failure do not invalidate verification.

### Windows credential vault

API keys and sensitive custom header values are stored in a separate vault.
Each value is encrypted using Windows DPAPI for the current Windows user. The
JSON profile contains only stable secret references and flags such as
`hasApiKey`. Renderer snapshots never contain ciphertext or plaintext.

The vault performs an encrypt-write-read-decrypt comparison before reporting a
successful mutation. Secret buffers and form values are discarded as soon as
practical. Normal logs exclude authorization headers, provider keys, custom
sensitive headers, URL credentials, request bodies, and model responses.

An explicit diagnostic capture may be enabled for one connection test or for a
maximum of 15 minutes. The UI warns that prompts and responses may contain
private content. Captures are kept separately from component logs, encrypted
with DPAPI, limited in size, excluded from backup/export, and automatically
deleted after 24 hours. Enabling it never relaxes credential and Authorization
redaction.

Backups and exports include only non-sensitive profile structure. Restored
profiles become drafts and require the user to enter and verify credentials
again.

### Provider catalog

Provider presets are data, not separate agent implementations. A preset defines
the display name, protocol, default base URL, authentication shape, model
discovery strategy, and provider-specific help text. Users may override the base
URL.

The built-in protocols are:

- OpenAI Responses for OpenAI where supported;
- OpenAI Chat Completions for OpenRouter and compatible services;
- Anthropic Messages for Claude;
- Gemini `generateContent` for Google Gemini;
- Ollama local service APIs;
- OpenAI-compatible APIs for DeepSeek, Kimi, GLM, MiniMax, Tencent Hunyuan,
  Xiaomi MiMo, Qwen, and custom endpoints.

OpenRouter gets its own preset, model fetcher, and searchable full catalog.
OpenCode exposes the provider/model catalog returned by the selected OpenCode
instance. Other providers use their documented model endpoint when available
and fall back to a manually entered model ID. Catalog results are cached with a
source and refresh timestamp; cached presence never replaces live verification.

The custom OpenAI-compatible preset accepts a base URL, model ID, API key, and a
small allowlisted set of custom headers. Headers marked sensitive are stored in
the credential vault.

### Built-in API runtime

The built-in adapter implements the same interface and emits the same normalized
runtime events as the current adapters. It owns:

- provider client construction;
- streamed assistant text;
- a bounded model/tool/result loop;
- cancellation and timeout propagation;
- conversation persistence scoped by binding, workspace, provider, and model;
- normalized usage and capability metadata;
- approval requests for tools that are not already safe and allowed.

Existing CyberBoss tools are exposed through a narrow tool bridge rather than
duplicated inside the adapter. Tool inputs are schema-validated, tool results
are size-bounded, and the existing approval path remains authoritative. A turn
has finite tool-step and elapsed-time limits so a faulty model cannot create an
unbounded loop.

### OpenCode runtime

The OpenCode adapter detects a configured endpoint or a local executable. It
connects to an existing endpoint when explicitly selected or starts a
CyberBoss-owned service when a local executable is selected. CyberBoss uses its
own configuration and data directories and does not edit the user's global
OpenCode files.

Non-secret provider configuration is generated inside the CyberBoss state
directory. Secrets are decrypted only for process environment injection or the
smallest supported authentication operation. The adapter maps OpenCode session,
stream, tool, cancellation, and error events into the common runtime contract.

An absent or incompatible OpenCode executable is a profile validation error,
not a reason to install software or fall back to another runtime.

OpenCode has two explicit ownership modes:

1. **Managed local** starts a CyberBoss-owned `opencode serve` process with
   isolated config/data directories. CyberBoss may inject provider credentials
   from its vault into this owned process.
2. **External service** connects with the official client/server API. The
   external instance owns its provider credentials; CyberBoss does not send or
   mutate provider secrets through `/auth/:id` in this release. CyberBoss stores
   only the service endpoint and optional OpenCode Basic Auth password. Users
   who need CyberBoss-managed provider keys select Managed local mode.

External endpoints must be loopback HTTP or HTTPS. Plaintext non-loopback HTTP
is rejected. The catalog cache is keyed by endpoint, reported OpenCode version,
and connected-provider fingerprint. It refreshes on connection, activation,
manual refresh, provider-auth change, endpoint/version change, and after a
10-minute freshness period. Stale entries may be displayed with a warning but
cannot satisfy activation without a live provider/model refresh.

### Runtime-agnostic desktop supervisor

The supervisor resolves the active profile before starting anything:

- `builtin-api` starts no model sidecar;
- `opencode` attaches to or starts only OpenCode;
- `codex` attaches to or starts only the Codex App Server;
- `claudecode` follows its existing process behavior.

The WeChat bridge receives only the active profile ID and runtime-specific
non-secret startup settings; credentials are delivered through the secure
runtime boundary. Status and error copy use generic “model service” language
except when naming the selected runtime helps repair an error.

When switching profiles, the controller stops accepting new turns, lets the
current turn finish by default, stops the old owned runtime, starts and probes
the new runtime, then resumes bridge dispatch. If the new runtime fails, the
controller restores the old active selection, restarts or reconnects the old
runtime, passes its readiness probe, and only then resumes bridge dispatch. If
that rollback start also fails, the controller remains in Error with neither
profile reported as healthy and offers explicit Retry. A switch never drops an
already completed assistant response.

## Control-center experience

### First-run setup

The first-run wizard has five steps:

1. Choose Built-in API, OpenCode, Codex, or Claude Code.
2. Choose a provider preset and enter the required endpoint and credentials.
3. Refresh, search, or manually enter a model ID.
4. Test authentication, model access, streaming, tool use, cancellation, and
   optional image input.
5. Activate the verified profile and unlock Running and Quiet.

The wizard preserves a failed setup as a draft and gives an actionable failure
category. It never displays a full saved secret.

### Model and API settings

The Settings view gains a “Models and APIs” section that lists profiles with
runtime, provider, model, verification state, last test time, and active status.
Actions include add, edit, refresh models, test, activate, and delete.

Deleting a non-active profile requires confirmation. Deleting the active
profile requires CyberBoss to be Stopped or another verified profile to be
activated first. Editing a verified connection field invalidates verification.

The Control view replaces the hard-coded Codex card with the active runtime,
provider, model, and health. When no profile is active, the card points to model
setup and the power control remains disabled.

### Visual fallback

If the active model accepts images, attachments are sent directly. Otherwise,
the user may select a separate verified vision-capable profile. That profile
creates a textual image description for the active model. If no vision profile
exists, CyberBoss tells the user it cannot read the image. It never silently
sends an attachment to an unrelated provider.

Vision preprocessing is a child operation of the inbound turn but not a model
tool step. It inherits turn cancellation, has its own 30-second timeout, and
allows one retry only for a transient transport or rate-limit error. Its usage
is attributed to the vision profile and linked to the parent turn for aggregate
cost reporting; it is never charged to the active text profile.

If the vision profile is deleted, becomes unverified, fails both attempts, or
returns no usable description, CyberBoss keeps the attachment record, does not
send the main model a fabricated or empty caption, and replies that the image
could not be processed. The fallback reference is cleared when its profile is
deleted. It never silently chooses another vision provider.

## Night-care policy

### Time window and state

Night care runs from 00:00 inclusive to 06:00 exclusive in the user's configured
timezone. It stores two distinct states for the current local night window:

- `explicitSleep`: set by a high-confidence sleep-intent message;
- `inferredSleep`: set after the night window has observed 90 minutes without
  inbound activity.

Both states carry the local night-window date. At 06:00 they are cleared and the
night inactivity baseline is discarded. They never carry into a later date. At
the next 00:00 a new inactivity baseline starts at the window boundary, or at a
later inbound message when one arrives.

The user enters explicit sleep state when a message clearly says they are going
to sleep, are preparing to sleep, or equivalent. A small local, high-precision
phrase classifier runs before the model runtime and recognizes unambiguous sleep
and wake statements. A working runtime may add a structured intent result for
less literal wording, but an uncertain or unavailable model never sets explicit
sleep. The deterministic 90-minute inference remains the safe fallback when the
runtime is unhealthy. The user exits explicit sleep after an explicit waking
statement or at 06:00. Crossing midnight does not itself mark the user asleep.

During the night-care window, a user who has not explicitly entered sleep state
is inferred asleep after 90 minutes from the current night's activity baseline.
The inference is used only to suppress proactive output. A new inbound message
clears inferred sleep and restarts the baseline unless that message itself sets
explicit sleep. Inferred sleep is forcibly discarded at 06:00 and never crosses
days.

### Dispatch rules

During 00:00–06:00, dispatch applies these rules in order:

1. If `explicitSleep` or `inferredSleep` is set, suppress every proactive
   message, including night care.
2. Task urging, planning requests, and Zhijiantime task checkpoints are never
   sent as task or planning pressure.
3. A normal random check-in keeps the ordinary configured random schedule and
   is rewritten as a natural prompt to sleep earlier and avoid staying up late.
4. A user-agreed fixed-time checkpoint fires at the agreed time but is also
   rewritten as night care, even if the original agreement was to complete a
   task at that time.
5. Random timing stays random. There is no additional fixed cooldown or
   periodic night schedule.
6. If random and deterministic checkpoints become eligible near each other,
   the unified supervision plan deduplicates them into one natural night-care
   message.
7. Suppressed or replaced task/planning checkpoints retain their source and
   original due time with a night-care outcome, but they are not replayed after
   06:00.

The Control and Records views show friendly outcomes such as “因夜间关怀改为早睡
提醒” and “推断已入睡，已跳过主动消息”, with the original source and due time
available in details.

Outside the night-care window, existing supervision rules apply. Night-care
copy should vary naturally through the model while preserving the narrow intent
to encourage sleep rather than introduce new tasks or plans.

## Error handling

Connection and runtime errors are normalized into:

- invalid or missing credentials;
- unreachable or invalid base URL;
- missing or inaccessible model;
- insufficient balance or quota;
- rate limiting;
- timeout or cancellation;
- incompatible response protocol;
- streaming unsupported;
- tool calling unsupported or malformed;
- OpenCode missing, incompatible, or unhealthy;
- credential encryption/decryption failure.

Each category has a concise summary and repair action. A failed draft test does
not affect the current profile. A failed switch restores the previous selection.
Provider responses and message contents are excluded from normal component logs.
A definitive authentication failure invalidates the profile as described in the
profile-store contract, even when the vault file was modified outside CyberBoss.

## Persistence and migration

The profile document, credential vault, model cache, active selection, and
night-care state use atomic writes and explicit schema versions. Corrupt
non-secret state is quarantined through the existing atomic store behavior and
reported in diagnostics. Credential corruption never causes a silent empty key;
the affected profile becomes unverified and requires re-entry.

Existing Codex and Claude Code session maps remain readable. During migration,
an unscoped Codex session can bind only to an explicitly activated Codex
compatibility profile whose model/provider matches the legacy metadata; an
unscoped Claude Code session can bind only to an explicitly activated Claude
Code compatibility profile. A missing or ambiguous match leaves the old session
read-only and starts a fresh scoped session. Migration never binds a legacy
session to Built-in API or OpenCode.

New session scope keys include runtime, provider profile, model, and credential
generation so switching cannot resume a thread under the wrong credentials or
model. Existing per-workspace model settings are migration hints only and never
override the global active profile. Every inbound, scheduled, report, MCP, and
tool-triggered model turn resolves the same global active profile. Tool
availability and approval policy may remain workspace-scoped security controls,
but they cannot select a different runtime/provider/model. Legacy model-change
commands must route through global profile activation or direct the user to the
control center.

Existing desktop supervision settings migrate without changing their values.
Future macOS and Linux desktop releases require a credential-vault
implementation backed by the respective operating-system secret service before
API profiles can be enabled there.

## Testing and acceptance

### Provider and runtime contract tests

Local mock HTTP services verify the exact request format, authentication,
streamed deltas, tool calls, tool results, cancellation, timeouts, rate limits,
quota failures, malformed responses, and secret redaction for each protocol.
Tests use synthetic keys only and require no paid API access.

Runtime contract tests run the same behavioral suite against built-in API,
OpenCode test doubles, Codex, and Claude Code adapters where applicable. They
verify normalized lifecycle and approval events and session isolation.
Session tests also prove that completed history resumes only for an exact scope,
in-flight turns become aborted, pending approvals expire, invalid/deleted
profiles cannot resume, and durable supervision state is not duplicated.

### Store and security tests

Tests cover profile normalization, draft invalidation, verified fingerprints,
atomic save, close and reopen, schema migration, corrupt data recovery, DPAPI
encryption abstraction, secret-reference deletion, masked snapshots, and log
redaction. They also cover external vault tampering, decrypt failure, runtime
401/403 invalidation, bounded diagnostic capture, automatic capture expiry, and
capture exclusion from export. Backup and export tests inspect archive contents
and prove that API keys, authorization headers, sensitive custom headers, and
ciphertext are not included.

### Desktop and supervisor tests

Tests cover first-run gating, disabled Running/Quiet controls, provider forms,
model refresh/search/manual entry, connection tests, activation, deferred
switching after an active turn, start behavior for each runtime, failed-switch
rollback with old-runtime restart/readiness, rollback-start failure, active-
profile deletion safeguards, visual fallback selection/failure/usage attribution,
managed-local versus external OpenCode credential ownership, external transport
security, and catalog refresh invalidation.

### Night-care tests

A controllable clock and timezone cover:

- 23:59, 00:00, 05:59, and 06:00 boundaries;
- explicit preparing-to-sleep and waking messages;
- exactly 90 minutes and more than 90 minutes without inbound activity;
- separate explicit and inferred state transitions and the local phrase-parser
  fallback while the model runtime is unavailable;
- forced state and inactivity-baseline reset at 06:00 with no cross-day carry;
- random check-ins retaining their configured random schedule;
- fixed-time agreements retaining timing while changing intent;
- task, plan, and Zhijiantime suppression/replacement;
- random and deterministic deduplication;
- no proactive output after sleep inference;
- no replay after the window closes.

### Final artifact verification

Completion requires more than an in-memory success result. The verification run
must create a temporary profile and encrypted vault, confirm that both files
exist, construct fresh store instances, reopen and parse them, and confirm that
the decrypted synthetic secret matches only inside the vault boundary. It must
then generate a backup/export, confirm that the archive exists, reopen it,
inspect its manifest and entries, and prove that no secret or ciphertext is
present. The final packaged desktop artifact must also be generated and opened
or inspected successfully before delivery is reported complete.

## Acceptance criteria

- Given an empty state directory, startup has no active engine and rejects
  Running and Quiet until a live verification and activation succeeds.
- Given no OpenCode executable or endpoint, each named built-in provider family
  and a custom OpenAI-compatible endpoint can complete the runtime contract
  tests.
- Given Managed local OpenCode, its isolated provider/model combinations are
  selectable without modifying global OpenCode files; given External service,
  CyberBoss uses only credentials already owned by that service.
- Given a reachable OpenRouter profile, model refresh returns a searchable
  catalog and activation performs a live refresh rather than trusting cache.
- Codex and Claude Code appear as selectable compatibility entries, and neither
  is selected in a clean state.
- After a same-user application restart, secrets decrypt inside the vault
  boundary but never appear in renderer snapshots, normal logs, or exports.
- After an exact-profile switch back, completed session history resumes while
  unfinished tool turns and approvals do not; invalid or deleted profiles remain
  non-resumable.
- When a new runtime start fails after the old one stops, the old selection is
  restored, its runtime is restarted/reconnected, and bridge dispatch resumes
  only after readiness succeeds.
- If a vision fallback fails or becomes invalid, the original attachment remains
  recorded, the user receives an image-processing error, and no substitute
  provider is silently chosen.
- From 00:00 through 06:00, an active user receives sleep-oriented check-ins on
  the ordinary random or explicitly agreed schedule instead of task pressure.
- Explicit or inferred sleep suppresses every proactive message; inferred state
  and its baseline are cleared at 06:00 and never cross local-night windows.
- Night-care replacements and suppression are visible in Records and are never
  replayed after 06:00.
- The final verification proves configuration and export artifacts exist,
  reopens them successfully, and confirms that exported contents contain no
  secret material.
