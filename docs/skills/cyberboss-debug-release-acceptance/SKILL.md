# CyberBoss Debug / Release Acceptance Skill

## Contract and use

This repository currently has no formal Skill loader. The root `AGENTS.md` is
the project-local entry point: an Agent working on CodeBuddy / WorkBuddy,
WeChat delivery, packaging, or release acceptance must read this file first.
For a manual invocation, run `Get-Content -Raw
docs/skills/cyberboss-debug-release-acceptance/SKILL.md` and then follow the
gates below. Run `npm run verify:acceptance-skill` before committing changes to
this skill.

This skill is an evidence-driven runbook. It does not authorize changes to
production behavior, credentials, user messages, or launch shortcuts. Record
sanitized evidence only; never print message bodies, credentials, tokens, or
private payloads.

## Operating sequence

Use this order for a production-behavior change:

1. Establish scope, branch, checkpoint, working-tree state, and the actual
   launch surface.
2. Test the smallest relevant automated path and collect correlation-linked
   evidence.
3. Diagnose from evidence, separating facts, strongest hypothesis, and an
   unproven historical momentary cause.
4. Update the source, run the relevant tests and checks, and inspect the
   packaged artifact.
5. **Land the work in commits before building.** The artifact freshness check
   derives its baseline from the newest commit that touched a packaged path, so a
   commit made *after* a build pushes the baseline past it and marks every
   artifact stale. Committing first and packaging second leaves the baseline
   before the artifacts, which is the state the gate wants. This also covers work
   that was already sitting uncommitted in the tree: the build packs the tree, so
   that work is inside the artifacts either way — record it in a commit *before*
   packaging rather than leaving it uncommitted.
   A docs-only or test-only commit does not touch a packaged path and therefore
   does not move the baseline; verify that by re-running the gate after committing.
6. Start the executable from the real user launch surface and perform the
   acceptance path that matches the changed chain.
7. Apply the wording gate before reporting a result.

Do not skip a gate because a symptom looks familiar. If the evidence gate is
not met, stop at the lower confidence label.

## Incident Scene Preservation

When the currently running CyberBoss / Aidy instance is still failing and the
root cause has not been proven, preserve that live incident before changing
the instance. Stopping Aidy, its managed bridge/runtime, poller, WorkBuddy, or
WeChat; switching to a new `dist`; overwriting the running artifact; rebuilding
`app.asar`; restarting for new instrumentation; clearing cursor, queue, or
session state; rebuilding the runtime; and re-login are all potentially
state-changing diagnostic actions. Treat each as a **destructive diagnostic
action** until its effect on the incident is understood.

### Phase A — Live Incident RCA

The goal of Phase A is to explain why this particular live instance failed.
Keep it alive, maximize read-only evidence, save a sanitized **Live Incident
Evidence Snapshot**, run only controlled non-destructive experiments, and
identify the last successful node, first failed node, and causal chain as far
as the evidence allows. Insufficient observability is not a reason to restart
immediately. If the available evidence cannot prove the cause, end the phase
as `INCIDENT_UNRESOLVED`; do not reconstruct the old cause from a later
recovery.

Before any destructive diagnostic action, save the fields that are available
and relevant to the incident: timestamp; branch / HEAD; actual running
artifact and hashes or `app.asar` provenance; process tree, PIDs, and
parent/child ownership; Start Menu target; runtime, bridge, and transport
state; active requests and correlation IDs; last successful and first failed
operations; safe cursor / sync-token summary; queue lengths; pending turn;
session ID; retry, timeout, and abort-controller state; the last relevant log
events; relevant network/socket errors; and the exact failure reproduction
timestamp. Never save credential, token, cookie, message-body, or other
private payloads in the snapshot.

### Phase B — Future Observability Hardening

Only after Phase A has captured the available evidence, or after the user has
explicitly accepted that the old incident cannot be proved further, may the
investigation move to Phase B. This phase may add instrumentation, traces,
log fields, error causes, cursor/session summaries, or a new package and
instance. Its purpose is to make the next recurrence easier to prove. A
restarted or replaced instance cannot prove the root cause of the previous
live incident. Therefore, recovery after instrumentation or restart is not
historical RCA evidence.

## Destructive Diagnostic Gate

When the incident is still `ROOT_CAUSE_NOT_YET_PROVEN` or
`INCIDENT_UNRESOLVED` and the failing instance still exists, do not restart,
rebuild, reset, clear state, switch artifacts, or otherwise mutate it until
the operator records answers to all of these questions:

1. Has enough evidence from the current live incident been saved?
2. Will this action destroy or change the failure state?
3. Is there a non-destructive way to collect the missing evidence?
4. If the action makes the failure disappear, can the old root cause still be
   proven independently?
5. Has it been explicitly accepted that the result may only be
   `RECOVERED_BUT_ROOT_CAUSE_NOT_PROVEN`?

If any answer is missing, the default is to preserve the instance and continue
read-only investigation. A restart or replacement is allowed when data
corruption, flood / spam, credential or security risk, material side effects,
or an explicit availability-first user choice makes recovery urgent. Even in
that exception, first capture the maximum available snapshot, record the
destructive action and the RCA evidence boundary, and never present
post-restart recovery as proof of the old root cause.

## ACP / WorkBuddy protocol

Never infer an ACP contract from a WorkBuddy software version number. Resolve
`session/new`, `session/resume`, and related fields in this order:

1. runtime capability;
2. the actual protocol contract;
3. a measured result from the current runtime.

`cwd` is verified to work with WorkBuddy 2.132.0. Do not replace it with
`workingDirectory` merely because a version changed. A variant fallback is
allowed only after explicit `Invalid params` evidence for the first variant;
keep the fallback controlled, logged, and scoped to the affected binding.

For a protocol mismatch, capture the method, sanitized parameter names,
status, content type, and JSON-RPC error. Do not claim a root cause from a
client-side timeout or a version label alone.

## Session / transport lifecycle

Keep these states distinct in logs and reasoning:

- persisted session ID;
- in-process attached session;
- transport generation;
- request/prompt timeout;
- disconnect or connection-lost;
- managed child error or exit;
- adapter close.

An attachment is valid only for its transport generation. A timeout by itself
must not invalidate the attachment or force `new`/`resume`. When the transport
generation changes, or there is explicit connection loss, clear the old
attachment while retaining the persisted session ID. The next use follows the
existing resume path. If resume fails, apply the existing fallback-to-new
semantics only to the affected binding; do not reset unrelated sessions.

When investigating this area, record the old/new generation, attach action,
persisted session ID (redacted or hashed where appropriate), disconnect/exit
signal, and adapter-close reason. Do not collapse those fields into a single
“session failed” flag.

## Evidence-first debugging

Every incident note must have three explicit labels:

- **Confirmed facts:** directly observed logs, test results, runtime state, or
  artifact contents.
- **Strongest hypothesis:** the explanation currently best supported by those
  facts.
- **Unproven historical cause:** the first-failure moment or lower-level cause
  only if it was actually demonstrated; otherwise say it remains unproven.

Correlation or a lifecycle mismatch can establish a correlation/lifecycle
diagnosis without proving the exact instant or underlying cause of the first
failure. Never promote a symptom-shaped guess to root cause.

## Observability

Prefer one sanitized correlation ID across the complete path:

`微信 inbound → dispatcher → session attach/new/resume → ACP request → SSE → runtime completion/failure → reply → sender queue → sender attempt → sender result`

For each relevant leg, inspect as available:

- correlation ID, session ID, and transport generation;
- attach action;
- HTTP status and content type;
- SSE event count and terminal signal;
- JSON-RPC error;
- runtime elapsed time;
- sender enqueue, attempt, and success;
- retry, duplicate, proactive flood, and typing cleanup signals.

Sanitize all evidence. Absence of wire telemetry means “not observed”, not a
passing claim about typing cleanup.

## Source vs actual runtime

Source edits alone are never a release acceptance. If only source changed,
report exactly:

> 源码已修复，但运行包尚未更新，因此用户当前实际运行版本仍未修复。

Before using “fixed”, “available”, or “acceptance pass”, confirm all of:

- the user's actual packaged artifact was rebuilt after the change;
- `app.asar` or its equivalent contains the changed source;
- the started executable path is inside that latest artifact;
- source-mode did not silently substitute for the packaged runtime.

Keep source, package, launched executable, and observed behavior as separate
evidence rows.

## Windows packaged build

On `EBUSY` or a locked Electron/Windows artifact, first identify the concrete
lock holder. If it is an old CyberBoss packaged runtime, it is safe to stop
CyberBoss, rebuild, start the new packaged executable, and verify its actual
path. Do not stop WorkBuddy without independent evidence that it is the lock
holder or must be stopped. Do not create a collection of long-lived backup
`dist` directories just to evade a lock.

### Target order (both targets share one `appOutDir`)

`nsis` and `portable` both pack into `appOutDir=dist/win-unpacked`, so whichever
runs second must clear the first one's output. That clearing is subject to the
host's bulk-delete guard (50 deletions per tool call), and the guard failure is
destructive: it aborts the target *and* leaves `dist/win-unpacked` gutted —
`resources/app.asar` disappears, so the directory looks present but is unusable.

Run them in the one order that needs no deletions at all — make each target start
from an absent `win-unpacked`:

1. If `dist/win-unpacked` exists, **move it aside** (rename, not delete).
2. `node ./node_modules/electron-builder/out/cli/cli.js --win nsis`
3. `node ./scripts/build-portable.js --prepackaged dist/win-unpacked`
   — `--prepackaged` reuses the step-2 directory and skips the second `emptyDir`.
   `build-portable.js` patches `NsisTarget.js` before forwarding its arguments.
4. Re-run the Start Menu sync separately (`scripts/sync-start-menu-shortcut.ps1`
   is self-verifying and throws on a target mismatch); a `&&` chain that breaks
   early skips it silently.

Never run `build-portable.js` without `--prepackaged` while `dist/win-unpacked`
exists. If portable genuinely must repack the directory, move it aside first.

Leftover directories used by this dance are rebuildable artifacts: remove them
after the build succeeds, and confirm the removal independently (an `fs.exists`
check, not just the deleting command's exit code).

### Byte-level content checks

To decide whether a packaged build contains a given change, count the marker
strings in `dist/win-unpacked/resources/app.asar`. Search **bytes**, not a decoded
string: a `latin1` decode followed by `split()` can never match a non-ASCII
marker and yields a false zero.

```js
const buf = fs.readFileSync("dist/win-unpacked/resources/app.asar");
const count = (needle) => { const nb = Buffer.from(needle, "utf8"); let c = 0, i = 0;
  while ((i = buf.indexOf(nb, i)) !== -1) { c++; i += nb.length; } return c; };
```

`app.asar`'s SHA-256 is the cheap way to tell "the rebuild just repacked the same
content" from "the rebuild changed something". An identical hash after committing
work that was already in the tree is the expected, healthy result. A file-count
difference between the two targets is also expected: `nsis` emits
`resources/app-update.yml` and `portable` does not. That file is dead metadata
here (`build.publish` is null, nothing reads `autoUpdater`) — not a regression.

## Launch surface

CyberBoss users primarily launch from the Windows Start Menu. Any formal
runtime update must check that the Start Menu shortcut still targets the
verified packaged executable. A missing desktop shortcut or scheduled task is
only a recorded status; do not install one without an explicit request.

## Real WeChat acceptance

After a production-behavior change has passed automation and the actual
packaged runtime is updated, perform exactly one final real-message acceptance
when the changed path requires it. Select the path by the change boundary:

- outbound-only change: CyberBoss → user's WeChat proactive test is sufficient;
- change spanning `微信 inbound → dispatcher → ACP session → runtime turn →
  reply → 微信`: proactive outbound cannot substitute for inbound. First
  complete all automatable checks, then request exactly one ordinary inbound
  WeChat message only when it cannot be automatically substituted.

The final record must check message arrival, exactly once, no duplicate, no
unexpected retry, no proactive flood, and no sender/queue/runtime anomaly. If
typing cleanup has evidence, verify it; without wire telemetry mark it
unobserved rather than inventing a pass. Do not repeat the real message merely
because another agent changed a runbook or skill with no production behavior
change.

## PASS wording gate

Use the strongest wording supported by the complete path:

| Evidence actually available | Allowed wording |
| --- | --- |
| source changed and relevant local tests pass | `source fixed only` |
| source changed; packaged build not rebuilt/inspected | `packaged build pending` |
| automation passes; real chain not exercised | `automated tests pass, real-chain unverified` |
| some layers pass, required evidence missing | `partially verified` |
| explanation lacks direct proof | `hypothesis only` |
| required action cannot proceed | `blocked` |
| all applicable source, package, launch-surface, and real-path gates pass | `FIXED`, `AVAILABLE`, or `ACCEPTANCE PASS` |

Do not use `FIXED`, `AVAILABLE`, or `ACCEPTANCE PASS` when any applicable gate
is missing.

## Runbook cases: symptom → evidence → diagnosis → safe action

These are prior incident patterns, not symptom-to-root-cause shortcuts. The
evidence column is a gate: without it, retain a hypothesis-only diagnosis.

1. **微信显示“对方正在输入”但没有回复** → correlate inbound,
   dispatcher, runtime terminal signal, reply, sender queue/attempt/result,
   and typing cleanup → strongest diagnosis may be a runtime or sender
   lifecycle gap; the display alone does not prove it → inspect terminal and
   sender evidence, then make one controlled acceptance attempt.
2. **`workingDirectory` rejected while `cwd` works** → capture the exact
   `Invalid params` JSON-RPC error and a successful `cwd` probe → the current
   contract accepts `cwd` → keep `cwd`; permit a variant only after explicit
   rejection and scope it to that binding.
3. **Attached session reused across transport lifecycle** → compare attach
   action, persisted ID, and transport generations around disconnect/restart →
   attachment crossed a generation boundary → clear the attachment, retain
   persisted ID, and use the existing resume path.
4. **Prompt timeout** → distinguish timeout from disconnect, child exit, and
   adapter close using lifecycle and generation evidence → timeout alone does
   not prove transport loss or require new/resume → preserve the attachment
   unless explicit connection-loss evidence exists.
5. **Proactive backlog / duplicate sends** → inspect correlation, queue depth,
   enqueue/attempt/success counts, retry markers, and duplicate/flood windows →
   diagnose only the evidenced queue/retry behavior → stop the duplicate source
   or drain via the existing safe control path; do not add blind retries.
6. **Portable / unpacked concurrency causes abnormal files** → record process
   paths, PIDs, artifact paths, and overlapping start times → concurrent
   packaged runtimes or shared files are the supported hypothesis → serialize
   launch/build and identify the real process; do not delete broad directories.
7. **`app.asar` lacks the previous source fix** → inspect the archive contents
   and build timestamp against the source checkpoint → packaged artifact is
   stale → rebuild the intended artifact and verify its contents before
   launching.
8. **Start Menu shortcut targets an old or missing executable** → resolve the
   shortcut target and compare it with the verified packaged executable → launch
   surface drift is confirmed → update the shortcut through the existing sync
   flow, then verify the target; do not install unrelated shortcuts.
9. **Electron / Windows artifact locked by a running process** → identify the
   concrete PID and executable path holding the lock → if it is old CyberBoss,
   stop only that process → rebuild, restart the new package, and verify path;
   preserve WorkBuddy unless independently implicated.
10. **Source-mode test passes but packaged runtime is stale** → compare the
    tested mode, package contents, launched executable path, and observed user
    behavior → source-mode success is insufficient → report
    `automated tests pass, real-chain unverified` or `packaged build pending`
    until the actual packaged path is exercised.
11. **`getupdates → inbound.received` stops producing inbound correlation** →
    preserve the live instance, snapshot polling / bridge / cursor / queue /
    process evidence, and perform only non-destructive experiments before
    changing the package → if the cause remains unproven, record
    `INCIDENT_UNRESOLVED` → only then add instrumentation and restart for the
    next recurrence. If the changed instance recovers, record
    `RECOVERED_BUT_ROOT_CAUSE_NOT_PROVEN`; it does not distinguish a half-dead
    poller, stale cursor, stale bridge session, transient network, state
    recovery defect, or another cause without independent pre-restart proof.

## Safety boundaries

Do not force-push, reset, discard user changes, rebase without demonstrated
need, or manufacture duplicate checkpoints. Do not bulk-stage unrelated files.
Do not expose secrets or user content. Do not broaden a runtime fix while
writing this skill; a newly discovered independent production defect must be
recorded separately and stop scope expansion.
