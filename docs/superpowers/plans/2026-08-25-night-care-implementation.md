# CyberBoss Night-Care Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace task/planning pressure with naturally timed sleep encouragement from 00:00 through 06:00 and suppress all proactive messages after explicit or inferred sleep without replaying skipped work in the morning.

**Architecture:** Add a durable night-window state store, a fail-closed local sleep/wake phrase classifier, and a pure timezone-aware policy evaluated before supervision dispatch. Record inbound activity before model execution, preserve existing random/fixed timing, deduplicate night-care messages in the system queue, and surface replacement/suppression outcomes in Control and Records.

**Tech Stack:** Node.js 22 CommonJS, `Intl.DateTimeFormat`, existing `AtomicJsonStore`, supervision plan/dispatcher, system-message queue, Electron renderer, `node:test` with injected clocks.

**Spec:** `docs/superpowers/specs/2026-08-25-api-first-multi-runtime-night-care-design.md`

## Global Constraints

- Night care is active from 00:00 inclusive through 06:00 exclusive in the configured user timezone.
- `explicitSleep` and `inferredSleep` are distinct and carry the current local night-window date.
- At 06:00, both flags and the 90-minute inactivity baseline are cleared and never carry into another local date.
- At the next 00:00, the inactivity baseline starts at the window boundary; a later inbound message restarts it.
- Local phrase classification is high precision and low recall. Exceptions or malformed results yield no intent and cannot break inbound handling.
- A working model may add structured intent later, but model availability is never required for the deterministic safety policy.
- Running mode keeps ordinary random timing; user-agreed fixed checkpoints keep their due time. Only the message intent changes to sleep care.
- Quiet and Stopped behavior remains authoritative; night care never bypasses Quiet.
- After explicit sleep or 90 minutes of night-window inactivity, every proactive message is suppressed.
- Replaced/suppressed work retains source and due time, appears in history, and is never replayed after 06:00.
- Preserve unrelated untracked `.superpowers/` and `scripts/cyberboss-background.ps1` files.

---

## File map

### New files

- `src/core/night-intent.js` — deterministic sleep/wake phrase classification.
- `src/core/night-care-activity-inbox.js` — atomic, no-message-text bridge-to-controller event spool.
- `src/core/night-care-state-store.js` — durable explicit/inferred state and night baseline.
- `src/core/night-care-policy.js` — timezone window and checkpoint decision functions.
- `test/night-intent.test.js`
- `test/night-care-activity-inbox.test.js`
- `test/night-care-state-store.test.js`
- `test/night-care-policy.test.js`
- `test/night-care-inbound.test.js`
- `test/night-care-dispatcher.test.js`

### Modified files

- `src/core/config.js`
- `src/core/app.js`
- `src/core/supervision-policy.js`
- `src/core/supervision-plan-store.js`
- `src/core/system-message-queue-store.js`
- `src/desktop/supervision-dispatcher.js`
- `src/desktop/main.js`
- `src/desktop/renderer/renderer.js`
- `README.md`, `README.zh-CN.md`, `README.en.md`, `package.json`

---

### Task 1: Fail-closed local sleep and wake intent classifier

**Files:**
- Create: `src/core/night-intent.js`
- Create: `test/night-intent.test.js`

**Interfaces:**
- Produces: `classifyNightIntent(text) -> "sleep" | "wake" | ""`.
- Produces: `safeClassifyNightIntent(text, { classify }) -> { intent, errorCode }`.

- [ ] **Step 1: Write failing high-precision and exception tests**

```js
test("recognizes explicit sleep and wake messages", () => {
  for (const text of ["我准备睡觉了", "晚安", "我先去睡了", "困了，准备睡"]) {
    assert.equal(classifyNightIntent(text), "sleep");
  }
  for (const text of ["我醒了", "起床了", "早安", "早上好，我起来了"]) {
    assert.equal(classifyNightIntent(text), "wake");
  }
});

test("does not mark negated or ambiguous sleep wording", () => {
  for (const text of ["我还没睡", "今晚不睡了", "睡不着", "这个办法太催眠了"]) {
    assert.equal(classifyNightIntent(text), "");
  }
});

test("classifier exception yields no intent", () => {
  assert.deepEqual(safeClassifyNightIntent("晚安", { classify() { throw new Error("boom"); } }), {
    intent: "",
    errorCode: "NIGHT_INTENT_CLASSIFIER_FAILED",
  });
});
```

- [ ] **Step 2: Run and confirm missing-module failures**

Run: `node --test ./test/night-intent.test.js`

Expected: FAIL because `night-intent.js` does not exist.

- [ ] **Step 3: Implement normalized, negation-aware phrase rules**

```js
const NEGATED_SLEEP = /(还没睡|没睡|不睡|睡不着|不能睡|别睡|不要睡)/u;
const EXPLICIT_SLEEP = /(晚安|我(?:先|要|准备|去|该)?睡(?:觉|了)|准备睡|去睡觉|困了.{0,6}睡)/u;
const EXPLICIT_WAKE = /(早安|早上好|我醒了|已经醒了|起床了|我起来了)/u;

function classifyNightIntent(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (EXPLICIT_WAKE.test(normalized)) return "wake";
  if (!NEGATED_SLEEP.test(normalized) && EXPLICIT_SLEEP.test(normalized)) return "sleep";
  return "";
}
```

`safeClassifyNightIntent` catches every exception and returns no intent. It may log only the error code, never the inbound message.

- [ ] **Step 4: Run classifier tests**

Run: `node --test ./test/night-intent.test.js`

Expected: PASS for explicit, negated, ambiguous, punctuation, whitespace, empty, and thrown-classifier cases.

- [ ] **Step 5: Commit**

```powershell
git add src/core/night-intent.js test/night-intent.test.js
git commit -m "Classify explicit sleep and wake intent"
```

---

### Task 2: Timezone-aware night window and durable sleep state

**Files:**
- Create: `src/core/night-care-state-store.js`
- Create: `src/core/night-care-policy.js`
- Create: `test/night-care-state-store.test.js`
- Create: `test/night-care-policy.test.js`
- Modify: `src/core/config.js`

**Interfaces:**
- Produces: `resolveNightWindow(now, timezone) -> { active, windowDate, startsAt, endsAt }`.
- Produces: `NightCareStateStore#get()`, `applyInbound({ intent, at, timezone, eventId })`, `evaluate({ now, timezone })`, `snapshot({ now, timezone })`.
- State shape: `{ schemaVersion: 1, windowDate, explicitSleep, inferredSleep, baselineAt, lastInboundAt, lastEventId, updatedAt }`.

- [ ] **Step 1: Write failing boundary, reset, and 90-minute tests**

```js
test("night window is active at 00:00 and inactive at 06:00 Shanghai time", () => {
  assert.equal(resolveNightWindow(new Date("2026-08-24T16:00:00.000Z"), "Asia/Shanghai").active, true);
  assert.equal(resolveNightWindow(new Date("2026-08-24T22:00:00.000Z"), "Asia/Shanghai").active, false);
});

test("inferred sleep reaches the boundary at exactly 90 minutes and clears at 06:00", () => {
  const store = makeNightStore();
  assert.equal(store.evaluate({ now: localShanghai("2026-08-25 01:29:59"), timezone: "Asia/Shanghai" }).inferredSleep, false);
  assert.equal(store.evaluate({ now: localShanghai("2026-08-25 01:30:00"), timezone: "Asia/Shanghai" }).inferredSleep, true);
  const morning = store.evaluate({ now: localShanghai("2026-08-25 06:00:00"), timezone: "Asia/Shanghai" });
  assert.equal(morning.inferredSleep, false);
  assert.equal(morning.baselineAt, "");
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/night-care-state-store.test.js ./test/night-care-policy.test.js`

Expected: FAIL because night window/state modules do not exist.

- [ ] **Step 3: Implement window-date state with injected time and classifier**

Use `Intl.DateTimeFormat(...).formatToParts()` to obtain timezone-local year, month, day, hour, minute, and second. Do not calculate the policy by adding a fixed UTC offset. `resolveNightWindow` must handle DST-capable configured timezones even though the default is `Asia/Shanghai`.

At first evaluation inside a new window, set `baselineAt` to that local window's 00:00 instant. `applyInbound` ignores an already consumed `eventId`, stores `lastInboundAt`, replaces `baselineAt` with the inbound instant, clears `inferredSleep`, then applies the preclassified intent: sleep sets `explicitSleep`; wake clears it. Evaluation at `>= baseline + 90 minutes` sets `inferredSleep` only while the window remains active. Evaluation outside the window returns and persists cleared flags/baseline.

Add `nightCareStateFile` and `nightCareActivityDir` to config as
`night-care-state.json` and `night-care-activity/`. The Electron controller is
the only writer of the state JSON.

- [ ] **Step 4: Run state/policy tests and reopen the state file**

Run: `node --test ./test/night-care-state-store.test.js ./test/night-care-policy.test.js`

Expected: PASS for 23:59, 00:00, 05:59, 06:00, exact 90 minutes, inbound reset, explicit sleep/wake, classifier failure, corrupt state, DST timezone, fresh-store reopen, and no cross-date carry.

- [ ] **Step 5: Commit**

```powershell
git add src/core/night-care-state-store.js src/core/night-care-policy.js src/core/config.js test/night-care-state-store.test.js test/night-care-policy.test.js
git commit -m "Persist timezone-aware night care state"
```

---

### Task 3: Record inbound activity before runtime execution

**Files:**
- Create: `src/core/night-care-activity-inbox.js`
- Create: `test/night-care-activity-inbox.test.js`
- Create: `test/night-care-inbound.test.js`
- Modify: `src/core/app.js`
- Modify: `src/desktop/supervision-dispatcher.js`

**Interfaces:**
- Produces: `NightCareActivityInbox#append({ eventId, at, intent })`, `list()`, and `ack(eventId)`.
- Consumes: `NightCareStateStore#applyInbound` from Task 2.
- Changes: the bridge appends an intent/activity event before command handling, attachment work, batching, or model runtime calls; the desktop dispatcher consumes events before policy evaluation.

- [ ] **Step 1: Write failing runtime-independent inbound tests**

```js
test("sleep intent is recorded even when the model runtime fails", async () => {
  const recorded = [];
  const appLike = makeAppLike({
    nightCareActivityInbox: { append(value) { recorded.push(value); } },
    runtimeError: new Error("provider offline"),
  });
  await assert.rejects(CyberbossApp.prototype.handleIncomingMessage.call(appLike, inbound("我准备睡觉了", "2026-08-25T00:20:00+08:00")));
  assert.equal(recorded[0].intent, "sleep");
  assert.equal(Object.hasOwn(recorded[0], "text"), false);
});
```

- [ ] **Step 2: Run and confirm the record hook is absent**

Run: `node --test ./test/night-care-inbound.test.js`

Expected: FAIL because the activity inbox and bridge hook do not exist.

- [ ] **Step 3: Construct the store and record normalized inbound messages first**

Implement a spool directory in which each event is written to a unique temporary
file and atomically renamed to
`<padded-queued-at>-<process-counter>-<sha256-event-id>.json`. Each file contains only
`{ eventId, at, intent }`; raw inbound text is never persisted. `list()` reads
complete JSON files in append order and quarantines malformed files.
`ack(eventId)` deletes only the exact validated event file after the controller
has persisted `lastEventId` in the state store.

In the bridge constructor:

```js
this.nightCareActivityInbox = new NightCareActivityInbox({ dirPath: config.nightCareActivityDir });
```

At the first point after sender validation and message normalization:

```js
const classified = safeClassifyNightIntent(normalized.text);
this.nightCareActivityInbox.append({
  eventId: `${normalized.messageId || crypto.randomUUID()}:${normalized.receivedAt || ""}`,
  at: normalized.receivedAt || new Date().toISOString(),
  intent: classified.intent,
});
```

Before every dispatcher policy pass, list inbox events and apply them in order.
Persist state before acknowledging each event. A replay after a crash is ignored
by `lastEventId` and then acknowledged, giving exactly-once state effects. Then
evaluate the current window. If acknowledgement fails, stop the batch before a
later event is applied; this keeps `lastEventId` sufficient for crash replay
deduplication. Wrap only classifier/inbox corruption internally;
do not swallow unrelated inbound errors. Do not wait for the active model and
do not enqueue a second message for classification.

- [ ] **Step 4: Run inbound and existing batching tests**

Run: `node --test ./test/night-care-activity-inbox.test.js ./test/night-care-inbound.test.js ./test/weixin-chunks.test.js ./test/codex-session-store.test.js`

Expected: PASS for atomic spool/reopen/malformed quarantine/crash replay/ack,
single-writer state updates, and no change to batching, command routing, or
runtime failure delivery.

- [ ] **Step 5: Commit**

```powershell
git add src/core/night-care-activity-inbox.js src/core/app.js src/desktop/supervision-dispatcher.js test/night-care-activity-inbox.test.js test/night-care-inbound.test.js
git commit -m "Track night activity before model execution"
```

---

### Task 4: Night-care supervision decisions, queue deduplication, and durable outcomes

**Files:**
- Create: `test/night-care-dispatcher.test.js`
- Modify: `src/core/supervision-policy.js`
- Modify: `src/core/supervision-plan-store.js`
- Modify: `src/core/system-message-queue-store.js`
- Modify: `src/desktop/supervision-dispatcher.js`
- Modify: `test/supervision-plan.test.js`

**Interfaces:**
- Produces: `resolveNightCareAction({ desiredState, checkpoint, nightState })` returning `dispatch`, `dispatch_night_care`, `archive`, `discard`, or `hold` plus an exact outcome.
- Extends queue records with `kind` and `sourceCheckpointId`.
- Produces: `SystemMessageQueueStore#list({ accountId, kind })` and `hasPendingKindForAccount(accountId, kind)`.

- [ ] **Step 1: Write failing decision, rewrite, and dedupe tests**

```js
test("fixed task checkpoint keeps time but becomes night care", () => {
  assert.deepEqual(resolveNightCareAction({
    desiredState: "running",
    checkpoint: { state: "pending", source: "conversation" },
    nightState: { active: true, explicitSleep: false, inferredSleep: false },
  }), { action: "dispatch_night_care", outcome: "night_care_replaced" });
});

test("explicit or inferred sleep suppresses every proactive source", () => {
  for (const flag of ["explicitSleep", "inferredSleep"]) {
    const decision = resolveNightCareAction({ desiredState: "running", checkpoint: randomCheckpoint(), nightState: { active: true, [flag]: true } });
    assert.equal(decision.action, "discard");
    assert.equal(decision.outcome, flag === "explicitSleep" ? "suppressed_explicit_sleep" : "suppressed_inferred_sleep");
  }
});

test("a pending night-care message deduplicates a nearby fixed checkpoint", async () => {
  queue.enqueue(nightCareMessage("random:1"));
  await dispatcher.dispatch(fixedCheckpoint("conversation:1"), { action: "dispatch_night_care" });
  assert.equal(queue.list({ kind: "night_care" }).length, 1);
});
```

- [ ] **Step 2: Run and confirm failures**

Run: `node --test ./test/night-care-dispatcher.test.js ./test/supervision-plan.test.js`

Expected: FAIL because the current policy has no night state or queue kind.

- [ ] **Step 3: Apply policy before normal Running dispatch without bypassing Quiet**

Decision order:

```js
if (desiredState === "stopped") return { action: "hold", outcome: "service_stopped" };
if (desiredState === "quiet") return quietDecision(checkpoint);
if (!nightState.active) return { action: "dispatch", outcome: "queued" };
if (nightState.explicitSleep) return suppress(checkpoint, "suppressed_explicit_sleep");
if (nightState.inferredSleep) return suppress(checkpoint, "suppressed_inferred_sleep");
return { action: "dispatch_night_care", outcome: "night_care_replaced" };
```

For `dispatch_night_care`, keep the checkpoint ID, source, and due time but enqueue:

```text
Night-care system context: it is between 00:00 and 06:00 and the user is still active. Send one natural, concise message encouraging the user to sleep soon and avoid staying up late. Do not urge tasks, planning, schedules, productivity, or unfinished work. Do not invent a fixed follow-up time.
```

Queue metadata is `{ kind: "night_care", sourceCheckpointId: checkpoint.id }`. If one is already pending for the account, mark the later checkpoint `skipped` with `night_care_deduplicated`. Otherwise mark it `completed` with `night_care_replaced`. Explicit/inferred sleep marks random as discarded and deterministic as archived, both with the exact sleep outcome. None return to `pending` after 06:00.

- [ ] **Step 4: Run supervision and queue tests**

Run: `node --test ./test/night-care-dispatcher.test.js ./test/supervision-plan.test.js ./test/system-inbound.test.js`

Expected: PASS for random timing preservation, fixed due-time preservation, Quiet precedence, sleep suppression, pending-message dedupe, source/due-time history, and no replay.

- [ ] **Step 5: Commit**

```powershell
git add src/core/supervision-policy.js src/core/supervision-plan-store.js src/core/system-message-queue-store.js src/desktop/supervision-dispatcher.js test/night-care-dispatcher.test.js test/supervision-plan.test.js
git commit -m "Apply night care before proactive dispatch"
```

---

### Task 5: Control/Records visibility, documentation, and complete boundary verification

**Files:**
- Modify: `src/desktop/main.js`
- Modify: `src/desktop/renderer/renderer.js`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `package.json`

**Interfaces:**
- Snapshot adds masked `nightCare: { active, windowDate, explicitSleep, inferredSleep, baselineAt, lastInboundAt }`.
- Recent-history labels include `night_care_replaced`, `night_care_deduplicated`, `suppressed_explicit_sleep`, and `suppressed_inferred_sleep`.

- [ ] **Step 1: Add failing snapshot/label tests to the dispatcher test file**

```js
test("desktop snapshot exposes state but no inbound message text", () => {
  const snapshot = buildSnapshotForTest();
  assert.deepEqual(Object.keys(snapshot.nightCare).sort(), ["active", "baselineAt", "explicitSleep", "inferredSleep", "lastInboundAt", "windowDate"]);
  assert.equal(JSON.stringify(snapshot.nightCare).includes("我准备睡觉"), false);
});
```

- [ ] **Step 2: Run and confirm the snapshot assertion fails**

Run: `node --test ./test/night-care-dispatcher.test.js`

Expected: FAIL because the desktop snapshot has no night-care state.

- [ ] **Step 3: Add friendly UI outcomes and document exact behavior**

Control displays one of “夜间关怀未开始”, “夜间关怀中”, “已确认入睡”, or “推断已入睡” without showing the random next check-in time. Records maps outcomes as:

```js
const NIGHT_OUTCOME_LABELS = {
  night_care_replaced: "因夜间关怀改为早睡提醒",
  night_care_deduplicated: "已合并到同一条早睡提醒",
  suppressed_explicit_sleep: "已确认入睡，跳过主动消息",
  suppressed_inferred_sleep: "推断已入睡，跳过主动消息",
};
```

Keep original source and due time in details. Document 00:00/06:00 boundaries, exact 90-minute behavior, random timing, fixed-time intent replacement, explicit versus inferred state, classifier failure fallback, Quiet precedence, and no morning replay in all three READMEs.

Add `test:night-care` to `package.json` with all six night-care test files and extend `npm run check` with the four new source files.

- [ ] **Step 4: Run all boundary, regression, and persistence checks**

Run:

```powershell
npm run check
npm run test:night-care
npm run test:desktop
npm test
```

Then execute a temporary-state test that writes explicit sleep at 00:20, constructs a fresh `NightCareStateStore`, reopens the file, advances the injected clock to 06:00, persists the cleared state, constructs a third store, and proves both flags and `baselineAt` remain cleared. Print and assert `exists=true`, `reopened=true`, `clearedAtSix=true`, and `noCrossDayCarry=true`.

Expected: all checks pass; no random due time appears in snapshots; no suppressed checkpoint becomes pending after 06:00.

- [ ] **Step 5: Commit**

```powershell
git add src/desktop/main.js src/desktop/renderer/renderer.js README.md README.zh-CN.md README.en.md package.json test/night-care-dispatcher.test.js
git commit -m "Expose and verify night care outcomes"
```

---

## Plan self-review checklist

- Every night-care state transition is independent of model availability.
- `explicitSleep`, `inferredSleep`, baseline, and window date have exact reset behavior.
- Quiet/Stopped rules run before night-care dispatch.
- Random schedules remain random and fixed checkpoints retain due times.
- Sleep suppresses all proactive messages; replaced/suppressed work never replays.
- UI history names replacement and suppression without leaking inbound text or random timing.
- Final tests write, reopen, clear, and reopen the real state file.
