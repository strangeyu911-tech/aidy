# API-first migration

## What changes

CyberBoss no longer treats Codex, OpenCode, Claude Code, or any subscription as the default. Existing runtime hints do not unlock Running or Quiet. After upgrading, create or review a profile in **Control Center → Models and APIs**, perform a live capability test, and explicitly activate it.

Legacy per-workspace model settings are migration hints only. The active runtime/provider/model is global and cannot be overridden by a workspace. `/model` reports the current profile but does not mutate it.

## Sessions

- A legacy Codex session can bind only to an explicitly active Codex compatibility profile whose provider/model matches its legacy metadata.
- A legacy Claude Code session can bind only to an explicitly active Claude Code compatibility profile.
- Ambiguous or unverifiable history is labelled legacy/read-only, and interaction continues in a new scoped session.
- Legacy sessions never migrate into Built-in API or OpenCode.
- New session scope includes runtime, profile, model, and credential generation. Completed history can resume only for an exact scope; unfinished turns, tool calls, and approvals do not migrate or replay.

## Credentials and backups

Provider secrets are not imported from environment settings into the DPAPI vault automatically. Enter them through the control center. Every vault write increments credential generation and invalidates earlier verification, even when the same key is entered again.

Backups carry only sanitized non-secret profile structure. Restored profiles are inactive drafts and need credentials plus a new live test. Vault ciphertext and diagnostic capture are excluded, so moving a backup to another machine cannot transfer API keys.

Existing desktop supervision settings retain their values. Night-care migration is intentionally deferred to its later implementation plan.
