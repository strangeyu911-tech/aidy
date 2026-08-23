# CyberBoss desktop control center implementation plan

**Status:** approved for implementation on 2026-08-23

**Source specification:** `docs/superpowers/specs/2026-08-23-desktop-control-center-design.md`

## Delivery strategy

Build the release as one desktop product but keep each subsystem independently
testable. The existing command-line entry points remain available throughout the
migration. The temporary PowerShell scheduled task is not changed until the new
controller has passed local lifecycle and single-instance smoke tests.

## Milestone 1 — controller and lifecycle

1. Add a durable desktop settings/state store with Running, Quiet, and Stopped
   desired states, schema validation, atomic writes, and corrupt-file recovery.
2. Add structured component logging, redaction, rotation, retention, and query
   support for the diagnostics screen.
3. Add a controller-owned process supervisor with hidden child windows,
   readiness probes, bounded restart backoff, verified process ownership, and
   graceful shutdown timeouts.
4. Refactor the bridge and random-checkin loop so they accept cancellation and
   publish health without changing the CLI behavior.
5. Add the Electron main process, sandboxed preload bridge, tray menu,
   single-instance handling, and Control/Records/Settings renderer shell.
6. Add Task Scheduler registration/migration commands, but do not activate the
   migration before the packaged controller passes smoke tests.

**Gate:** unit tests plus a Windows smoke run must prove that closing the window
keeps the controller alive, Exit closes owned children, a second launch focuses
the first, state persists, and no console window is created.

## Milestone 2 — unified supervision

1. Add an atomic supervision-plan store and history with deterministic source,
   priority, state, due time, announcement, link, and mutation fingerprint.
2. Replace the independent random poller with one dispatcher that applies
   Running/Quiet/Stopped policy and does not expose random sampled times.
3. Add explicit-time and contextual-language extraction. Eating and showering
   initially infer 30 minutes and return a natural announcement for the reply.
4. Integrate extraction into inbound WeChat turns and expose deterministic plan
   controls in the desktop UI.
5. Add quiet suppression history, cancellation/reschedule confirmation, mode
   cooldown, and undo.

**Gate:** policy and timezone tests prove no quiet replay, no random-time leak,
latest explicit arrangement wins, and context inference yields to explicit data.

## Milestone 3 — Zhijiantime synchronization

1. Add an adapter around the configured Zhijiantime MCP operations.
2. Poll today's schedules and todos and normalize external items.
3. Match by external ID/link first, then normalized title/date/nearby time; never
   write an ambiguous match.
4. Write an explicit WeChat reschedule back to an unambiguously linked item.
5. Adopt later external changes, queue a non-blocking correction notice, and
   suppress mutation echoes by fingerprint.
6. Expose connection, last sync, manual sync, pending writes, and degraded
   errors in Settings.

**Gate:** fake-adapter integration tests cover latest-arrangement conflict
resolution, echo suppression, ambiguity, retries, and operation while offline.

## Milestone 4 — records, reports, and data safety

1. Add read-only diary indexing/search over existing local Markdown files.
2. Add report metadata and report asset discovery to Records.
3. Add a 00:30 Asia/Shanghai previous-day scheduler and a persisted seven-day
   catch-up queue with 60-second health delay, concurrency one, retry at 1/5/30
   minutes, Stop/Resume, and live-work yielding.
4. Add manual regeneration and existing timeline screenshot preview/open/export.
5. Add versioned manual/automatic backup, narrow exports, retention, safe archive
   validation, staged restore, pre-restore backup, atomic swap, and rollback.

**Gate:** report queue tests cover midnight/DST-safe calendar calculations,
ordering, pause/restart persistence, failure isolation, and retry exhaustion;
backup tests cover traversal, checksum failure, and rollback.

## Milestone 5 — hardening and release migration

1. Complete friendly error taxonomy and repair actions in the renderer.
2. Add accessibility, renderer, fault-injection, process-ownership, disk-full,
   and migration tests.
3. Package the Windows controller and create the desktop shortcut.
4. Transactionally replace the temporary PowerShell scheduled task with the
   packaged controller task and verify exactly one healthy process tree.
5. Run the 24-hour soak gate and record process, handle, memory, child-count,
   log-size, report, and check-in observations.

**Gate:** all acceptance criteria in the approved specification pass. The old
scheduled task is removed only after the new controller task is validated.

## Commit discipline

Each milestone is split into small commits for stores/policy, controller,
renderer, integrations, and tests. Unrelated existing and untracked workspace
files are preserved. The temporary background script and `.superpowers`
visual-companion artifacts are not included in product commits unless explicitly
promoted later.
