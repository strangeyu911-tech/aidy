"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeferredSystemReplyStore } = require("../src/core/deferred-system-reply-store");

const TEN_MINUTES_MS = 10 * 60 * 1000;

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-deferred-")), "deferred.json");
}

function reply(overrides = {}) {
  return {
    id: "deferred-1",
    accountId: "account-1",
    senderId: "user-1",
    threadId: "thread-1",
    text: "8 点了，指尖时光还没动过",
    kind: "system_reply",
    createdAt: "2026-09-23T00:00:00.000Z",
    failedAt: "2026-09-23T00:00:00.000Z",
    lastError: "SEND_FAILED",
    ...overrides,
  };
}

test("a deferred reply inside the window is still delivered", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  store.enqueue(reply({ createdAt: "2026-09-23T00:00:00.000Z" }));

  const drained = store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T00:05:00.000Z"));
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, "8 点了，指尖时光还没动过");
});

test("a deferred reply older than the window is dropped, not delivered late", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  // The exact shape of the 2026-09-23 incident: the model wrote this at 08:01
  // and the user did not come back until the afternoon.
  store.enqueue(reply({ createdAt: "2026-09-23T00:01:23.000Z" }));

  const drained = store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T06:52:43.000Z"));
  assert.deepEqual(drained, []);
  assert.equal(store.discardedCount, 1);
  assert.equal(store.state.replies.length, 0);
});

test("the boundary is inclusive: exactly the window age still sends", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  store.enqueue(reply({ createdAt: "2026-09-23T00:00:00.000Z" }));

  const atBoundary = store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T00:00:00.000Z") + TEN_MINUTES_MS);
  assert.equal(atBoundary.length, 1);

  const store2 = new DeferredSystemReplyStore({ filePath: tempFile() });
  store2.enqueue(reply({ createdAt: "2026-09-23T00:00:00.000Z" }));
  const justOver = store2.drainForSender("account-1", "user-1", Date.parse("2026-09-23T00:00:00.000Z") + TEN_MINUTES_MS + 1);
  assert.deepEqual(justOver, []);
});

test("stale replies can be pruned from disk at startup, not just on drain", () => {
  const filePath = tempFile();
  const seeded = [
    reply({ id: "old", createdAt: "2026-09-21T14:13:58.000Z" }),
    reply({ id: "fresh", createdAt: new Date(Date.now() - 1000).toISOString() }),
  ];
  fs.writeFileSync(filePath, JSON.stringify({ replies: seeded }, null, 2));

  const store = new DeferredSystemReplyStore({ filePath });
  // load() itself is inert: it must not judge entries by wall time, or every
  // read would silently mutate the queue.
  assert.equal(store.state.replies.length, 2);

  assert.equal(store.pruneExpired(), 1);
  assert.equal(store.state.replies.length, 1);
  assert.equal(store.state.replies[0].id, "fresh");

  const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(onDisk.replies.length, 1);
  assert.equal(onDisk.replies[0].id, "fresh");
});

test("a reply with an unparseable timestamp is rejected outright, never given a fresh lease", () => {
  const filePath = tempFile();
  fs.writeFileSync(filePath, JSON.stringify({ replies: [reply({ createdAt: "not-a-date" })] }, null, 2));

  const store = new DeferredSystemReplyStore({ filePath });
  // Rejected at normalize time: stamping it with "now" would have handed a
  // corrupt record a full new window, the exact opposite of treating it as
  // unreadable. isExpired documents the same rule for hand-built objects.
  assert.equal(store.state.replies.length, 0);
  assert.equal(store.isExpired({ createdAt: "not-a-date" }), true);
  assert.equal(store.isExpired({ createdAt: undefined }), true);
});

test("expired entries for other senders are left untouched", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  store.enqueue(reply({ id: "mine", senderId: "user-1", createdAt: "2026-09-23T00:00:00.000Z" }));
  store.enqueue(reply({ id: "theirs", senderId: "user-2", createdAt: "2026-09-23T00:00:00.000Z" }));

  const drained = store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T03:00:00.000Z"));
  assert.deepEqual(drained, []);
  assert.equal(store.discardedCount, 1);
  // user-2's entry is still there: a drain for someone else must not prune it,
  // because it has never had its own chance to be judged.
  assert.equal(store.state.replies.length, 1);
  assert.equal(store.state.replies[0].id, "theirs");
});

test("discardedCount reflects the current drain, not a previous one", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  store.enqueue(reply({ id: "stale", createdAt: "2026-09-23T00:00:00.000Z" }));
  store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T03:00:00.000Z"));
  assert.equal(store.discardedCount, 1);

  // A later drain with nothing to drop must reset the counter, otherwise the
  // caller would log a phantom discard on every subsequent inbound message.
  store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T03:01:00.000Z"));
  assert.equal(store.discardedCount, 0);
});

test("a mixed batch delivers the fresh entries and drops only the stale ones", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile() });
  store.enqueue(reply({ id: "stale", text: "8 点了，指尖时光还没动过", createdAt: "2026-09-23T00:01:23.000Z" }));
  store.enqueue(reply({ id: "fresh", text: "刚发现一个事", createdAt: "2026-09-23T06:50:00.000Z" }));

  const drained = store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T06:52:43.000Z"));
  assert.equal(drained.length, 1);
  assert.equal(drained[0].id, "fresh");
  assert.equal(store.discardedCount, 1);
  assert.equal(store.state.replies.length, 0);
});

test("the window is configurable", () => {
  const store = new DeferredSystemReplyStore({ filePath: tempFile(), maxAgeMs: 60 * 1000 });
  store.enqueue(reply({ createdAt: "2026-09-23T00:00:00.000Z" }));
  assert.equal(store.maxAgeMs, 60 * 1000);
  assert.deepEqual(store.drainForSender("account-1", "user-1", Date.parse("2026-09-23T00:02:00.000Z")), []);
});

test("an unusable maxAgeMs falls back to the ten-minute default", () => {
  for (const bad of [0, -1, NaN, Infinity, "600000"]) {
    const store = new DeferredSystemReplyStore({ filePath: tempFile(), maxAgeMs: bad });
    assert.equal(store.maxAgeMs, TEN_MINUTES_MS, `maxAgeMs=${String(bad)}`);
  }
});
