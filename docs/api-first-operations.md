# API-first operations

## First start

A clean state directory has no active engine. Aidy stays Stopped and disables Running and Quiet until a profile is live-tested and activated in **Control Center → Models and APIs**.

1. Choose Built-in API, OpenCode, Codex, or Claude Code.
2. Choose a provider, enter its endpoint and credentials, then refresh or manually enter a model ID.
3. Run the connection test. Activation requires authentication, model access, streaming, tool calling, tool-result continuation, and cancellation. Image input is optional.
4. Activate the verified profile. One global runtime/provider/model selection is used by inbound, scheduled, report, MCP, and tool-triggered turns.

Built-in API supports OpenAI, OpenRouter, Anthropic, Gemini, Ollama, DeepSeek, Kimi, GLM, MiniMax, Tencent Hunyuan, Xiaomi MiMo, Qwen, and custom OpenAI-compatible endpoints. OpenRouter provides a searchable live model catalog.

## OpenCode and compatibility runtimes

- **Managed local OpenCode** starts an Aidy-owned service with isolated config/data directories. Provider credentials may be injected from the Aidy vault.
- **External OpenCode** uses provider credentials already owned by that service. Aidy stores only the endpoint and optional Basic Auth password, accepts loopback HTTP or HTTPS, and performs a live provider/model refresh on every activation.
- **Codex** and **Claude Code** are explicit compatibility choices. They are never selected by default and require their local runtime to be available.

`/model` is intentionally read-only: it shows the active global profile and directs changes to the control center.

## Credential and diagnostic safety

API keys, OpenCode service passwords, and sensitive custom headers are stored in `credential-vault.json` using Windows DPAPI for the current Windows user. Moving the vault to another Windows account or machine does not make it decryptable. Re-enter and reverify credentials instead.

Normal logs and renderer snapshots omit credentials, Authorization and sensitive headers, URL credentials, raw request bodies, raw response bodies, provider response content, and vault ciphertext.

Diagnostic capture is opt-in, encrypted, limited to 15 minutes and 1 MiB, and deleted after 24 hours. It can also be disabled or deleted immediately. Captures never relax credential redaction and never retain raw image bytes.

## Backup, restore, and recovery

Settings backups include sanitized `provider-profiles.json` structure. They never include `credential-vault.json`, `diagnostic-capture.json`, OpenCode authentication/configuration secrets, API keys, Authorization headers, sensitive custom headers, raw requests/responses, or ciphertext.

On restore, all profiles become inactive drafts with empty verification state, capabilities, credential references, and credential generation. Re-enter credentials, run the live test, then activate the intended profile. Existing credentials in the target state directory are not overwritten by the archive.

Common recovery actions:

- Invalid credentials or DPAPI decrypt failure: re-enter the credential and reverify.
- Unreachable/invalid base URL: correct the endpoint; credentials in URL/query/fragment are rejected.
- Model unavailable: refresh the live catalog or enter an accessible model ID.
- Rate limit/quota: wait or repair provider billing; these transient errors do not silently select another runtime.
- OpenCode missing/unhealthy: repair the selected executable/endpoint or explicitly activate another verified profile.
- Failed runtime switch: Aidy restores and probes the previous runtime before dispatch resumes; use Retry if rollback also fails.

## Release verification

Run `npm run check`, `npm run test:models`, `npm test`, `npm run desktop:package`, and `npm run verify:artifacts`. The last command creates and reopens real profile, vault, backup, packaged-state, unpacked executable, and portable artifacts, then audits the archive and packaged resources for forbidden sensitive entries.

Night-care behavior is not part of this API-first release; it remains in the separate follow-up plan.
