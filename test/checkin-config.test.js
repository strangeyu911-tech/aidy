const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  parseCheckinRangeMinutes,
  resolveCheckinPreset,
} = require("../src/core/checkin-config-store");
const { CyberbossApp } = require("../src/core/app");

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-test-"));
  return new CheckinConfigStore({ filePath: path.join(dir, "checkin-config.json") });
}

test("parseCheckinRangeMinutes accepts min-max minute ranges", () => {
  assert.deepEqual(parseCheckinRangeMinutes("7-21"), { minMinutes: 7, maxMinutes: 21 });
  assert.deepEqual(parseCheckinRangeMinutes("5 - 10"), { minMinutes: 5, maxMinutes: 10 });
  assert.equal(parseCheckinRangeMinutes("10-3"), null);
  assert.equal(parseCheckinRangeMinutes("abc"), null);
});

test("checkin config store falls back to defaults and persists overrides", () => {
  const store = createStore();
  assert.deepEqual(store.getRange(), {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  });
  store.setRange({ minIntervalMs: 4 * 60_000, maxIntervalMs: 25 * 60_000 });
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 4 * 60_000,
    maxIntervalMs: 25 * 60_000,
  });
});

test("handleCheckinCommand stores the new range and replies in English", async () => {
  const sent = [];
  const store = createStore();
  const appLike = {
    checkinConfigStore: store,
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "7-21",
  });

  assert.deepEqual(store.getRange(), {
    minIntervalMs: 7 * 60_000,
    maxIntervalMs: 21 * 60_000,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "✅ 已改成大约每 7-21 分钟来一次，从下一个调度周期开始生效。");
});

test("handleCheckinCommand applies named presets and reports the current tier in Chinese", async () => {
  const sent = [];
  const store = createStore();
  const appLike = {
    checkinConfigStore: store,
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "" });
  assert.match(sent[0].text, /标准/);
  assert.match(sent[0].text, /15-45/);

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "轻陪伴" });
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 30 * 60_000,
    maxIntervalMs: 90 * 60_000,
  });
  assert.equal(store.getPresetId(), "light");
  assert.match(sent[1].text, /轻陪伴/);

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "紧密" });
  assert.equal(store.getPresetId(), "close");

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "不是区间" });
  assert.match(sent[3].text, /没看懂/);
  // A rejected value must not silently change the stored range.
  assert.equal(store.getPresetId(), "close");
});

test("preset lookup accepts ids, Chinese labels, single-character prefixes and aliases", () => {
  assert.equal(resolveCheckinPreset("standard").id, "standard");
  assert.equal(resolveCheckinPreset("轻陪伴").id, "light");
  assert.equal(resolveCheckinPreset("紧").id, "close");
  assert.equal(resolveCheckinPreset("频繁").id, "close");
  assert.equal(resolveCheckinPreset("适中").id, "standard");
  assert.equal(resolveCheckinPreset(""), null);
  assert.equal(resolveCheckinPreset("10-20"), null);
});

test("the default check-in tier is standard, not the old 3-60 band", () => {
  const store = createStore();
  assert.equal(store.getPresetId(), "standard");
  const range = store.getRange();
  assert.equal(range.minIntervalMs / 60_000, 15);
  assert.equal(range.maxIntervalMs / 60_000, 45);
});

test("handleChunkCommand reports current value and persists updates through the channel adapter", async () => {
  const sent = [];
  let minChunk = 20;
  const appLike = {
    channelAdapter: {
      getMinChunkChars() {
        return minChunk;
      },
      setMinChunkChars(value) {
        minChunk = value;
        return minChunk;
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "",
  });
  await CyberbossApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "50",
  });

  assert.equal(sent[0].text, "💡 当前短消息合并长度是 20 个字符。用法：/chunk <数字>（例如 /chunk 50）");
  assert.equal(sent[1].text, "✅ 短消息合并长度已设为 50 个字符。比这更短的碎片会合并成一条消息。");
  assert.equal(minChunk, 50);
});
