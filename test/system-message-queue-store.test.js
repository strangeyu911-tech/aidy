const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sysmsg-"));
  const filePath = path.join(dir, "system-message-queue.json");
  return new SystemMessageQueueStore({ filePath });
}

function sampleMessage(id) {
  return {
    id,
    accountId: "acc-1",
    senderId: "sender-1",
    workspaceRoot: "/workspace",
    text: `system message ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
  };
}

test("save() writes correct content and leaves no .tmp files behind", () => {
  const store = makeStore();
  store.enqueue(sampleMessage("m1"));
  store.enqueue(sampleMessage("m2"));

  const parsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.deepEqual(parsed.messages.map((m) => m.id).sort(), ["m1", "m2"]);

  const tmpFiles = fs.readdirSync(path.dirname(store.filePath))
    .filter((name) => name.includes(".tmp"));
  assert.equal(tmpFiles.length, 0, `unexpected temp files: ${tmpFiles.join(",")}`);
});

test("save() target file is always valid JSON after repeated enqueues", () => {
  const store = makeStore();
  const count = 50;
  for (let index = 0; index < count; index += 1) {
    store.enqueue(sampleMessage(`m-${index}`));
    // Every completed write must be a fully-formed JSON document.
    const parsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
    assert.ok(Array.isArray(parsed.messages));
  }
  const finalParsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.equal(finalParsed.messages.length, count);
  assert.equal(fs.readdirSync(path.dirname(store.filePath)).filter((n) => n.includes(".tmp")).length, 0);
});

test("save() cleans up the temp file and rethrows when rename fails", () => {
  const store = makeStore();
  const originalRename = fs.renameSync;
  const createdTemps = [];
  fs.renameSync = (src) => {
    createdTemps.push(src);
    throw new Error("rename failed on purpose");
  };
  try {
    assert.throws(() => store.save(), /rename failed on purpose/);
    for (const tmp of createdTemps) {
      assert.equal(fs.existsSync(tmp), false, `temp file not cleaned up: ${tmp}`);
    }
  } finally {
    fs.renameSync = originalRename;
  }
});

test("enqueue then drain preserves messages and remains valid JSON on disk", () => {
  const store = makeStore();
  store.enqueue(sampleMessage("a"));
  store.enqueue(sampleMessage("b"));

  const drained = store.drainForAccount("acc-1");
  assert.equal(drained.length, 2);

  // After draining everything, the on-disk file must still be valid JSON.
  const parsed = JSON.parse(fs.readFileSync(store.filePath, "utf8"));
  assert.deepEqual(parsed.messages, []);
  assert.equal(fs.readdirSync(path.dirname(store.filePath)).filter((n) => n.includes(".tmp")).length, 0);
});

test("public interface and this.state shape are unchanged", () => {
  const store = makeStore();
  assert.ok(store.state && Array.isArray(store.state.messages));
  const normalized = store.enqueue(sampleMessage("x"));
  assert.equal(normalized.id, "x");
  assert.equal(store.hasPendingForAccount("acc-1"), true);
  assert.equal(store.hasPendingForAccount("other"), false);

  store.setSupervisionKeyResolver(() => "legacy-key");
  assert.equal(Array.isArray(store.state.messages), true);
});
