const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AtomicJsonStore } = require("../src/core/atomic-json-store");

function makeStore(value) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-atomic-")), "data.json");
  const store = new AtomicJsonStore({ filePath, defaultValue: { count: 0, items: [] } });
  if (value !== undefined) store.write(value);
  return store;
}

test("read returns a deep copy so callers cannot corrupt the cache", () => {
  const store = makeStore({ count: 1, items: [1, 2, 3] });
  const first = store.read();
  first.items.push(4);
  first.count = 99;
  const second = store.read();
  assert.deepEqual(second, { count: 1, items: [1, 2, 3] });
});

test("repeated read without modification is served from cache and stable", () => {
  const store = makeStore({ count: 5 });
  const a = store.read();
  const b = store.read();
  assert.deepEqual(a, b);
  assert.deepEqual(a, { count: 5 });
});

test("external modification is detected and read returns the new value", () => {
  const store = makeStore({ count: 1 });
  store.read(); // populate cache
  // Simulate another process overwriting the file.
  fs.writeFileSync(store.filePath, JSON.stringify({ count: 42 }));
  const after = store.read();
  assert.deepEqual(after, { count: 42 });
});

test("write invalidates the cache with the new value", () => {
  const store = makeStore({ count: 1 });
  store.read();
  store.write({ count: 7 });
  assert.deepEqual(store.read(), { count: 7 });
});

test("read of a missing file returns a clone of the default value", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-atomic-")), "missing.json");
  const store = new AtomicJsonStore({ filePath, defaultValue: { count: 0 } });
  const first = store.read();
  first.count = 100;
  assert.deepEqual(store.read(), { count: 0 });
});
