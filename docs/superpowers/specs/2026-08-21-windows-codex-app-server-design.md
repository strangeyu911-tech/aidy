# Windows Codex app-server startup compatibility

## Context

Cyberboss starts the shared Codex app-server with a set of `-c` arguments that
configure the project MCP server. On Windows, the current launcher always sets
`shell: true`, which sends those arguments through `cmd.exe`. Windows path
backslashes and embedded TOML quotes are then parsed a second time. Codex
receives the MCP `args` value as one string instead of a TOML sequence and
exits before the app-server becomes ready.

## Decision

Keep shell launching for command names and non-executable Windows wrappers, but
launch an explicit absolute `.exe` path directly with `shell: false`. Direct
argument passing preserves the TOML argument string exactly while retaining the
existing behavior for PATH-resolved commands and wrapper scripts.

## Scope

- Change only `scripts/shared-common.js`.
- Do not change MCP configuration generation or the user-facing environment
  variables.
- Record the root cause and compatibility decision in this document.

## Verification

- Run the repository syntax check.
- Start the Codex app-server using the configured absolute Windows executable
  and confirm its `/readyz` endpoint becomes healthy.
- Confirm the existing WeChat account state remains untouched.
