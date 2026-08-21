# Windows workspace thread routing repair

## Goal

Ensure that one Windows workspace maps to one Cyberboss Codex thread even when the same path is written with forward or backward slashes. Ensure a user message is handled before a queued check-in when both become available in the same polling cycle.

## Design

### Workspace identity

Add one shared workspace-path normalizer. Windows drive-qualified paths use `path.win32.normalize` and a stable backslash representation; other paths continue through the platform path normalizer. The Codex session store uses this normal form for active workspace roots, thread maps, runtime parameter maps, and lookups.

When loading existing session state, normalize all workspace-keyed maps and merge aliases. If both an alias and the canonical key exist, prefer the canonical entry; this preserves the current `D:\\CyberBoss` binding and its newer thread. The old Codex thread remains on disk and is not deleted. A migrated session state is saved atomically by the existing session-store persistence path.

The shared bridge's direct session-file lookup uses the same normal-form comparison so it can resolve old state before or without a session-store rewrite.

### Message ordering

Mark poller-created messages as `checkin`. The bridge polls WeChat before flushing pending system messages, so a newly arrived user message is dispatched first. After handling inbound messages, check-in messages whose creation time predates newer inbound activity for the same binding and workspace are discarded; reminders and other system messages are unaffected. Existing turn-gate checks remain the final protection against concurrent turns.

### Verification

Add focused tests for:

1. Forward-slash and backslash workspace variants resolving to the same thread.
2. Existing duplicate session maps merging without deleting either Codex transcript.
3. A queued check-in being suppressed after newer user activity, while non-check-in system messages still dispatch.
4. The full project check command and the Windows shared-start smoke path.

## Alternatives considered

- Delete `sessions.json` and start a fresh thread: simple, but loses routing state and risks losing user configuration.
- Keep exact-string matching and ask users to use one slash style: avoids migration code, but leaves the Windows bug and can recur after restart.
- Normalize paths only at call sites: smaller edits, but future callers can still create duplicate keys. A shared normalizer plus load-time migration gives one invariant.

## Safety

Before running the migration against the user's live state, create a timestamped backup of `C:\\Users\\23159\\.cyberboss\\sessions.json`. No Codex transcript files are deleted.
