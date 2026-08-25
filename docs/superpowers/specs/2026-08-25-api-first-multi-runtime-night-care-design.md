# CyberBoss API-first multi-runtime and night-care design

## Context

CyberBoss currently treats Codex as the desktop control center's default agent
and starts a Codex App Server before the WeChat bridge. The command-line core can
also use Claude Code, and Codex accepts a configured model and model provider,
but there is no first-class API provider store, encrypted credential vault,
connection test, model catalog, or control-center model switcher.

The product must no longer assume that a user owns a Codex subscription or has
OpenCode installed. A new user starts with no active engine and must configure
and verify an API or an explicitly selected local runtime before CyberBoss can
run. OpenCode is an optional enhanced runtime, not a prerequisite. Codex and
Claude Code remain compatibility choices and are never selected by default.

OpenCode's official provider documentation says it uses AI SDK and Models.dev to
support more than 75 providers, supports custom base URLs, and identifies models
as `provider/model`. OpenRouter exposes a unified API and a programmatic model
catalog. The design uses those capabilities without making either product a
mandatory dependency.

References:

- <https://opencode.ai/docs/providers/>
- <https://opencode.ai/docs/models/>
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
An unknown or empty runtime ID is invalid and never resolves to Codex.

### Provider profile store

A dedicated provider profile store persists non-secret configuration in an
atomic JSON document. Each profile contains:

- stable profile ID and user-visible name;
- runtime ID;
- provider preset ID and protocol ID;
- base URL and non-sensitive options;
- selected model ID and optional model variant;
- visual fallback profile ID when configured;
- verification status, verified fingerprint, capability result, and timestamps;
- cached model catalog metadata without credentials.

The active selection is a profile ID. A verification fingerprint covers every
field that affects connectivity or behavior, including a one-way version token
for its secret. Editing any covered field returns the profile to draft status.

### Windows credential vault

API keys and sensitive custom header values are stored in a separate vault.
Each value is encrypted using Windows DPAPI for the current Windows user. The
JSON profile contains only stable secret references and flags such as
`hasApiKey`. Renderer snapshots never contain ciphertext or plaintext.

The vault performs an encrypt-write-read-decrypt comparison before reporting a
successful mutation. Secret buffers and form values are discarded as soon as
practical. Logs redact authorization headers, provider keys, custom sensitive
headers, URL credentials, request bodies, and model responses.

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
controller restores the old active selection and runtime. A switch never drops
an already completed assistant response.

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

## Night-care policy

### Time window and state

Night care runs from 00:00 inclusive to 06:00 exclusive in the user's configured
timezone. It tracks the most recent inbound user activity and an explicit sleep
state.

The user enters explicit sleep state when a message clearly says they are going
to sleep, are preparing to sleep, or equivalent. The user exits explicit sleep
state after an explicit waking statement or the first inbound message at or
after 06:00. Crossing midnight does not itself mark the user asleep.

During the night-care window, a user who has not explicitly entered sleep state
is inferred asleep after 90 minutes without inbound activity. The inference is
used only to suppress proactive output; the next inbound message refreshes
activity and makes the user active again unless that message itself says they
are sleeping.

### Dispatch rules

During 00:00–06:00:

- Task urging, planning requests, and Zhijiantime task checkpoints are never
  sent as task or planning pressure.
- A normal random check-in keeps the ordinary configured random schedule and is
  rewritten as a natural prompt to sleep earlier and avoid staying up late.
- A user-agreed fixed-time checkpoint fires at the agreed time but is also
  rewritten as night care, even if the original agreement was to complete a
  task at that time.
- Random timing stays random. There is no additional fixed cooldown or periodic
  night schedule.
- If random and deterministic checkpoints become eligible near each other, the
  unified supervision plan deduplicates them into one natural night-care
  message.
- After explicit sleep or 90 minutes without inbound activity, every proactive
  message, including night care, is suppressed.
- Suppressed or replaced task/planning checkpoints retain their source and
  original due time with a night-care outcome, but they are not replayed after
  06:00.

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

## Persistence and migration

The profile document, credential vault, model cache, active selection, and
night-care state use atomic writes and explicit schema versions. Corrupt
non-secret state is quarantined through the existing atomic store behavior and
reported in diagnostics. Credential corruption never causes a silent empty key;
the affected profile becomes unverified and requires re-entry.

Existing Codex and Claude Code session maps remain readable. New session scope
keys include runtime, provider profile, and model so switching cannot resume a
thread under the wrong credentials or model. Existing desktop supervision
settings migrate without changing their values.

## Testing and acceptance

### Provider and runtime contract tests

Local mock HTTP services verify the exact request format, authentication,
streamed deltas, tool calls, tool results, cancellation, timeouts, rate limits,
quota failures, malformed responses, and secret redaction for each protocol.
Tests use synthetic keys only and require no paid API access.

Runtime contract tests run the same behavioral suite against built-in API,
OpenCode test doubles, Codex, and Claude Code adapters where applicable. They
verify normalized lifecycle and approval events and session isolation.

### Store and security tests

Tests cover profile normalization, draft invalidation, verified fingerprints,
atomic save, close and reopen, schema migration, corrupt data recovery, DPAPI
encryption abstraction, secret-reference deletion, masked snapshots, and log
redaction. Backup and export tests inspect archive contents and prove that API
keys, authorization headers, sensitive custom headers, and ciphertext are not
included.

### Desktop and supervisor tests

Tests cover first-run gating, disabled Running/Quiet controls, provider forms,
model refresh/search/manual entry, connection tests, activation, deferred
switching after an active turn, start behavior for each runtime, failed-switch
rollback, active-profile deletion safeguards, and visual fallback selection.

### Night-care tests

A controllable clock and timezone cover:

- 23:59, 00:00, 05:59, and 06:00 boundaries;
- explicit preparing-to-sleep and waking messages;
- exactly 90 minutes and more than 90 minutes without inbound activity;
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

- A clean installation starts with no engine and cannot run before successful
  verification and activation.
- A user without OpenCode can run CyberBoss with every named built-in provider
  family or a custom OpenAI-compatible endpoint.
- A user with OpenCode can select its available provider/model combinations
  without CyberBoss modifying the user's global OpenCode configuration.
- OpenRouter models are refreshable and searchable from the control center.
- Codex and Claude Code remain selectable but neither is the default.
- Secrets survive an application restart for the same Windows user, never enter
  renderer snapshots or logs, and never enter backup/export.
- Switching profiles preserves old sessions, changes the next eligible turn,
  and rolls back after a failed runtime start.
- From 00:00 through 06:00, active users receive naturally timed sleep-oriented
  check-ins instead of task or planning pressure.
- Explicit sleep or more than 90 minutes without inbound activity suppresses all
  proactive messages, and night-suppressed work is not replayed in the morning.
- Configuration and export artifacts are proven to exist and are reopened and
  inspected before completion is claimed.
