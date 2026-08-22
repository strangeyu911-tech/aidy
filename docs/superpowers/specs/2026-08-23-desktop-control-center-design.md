# CyberBoss desktop control center and unified supervision plan

## Context

CyberBoss currently runs as a foreground command-line bridge. A Windows
scheduled task can keep it alive, but users must understand terminals, task
scheduler state, PID files, and logs. Codex also starts a local Code Mode host;
on Windows that child process can surface an unwanted console window.

The product is intended for people who benefit from persistent external
accountability, especially ADHD users. Requiring them to remember startup and
process-management steps undermines that goal. The first usable desktop release
therefore needs a user-facing control center, silent background operation, and
one supervision plan that combines random, conversational, contextual, and
calendar-driven follow-ups.

## Product goals

- Start from a desktop icon and operate without visible terminal windows.
- Remain available in the Windows system tray when the main window closes.
- Expose three understandable states: running, quiet, and stopped.
- Keep Codex as the default first-release agent runtime.
- Show local diary entries and generated timeline reports in one records area.
- Combine random check-ins, explicit conversational commitments, contextual
  follow-ups, and Zhijiantime schedule/todo changes without duplicate messages.
- Generate a dependable daily report and catch up after downtime.
- Present friendly health and error states instead of raw process output.

## Non-goals for the first release

- WorkBuddy and arbitrary custom-agent adapters are phase-two work.
- The UI does not replace or remove the existing Claude Code CLI path.
- The first release does not sync unrelated diary or timeline data to a cloud
  service.
- The product does not expose raw command, PID, or task-scheduler controls in
  normal UI.

## Product shape

The first release is a Windows tray application with a desktop window. The
recommended implementation is an Electron shell because the repository and
runtime supervision code are already Node.js-based. The application has three
bottom-level destinations:

1. **Control** — service state, agent/runtime health, WeChat connectivity, and
   the upcoming supervision plan.
2. **Records** — Diary and Reports tabs.
3. **Settings** — startup, check-in range, report time, contextual durations,
   integration health, data location, and diagnostics.

Closing the window minimizes the application to the system tray. The tray menu
contains Open, Running/Quiet/Stopped, and Exit CyberBoss. Only Exit CyberBoss
terminates the desktop controller; closing the window does not stop supervision.

## Main control layout

The approved layout is **A: control-first**.

- The top card answers the primary question: Running, Quiet, Stopped, Starting,
  or Error.
- A primary power control starts or stops CyberBoss.
- A secondary mode control switches between Running and Quiet.
- Agent shows Codex in the first release. WorkBuddy and Custom are shown only as
  phase-two availability, not as selectable broken options.
- WeChat shows Connected, Reconnecting, Login required, or Error.
- The supervision plan lists exact deterministic checkpoints and their sources.
- Random supervision is shown as enabled with its configured range, for example
  `3–60 minutes`; the exact sampled time is intentionally hidden from the main
  UI so random supervision remains unpredictable.
- Friendly recent activity explains what changed, for example “Detected ‘going
  to shower’; follow-up scheduled for 21:30 and announced in WeChat.”

## Runtime states

### Running

- WeChat messages are received and answered.
- Random check-ins, explicit reminders, contextual follow-ups, and
  Zhijiantime-driven checkpoints can proactively act.
- Diary, timeline maintenance, and daily reports run normally.

### Quiet

- WeChat messages are still received and answered.
- Schedule and Zhijiantime synchronization continue.
- Diary/timeline maintenance and report generation may continue silently.
- Proactive WeChat check-ins and reminder messages are suppressed and retained
  as skipped/silent supervision outcomes rather than delivered later in a burst.

### Stopped

- The desktop controller remains available in the tray.
- Bridge, runtime, polling, reminders, diary/timeline activity, and report jobs
  do not run.
- On restart, deterministic missed work follows the catch-up policy; random
  check-ins are never replayed.

The desired state is persisted. If the desktop controller crashes and Windows
restarts it, the previous desired state is restored. An intentional Stopped
state must not be mistaken for a crash and automatically restarted into Running.

## Background process model

The desktop controller supervises the existing CyberBoss bridge and Codex App
Server. It starts all child and grandchild processes without visible Windows
console windows, redirects their output to local logs, and monitors health.

Windows startup and crash recovery remain implementation details. The existing
scheduled task may act as a watchdog for the desktop controller, but users do
not manage it directly. The desktop shortcut opens the installed control center,
not PowerShell. If the controller is already running, a second launch focuses
the existing window instead of creating another bridge.

Health is based on actual bridge/runtime readiness, not only process existence.
The controller owns shutdown ordering and cleans up only processes it started.

## Unified supervision plan

The first release introduces one durable supervision plan instead of allowing
independent random, reminder, and external-schedule paths to produce duplicate
actions. A checkpoint contains at least:

- stable ID and user/workspace scope;
- canonical task identity;
- source: random, conversation, context, Zhijiantime, or system report;
- source reference such as a Zhijiantime item ID;
- due time and timezone (`Asia/Shanghai` by default);
- state: pending, completed, superseded, skipped, or failed;
- whether and when the user was told;
- link and mutation fingerprint used for synchronization and echo suppression.

The plan is visible in the Control screen. Deterministic checkpoints may be
cancelled, delayed, or skipped from the UI. Random samples are represented only
as an enabled supervision source, not as a visible exact appointment.

## Trigger sources

### Random supervision

Random supervision keeps the existing configured range and gives the agent a
chance to act. It is lower priority than any explicit or external deterministic
checkpoint. A random check-in is discarded when newer user activity or a nearby
deterministic checkpoint makes it redundant.

### Explicit conversational commitments

When the user names a concrete delay or time, such as “twenty minutes later” or
“at 9 PM,” CyberBoss creates or reschedules a deterministic checkpoint. It
naturally confirms the follow-up in the same WeChat reply.

### Contextual commitments

When the user announces an activity such as eating or showering without a time,
CyberBoss infers a duration from an editable contextual-duration profile. The
initial default for eating and showering is 30 minutes. It tells the user
naturally, for example “Go ahead; I’ll check on you in about half an hour.”

Inferred times have the lowest authority. They yield immediately to an explicit
user time or a linked Zhijiantime time.

### Zhijiantime schedules and todos

CyberBoss reads the current day's schedules and todos and creates only useful
checkpoints, such as task start, intended finish, imminent deadline, or overdue
follow-up. It does not message for every item by default.

The available Zhijiantime MCP supports listing, creating, and updating schedules
and todos, so confirmed conversational changes can be written back when a
specific item is safely matched.

## Conflict resolution and synchronization

“Latest user arrangement” is the product rule, with source-aware behavior:

1. A new explicit WeChat arrangement takes effect immediately.
2. If it is linked unambiguously to a Zhijiantime item, CyberBoss updates that
   item as part of the same action and naturally reports that both were changed.
3. If a later Zhijiantime edit changes the linked time, the new external time is
   adopted immediately and CyberBoss sends a non-blocking correction notice:
   “Zhijiantime moved ‘edit résumé’ to 21:00. I’ll use 21:00 unless you tell me
   otherwise.”
4. No reply is required. If the user corrects the change, that new explicit
   message takes effect and is written back again.
5. Context-inferred checkpoints always yield to explicit WeChat or linked
   Zhijiantime arrangements.
6. Superseded checkpoints are retained for history but cannot fire.

Matching order is exact external ID, persisted link, then normalized title/date
and nearby time. An ambiguous match is never auto-written. CyberBoss asks which
item the user means or keeps the local checkpoint unlinked. A fingerprint of
CyberBoss's own external mutation prevents the resulting Zhijiantime sync echo
from being treated as a new user change.

## Diary and report records

The Records screen has two tabs.

### Diary

- Calendar navigation and chronological entries from local Markdown files.
- Search across dates and entry text.
- Read-only in the first release to avoid accidental edits to agent memory.
- A button opens the underlying local file for advanced use.

### Reports

- Daily report cards with date, generation status, generated-at time, and a
  preview of the timeline output.
- Open full report/dashboard, regenerate, and export the existing screenshot.
- Empty and failed states explain why no report exists.

The default daily report job runs at 00:30 Asia/Shanghai and closes the previous
calendar day. The time is editable in Settings. A report job performs the
nightly timeline cleanup, builds the timeline site, captures a report image, and
stores report metadata for the UI.

If the machine or service is unavailable, the next Running startup backfills
missing deterministic reports for up to the previous seven days. Random
check-ins are never backfilled. Backfill is silent unless a report fails.

## Settings

- Start with Windows.
- Default startup state: Running or Quiet.
- Random supervision enabled and min/max interval.
- Daily report enabled and generation time.
- Contextual activity durations, initially including eating and showering.
- WeChat account and connection health.
- Zhijiantime connection, last sync, and manual sync.
- Local data directory and open-folder action.
- Diagnostics with friendly summaries and an optional advanced raw-log view.

## Error handling

- Starting and stopping are explicit transient states; controls are disabled
  while the transition is in progress.
- Failed runtime or bridge health changes the top status to Error and provides
  a human-readable cause plus Retry.
- Repeated crashes use bounded backoff and stop after a configured threshold,
  leaving the controller alive in Error rather than opening repeated windows.
- Zhijiantime failure does not stop WeChat or local supervision. External-linked
  changes are marked pending sync and retried.
- Report failure does not block the next day's report and remains retryable from
  Records.
- Corrupt local state is backed up before recovery; unrelated diary and timeline
  files are never deleted automatically.

## Privacy and safety

- All diary, report, schedule-link, and supervision-plan data remain local.
- The UI does not expose WeChat identifiers or sensitive command lines by
  default.
- Zhijiantime writes occur only for an unambiguously linked item and under the
  user's approved automatic-writeback rule.
- The application never exposes the local control API beyond loopback.

## Verification and acceptance criteria

### Process lifecycle

- Launching the desktop shortcut opens the control center without a console.
- Closing the window leaves the tray controller and active supervision running.
- Running, Quiet, and Stopped survive controller restart correctly.
- Crashing a supervised child produces a bounded automatic restart without a
  visible terminal.
- A second app launch focuses the existing instance and cannot create a second
  bridge.

### Supervision behavior

- Explicit WeChat times create deterministic checkpoints and are announced.
- Eating/showering statements create announced inferred checkpoints using the
  configured duration.
- Random check-ins do not reveal an exact next time in the main UI.
- A WeChat reschedule updates a uniquely linked Zhijiantime item.
- A later Zhijiantime reschedule becomes effective, sends a non-blocking notice,
  and does not create a duplicate checkpoint.
- Ambiguous external matches are never modified automatically.
- Quiet mode suppresses proactive messages without blocking direct WeChat
  replies or causing a later message burst.

### Records and reports

- Existing Markdown diary files appear by date and are searchable.
- A daily report is generated at the configured time and appears in Reports.
- A missed report is backfilled on the next Running startup.
- Report failures are visible and retryable without stopping CyberBoss.

### Testing strategy

- Unit tests cover state transitions, timezone boundaries, checkpoint priority,
  deduplication, mutation-echo suppression, quiet-mode behavior, and report
  catch-up.
- Integration tests use fake Codex, WeChat, timeline, and Zhijiantime adapters.
- UI tests cover the A layout, tray close behavior, state controls, records, and
  friendly error displays.
- A Windows smoke test verifies auto-start, no visible console windows, crash
  restart, and one-instance enforcement.

## Delivery boundary

This specification defines the complete usable first release. WorkBuddy and
custom-agent support follow after the first release has proven stable. Their UI
entry points must not be enabled until their adapters pass the same lifecycle,
thread, tool, approval, and health contracts as Codex.
