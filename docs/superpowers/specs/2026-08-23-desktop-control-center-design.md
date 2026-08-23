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

State controls use asymmetric safeguards. Starting from Stopped requires one
click. Switching between Running and Quiet applies immediately, disables the
mode control for two seconds, and shows a ten-second Undo toast. Entering
Stopped always requires a confirmation dialog that names what will stop. If a
turn, report, synchronization, or backup is active, the dialog also offers
“finish current work, then stop” as the default and “stop now” as the secondary
action. Multi-select cancellation or rescheduling of more than one checkpoint
requires a summary confirmation before any item changes.

## Runtime states

### Running

- WeChat messages are received and answered.
- Random check-ins, explicit reminders, contextual follow-ups, and
  Zhijiantime-driven checkpoints can proactively act.
- Diary, timeline maintenance, and daily reports run normally.

### Quiet

- WeChat messages are still received and answered.
- Schedule and Zhijiantime synchronization continue.
- Diary/timeline maintenance, backup, and report generation continue silently.
- A random check-in that becomes due is discarded with outcome
  `suppressed_quiet`.
- A deterministic conversational, contextual, or Zhijiantime checkpoint that
  becomes due is archived with outcome `suppressed_quiet`, its original due
  time, and source preserved. It is not delayed and is never replayed when
  Running resumes.
- The Records and supervision-history views show suppressed checkpoints so the
  user can manually reschedule one if it still matters.
- The first release has no “critical reminder bypass” for Quiet. This keeps the
  state promise unambiguous: Quiet never sends proactive WeChat messages.

### Stopped

- The desktop controller remains available in the tray.
- Bridge, runtime, polling, reminders, diary/timeline activity, and report jobs
  do not run.
- On return to Running or Quiet, only missed daily reports follow the report
  catch-up policy. User-facing conversational, contextual, Zhijiantime, and
  random checkpoints are never replayed.

The desired state is persisted. If the desktop controller crashes and Windows
restarts it, the previous desired state is restored. An intentional Stopped
state must not be mistaken for a crash and automatically restarted into Running.

## Background process model

The Electron main process is the desktop controller and sole application-level
supervisor. The renderer is an unprivileged view: Node integration is disabled,
context isolation is enabled, and a narrow preload API exposes only typed state
and commands. The renderer cannot spawn processes, read arbitrary files, access
credentials, or write logs directly.

The controller, CyberBoss bridge, Codex App Server, Code Mode host, MCP servers,
and timeline commands run as the current non-administrator Windows user. The
first release never requests elevation. There is no dedicated log process;
each owned component writes through the shared logging contract to its own file.

The controller starts all owned processes without visible console windows and
assigns them to one Windows Job Object configured with kill-on-job-close. The
job contains the controller's supervised bridge/runtime tree, including
grandchildren where Windows permits assignment. Every launch also carries a
random instance token, executable path, parent relationship, PID, and process
start time in the owned-process registry. The registry is used only after all
fields match; CyberBoss never kills every `node.exe` or `codex.exe` process.

Startup order is strict:

1. acquire the single-instance mutex and load desired state;
2. initialize state recovery and component loggers;
3. start Codex App Server and wait for its readiness probe;
4. start the CyberBoss bridge and wait for bridge/channel health;
5. enable supervision dispatch and publish Running or Quiet to the UI.

If Codex App Server fails, the bridge is stopped before the runtime is replaced.
Child restart uses delays of 1, 5, and 30 seconds. Three failures within ten
minutes open the circuit and leave the controller alive in Error until manual
Retry or the next configured recovery window.

Graceful shutdown runs in reverse ownership order:

1. stop accepting new supervision and UI mutations;
2. finish or cancel the active operation according to the user's stop choice;
3. stop the bridge and wait up to ten seconds;
4. stop Codex App Server and its hosts and wait up to fifteen seconds;
5. terminate only verified remaining members of the owned Job Object;
6. flush logs for up to two seconds and persist the final desired state.

Backup archive finalization, restore validation, atomic restore swap, and
rollback are non-interruptible safety boundaries. If one is active, Stop waits
for that boundary to finish and does not offer “stop now.”

On controller startup, stale registry entries are compared with live executable
path, start time, instance token, and parent chain. A fully verified orphan is
terminated before a new tree starts. A partial or ambiguous match is never
killed automatically; it is shown as a diagnostic warning. A 24-hour Windows
soak test monitors handle count, child count, and resident memory for unbounded
growth.

Health is based on actual bridge/runtime readiness, not only process existence.
Closing the window destroys only its renderer; the controller and tray remain.

## Windows startup and watchdog ownership

Windows Task Scheduler is the sole operating-system startup and crash watchdog
in the first release. The application does not also register itself in the
Startup folder or the Run registry key. The “Start with Windows” setting only
enables or disables the Task Scheduler logon trigger.

The task launches the desktop controller, never PowerShell, the bridge, or Codex
directly. It uses `IgnoreNew`, restarts only when the controller exits
abnormally, and does not restart a successful intentional Exit. The controller
holds the single-instance mutex; desktop-shortcut, task, and update launches all
focus the existing instance and exit without spawning another process tree.

Migration from the temporary PowerShell task is transactional: disable the old
task, stop and verify its owned bridge, register the controller task, validate a
single healthy instance, then remove the old action. Failure rolls back to one
disabled task and an actionable error; it never leaves two enabled watchdogs.

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

If the machine or service is unavailable, missing deterministic reports for up
to the previous seven days enter a low-priority backfill queue. The queue is
created after state recovery and starts only when the controller has been
healthy for 60 seconds. It runs in both Running and Quiet, but pauses in Stopped.

Backfill processes dates from oldest to newest with concurrency one. Only one
timeline build or screenshot capture may run at a time. User messages, due live
checkpoints, state changes, and manual report requests have priority; backfill
finishes the current atomic file write, then yields before starting the next
date. Each failed date retries after 1, 5, and 30 minutes, then remains Failed
with a manual Retry action. A failure never blocks later dates.

The Records page shows backfill progress and Stop Backfill. Stopping cancels the
current cancellable child process, preserves completed dates, marks untouched
dates Paused, and prevents automatic continuation until Resume Backfill or the
next user-approved catch-up run. Random check-ins are never backfilled.

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
- Data management with Create Backup, Export Diary, Export Reports, Restore, and
  automatic-backup retention.

## Logging and diagnostics

The logging contract has four levels: DEBUG, INFO, WARN, and ERROR. Production
defaults to INFO. DEBUG can be enabled from Diagnostics for 30 minutes or until
manually disabled; the UI always displays the remaining debug window.

Components write separate UTF-8 JSON-lines files for desktop/controller,
bridge/channel, runtime/Codex, integrations, and reports. Message bodies, diary
content, context tokens, credentials, API keys, full command arguments, and raw
WeChat identifiers are redacted before writing. A stable local pseudonym may be
used for correlation.

Each file rotates at 10 MB. Up to five rotated files per component and no more
than 14 days are retained, with a total logs-directory cap of 200 MB. Cleanup
runs after rotation and once per day, deleting oldest rotated files first; the
active file is never deleted. Disk-full handling stops DEBUG logging first,
emits one bounded ERROR where possible, and leaves supervision operational.

Advanced Logs supports component, level, date range, and text filters, newest
first. It can copy a redacted event or create a redacted diagnostic bundle. Raw
unredacted logs are not exposed because they are never stored.

## Error handling

- Starting and stopping are explicit transient states; controls are disabled
  while the transition is in progress.
- Every surfaced error has a category, affected capability, plain-language
  summary, timestamp, retry state, and one primary repair action.
- Network errors explain which service is unreachable and offer Retry plus
  proxy/network guidance without stopping unrelated local features.
- Authentication errors identify WeChat or Codex and offer Re-login or Open
  account setup.
- Permission errors name the inaccessible folder or operation and offer Choose
  another folder or Run diagnostics; the app never suggests administrator mode
  as the default repair.
- Corrupt-data errors identify the affected store, preserve the original,
  create a recovery backup, and offer Restore last good backup.
- Process errors identify Bridge, Codex App Server, Code Mode host, or MCP,
  display restart attempts, and offer Restart component or Open diagnostics.
- Third-party errors identify WeChat, Zhijiantime, or timeline/report service,
  show degraded capabilities, and offer Reconnect or Retry sync while CyberBoss
  continues unaffected functions.
- Disk-capacity errors show the affected path and offer Open data folder and
  Clean expired logs/backups.
- Repeated crashes use bounded backoff and stop after three failures in ten
  minutes, leaving the controller alive in Error rather than opening repeated
  windows.
- Zhijiantime failure does not stop WeChat or local supervision. External-linked
  changes are marked pending sync and retried.
- Report failure does not block the next day's report and remains retryable from
  Records.
- Corrupt local state is backed up before recovery; unrelated diary and timeline
  files are never deleted automatically.

## Backup, export, and restore

Create Backup produces a versioned archive containing settings, supervision
plan/history, diary, timeline data, report metadata, and report assets. The
default backup excludes WeChat/Codex credentials, tokens, inbox attachments,
and logs. Export Diary and Export Reports create narrower portable archives.

Automatic backups run before schema migration, before corrupt-state recovery,
and once daily after a successful report. The app retains seven daily and four
weekly automatic backups. Manual backups are never deleted automatically; the
UI shows their size and creation time.

Restore requires Stopped state and a confirmation showing which data classes
will be replaced. The app validates the archive version, manifest, checksums,
and expected paths; creates a pre-restore backup; restores into a staging
directory; validates the staged state; then performs an atomic directory swap.
If validation or swap fails, the pre-restore state is restored automatically.
Credentials remain untouched unless a future encrypted full-backup format is
explicitly added.

## Privacy and safety

- All diary, report, schedule-link, and supervision-plan data remain local.
- The UI does not expose WeChat identifiers or sensitive command lines by
  default.
- Zhijiantime writes occur only for an unambiguously linked item and under the
  user's approved automatic-writeback rule.
- The application never exposes the local control API beyond loopback.
- Backup manifests reject absolute paths, parent traversal, and unexpected file
  types before extraction.

## Verification and acceptance criteria

### Process lifecycle

- Launching the desktop shortcut opens the control center without a console.
- Closing the window leaves the tray controller and active supervision running.
- Running, Quiet, and Stopped survive controller restart correctly.
- Crashing a supervised child produces a bounded automatic restart without a
  visible terminal.
- A second app launch focuses the existing instance and cannot create a second
  bridge.
- Only Task Scheduler owns auto-start/watchdog behavior; Startup-folder and Run
  registry entries are absent.
- Verified owned orphans are removed at startup, while ambiguous processes are
  reported and left untouched.
- Shutdown follows the specified timeouts and leaves no owned Job Object member.

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
- Quiet-due deterministic checkpoints are archived as `suppressed_quiet`, random
  samples are discarded, and neither is replayed on resume.

### Records and reports

- Existing Markdown diary files appear by date and are searchable.
- A daily report is generated at the configured time and appears in Reports.
- A missed report enters backfill after the next Running or Quiet recovery has
  remained healthy for 60 seconds.
- Backfill waits for 60 seconds of health, runs one date at a time, yields to live
  work, supports Stop/Resume, and applies the specified retry schedule.
- Report failures are visible and retryable without stopping CyberBoss.

### Interaction, errors, logs, and data safety

- Running/Quiet switching has cooldown and Undo; stopping requires confirmation
  and handles active work explicitly.
- Each defined error category shows the correct impact and repair action.
- Logs rotate at 10 MB, respect file/age/total caps, redact sensitive content,
  and can be filtered by component, level, date, and text.
- Manual backup, diary/report export, validated restore, rollback, and automatic
  retention work without changing credentials.

### Testing strategy

- Unit tests cover state transitions, timezone boundaries, checkpoint priority,
  deduplication, mutation-echo suppression, quiet-mode behavior, and report
  catch-up.
- Integration tests use fake Codex, WeChat, timeline, and Zhijiantime adapters.
- UI tests cover the A layout, tray close behavior, state controls, records, and
  friendly error displays.
- A Windows smoke test verifies auto-start, no visible console windows, crash
  restart, and one-instance enforcement.
- Fault-injection tests cover network, authentication, permission, corruption,
  process, integration, and disk-capacity failures.
- Backfill tests verify ordering, concurrency one, live-work preemption,
  cancellation, retry exhaustion, and restart persistence.
- Process tests verify Job Object cleanup, graceful timeout escalation, orphan
  matching, and that unrelated Node/Codex processes are never terminated.
- Backup tests reject traversal and checksum failures and verify atomic rollback.
- A 24-hour Windows soak test asserts bounded process, handle, memory, and log
  growth.

## Delivery boundary

This specification defines the complete usable first release. WorkBuddy and
custom-agent support follow after the first release has proven stable. Their UI
entry points must not be enabled until their adapters pass the same lifecycle,
thread, tool, approval, and health contracts as Codex.

Implementation is decomposed into five gated milestones within the release:

1. desktop controller, single-instance lifecycle, Task Scheduler migration,
   Job Object ownership, silent process launch, logging, and three-state shell;
2. unified supervision store and dispatcher, Quiet semantics, deterministic and
   contextual checkpoints, and Control screen;
3. Zhijiantime read/write synchronization, matching, conflict resolution,
   mutation-echo suppression, and degraded-mode errors;
4. Diary and Reports UI, daily generation, bounded backfill, backup/export, and
   validated restore;
5. fault injection, migration validation, accessibility/UI tests, Windows smoke
   tests, and the 24-hour soak gate.

Each milestone must pass its own tests without weakening the process, privacy,
or data-recovery contracts before the next milestone begins.
