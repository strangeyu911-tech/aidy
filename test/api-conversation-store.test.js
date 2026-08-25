"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ConversationStore,
  buildRuntimeScopeKey,
} = require("../src/adapters/runtime/api/conversation-store");

function makeFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-conversation-test-")), "conversations.json");
}

function scopeFor(profileId = "p1", modelId = "gpt-5", secretGeneration = 2, runtimeId = "builtin-api") {
  return { runtimeId, profileId, modelId, secretGeneration };
}

test("runtime scope keys bind all four readable identity fields", () => {
  const base = scopeFor();
  const key = buildRuntimeScopeKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, buildRuntimeScopeKey({ ...base, runtimeId: "codex" }));
  assert.notEqual(key, buildRuntimeScopeKey({ ...base, profileId: "p2" }));
  assert.notEqual(key, buildRuntimeScopeKey({ ...base, modelId: "gpt-5-mini" }));
  assert.notEqual(key, buildRuntimeScopeKey({ ...base, secretGeneration: 3 }));
});

test("only committed history resumes for an exact profile scope", () => {
  const filePath = makeFilePath();
  let id = 0;
  const store = new ConversationStore({ filePath, randomUUID: () => `turn-${++id}` });
  const scope = scopeFor();
  const turn = store.beginTurn(scope, { role: "user", text: "hello" });
  store.commitAssistant(turn.id, { role: "assistant", text: "done" });
  store.beginTurn(scope, {
    role: "user",
    text: "unfinished",
    pendingApproval: { requestId: "must-not-resume" },
    supervisionState: { checkpointId: "must-not-copy" },
  });

  assert.deepEqual(store.resume(scope).messages.map((message) => message.text), ["hello", "done"]);
  assert.deepEqual(store.resume(scopeFor("p1", "gpt-5", 3)).messages, []);
  assert.deepEqual(store.resume(scopeFor("p1", "gpt-5-mini", 2)).messages, []);
  assert.deepEqual(store.resume(scopeFor("p2", "gpt-5", 2)).messages, []);
});

test("tool turns commit only after every declared tool result", () => {
  const filePath = makeFilePath();
  const store = new ConversationStore({ filePath, randomUUID: () => "tool-turn" });
  const scope = scopeFor();
  const turn = store.beginTurn(scope, { role: "user", text: "use tools" });
  store.commitAssistant(turn.id, {
    role: "assistant",
    text: "working",
    toolCalls: [{ id: "call-1" }, { id: "call-2" }],
  });
  store.commitToolResult(turn.id, { role: "tool", toolCallId: "call-1", text: "one" });
  assert.deepEqual(store.resume(scope).messages, []);

  store.commitToolResult(turn.id, { role: "tool", toolCallId: "call-2", text: "two" });
  assert.deepEqual(store.resume(scope).messages.map((message) => message.text), ["use tools", "working", "one", "two"]);
});

test("reopening aborts inflight turns and never replays their tool or approval state", () => {
  const filePath = makeFilePath();
  const scope = scopeFor();
  const first = new ConversationStore({ filePath, randomUUID: () => "crashed-turn" });
  const turn = first.beginTurn(scope, { role: "user", text: "crash" });
  first.commitAssistant(turn.id, {
    role: "assistant",
    text: "partial",
    toolCalls: [{ id: "pending-tool" }],
    pendingApproval: { requestId: "approval-1" },
  });

  const reopened = new ConversationStore({ filePath });
  const result = reopened.resume(scope);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.turns, []);
  assert.equal(result.abortedTurns[0].status, "aborted");
  assert.deepEqual(result.pendingApprovals, []);
  assert.deepEqual(result.supervisionState, null);

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.conversations[0].scopeKey, buildRuntimeScopeKey(scope));
  assert.deepEqual(persisted.conversations[0].scope, scope);
  assert.equal(persisted.conversations[0].turns[0].status, "aborted");
});

test("archiving a deleted profile preserves readable history but prevents resume", () => {
  const filePath = makeFilePath();
  const scope = scopeFor();
  const store = new ConversationStore({ filePath, randomUUID: () => "turn-1" });
  const turn = store.beginTurn(scope, { role: "user", text: "hello" });
  store.commitAssistant(turn.id, { role: "assistant", text: "done" });
  store.archiveProfile("p1");

  const archived = store.resume(scope);
  assert.equal(archived.readOnly, true);
  assert.equal(archived.resumable, false);
  assert.equal(archived.reason, "profile_deleted");
  assert.deepEqual(archived.messages.map((message) => message.text), ["hello", "done"]);
  assert.throws(() => store.beginTurn(scope, { role: "user", text: "new" }), /PROFILE_ARCHIVED/);
  assert.deepEqual(store.resume(scopeFor("p2")).messages, []);
});

test("fresh instances reopen committed conversation files", () => {
  const filePath = makeFilePath();
  const scope = scopeFor();
  const first = new ConversationStore({ filePath, randomUUID: () => "turn-1" });
  const turn = first.beginTurn(scope, { role: "user", text: "persist me" });
  first.commitAssistant(turn.id, { role: "assistant", text: "persisted" });

  assert.equal(fs.existsSync(filePath), true);
  const reopened = new ConversationStore({ filePath });
  assert.deepEqual(reopened.resume(scope).messages.map((message) => message.text), ["persist me", "persisted"]);
});
