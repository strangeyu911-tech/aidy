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
5. Start the executable from the real user launch surface and perform the
   acceptance path that matches the changed chain.
6. Apply the wording gate before reporting a result.

Do not skip a gate because a symptom looks familiar. If the evidence gate is
not met, stop at the lower confidence label.

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

## Safety boundaries

Do not force-push, reset, discard user changes, rebase without demonstrated
need, or manufacture duplicate checkpoints. Do not bulk-stage unrelated files.
Do not expose secrets or user content. Do not broaden a runtime fix while
writing this skill; a newly discovered independent production defect must be
recorded separately and stop scope expansion.
