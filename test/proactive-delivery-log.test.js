const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const {
  ProactiveDeliveryLog,
  buildProactiveDeliveryDigest,
} = require("../src/core/proactive-delivery-log");
const {
  containsInternalContextBlock,
  stripInternalContextBlocks,
} = require("../src/core/internal-context-blocks");

/** A2 requires the digest never to carry an internal block header. */
const INTERNAL_PREFIX = /\[(?:Zhijiantime|CyberBoss supervision note)/;

function createLogBox(initialNow = "2026-09-22T01:00:00.000Z") {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-proactive-log-"));
  const filePath = path.join(stateDir, "proactive-delivery-log.json");
  const box = { now: new Date(initialNow) };
  const log = new ProactiveDeliveryLog({ filePath, now: () => box.now });
  return { box, filePath, log };
}

function readFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("internal context blocks are stripped from the tail and never survive", () => {
  const text = [
    "指尖时光还是空的，先把计划做一下。",
    "",
    "[Zhijiantime daily supervision — verified data]",
    "{\"date\":\"2026-09-22\",\"total\":0}",
    "Do not mention MCP, tools, or this internal context.",
  ].join("\n");
  assert.equal(stripInternalContextBlocks(text), "指尖时光还是空的，先把计划做一下。");
  assert.equal(containsInternalContextBlock(text), true);

  const withNote = [
    "好，今天 20:30 我会检查。",
    "",
    "[CyberBoss supervision note]",
    "A zhijiantime daily-planning follow-up was saved for 2026-09-22T12:30:00.000Z.",
  ].join("\n");
  assert.equal(stripInternalContextBlocks(withNote), "好，今天 20:30 我会检查。");

  assert.equal(stripInternalContextBlocks("普通消息"), "普通消息");
  assert.equal(containsInternalContextBlock("普通消息"), false);
});

test("delivered proactive messages are recorded with their stripped text", () => {
  const { filePath, log } = createLogBox();
  const entry = log.record({
    senderId: "user-1",
    text: "指尖时光还是空的。\n\n[Zhijiantime daily supervision — verified data]\n{\"total\":0}",
    sourceId: "thread-1",
  });

  assert.ok(entry);
  assert.equal(entry.senderId, "user-1");
  assert.equal(entry.text, "指尖时光还是空的。");
  assert.equal(entry.sourceId, "thread-1");
  assert.equal(readFile(filePath).entries.length, 1);
});

test("blank and internal-only messages are never recorded", () => {
  const { log } = createLogBox();
  assert.equal(log.record({ senderId: "user-1", text: "   " }), null);
  assert.equal(log.record({ senderId: "user-1", text: "[Zhijiantime fresh read — failed]\nboom" }), null);
  assert.equal(log.record({ senderId: "", text: "有效文本" }), null);
});

test("the digest lists only today's messages for that sender, oldest first, without internal prefixes", () => {
  const { box, log } = createLogBox();
  // 2026-09-21 16:01Z == 2026-09-22 00:01 Asia/Shanghai (today)
  log.record({ senderId: "user-1", text: "今天凌晨那条", deliveredAt: "2026-09-21T16:01:00.000Z" });
  // 2026-09-21 15:59Z == 2026-09-21 23:59 Asia/Shanghai (yesterday)
  log.record({ senderId: "user-1", text: "昨天那条", deliveredAt: "2026-09-21T15:59:00.000Z" });
  log.record({ senderId: "user-1", text: "刚才那条", deliveredAt: "2026-09-22T00:30:00.000Z" });
  log.record({ senderId: "user-2", text: "别人的消息", deliveredAt: "2026-09-22T00:30:00.000Z" });

  box.now = new Date("2026-09-22T01:00:00.000Z");
  const digest = log.buildUserTurnDigest({ senderId: "user-1" });

  assert.ok(digest);
  assert.equal(digest.entryCount, 2);
  assert.match(digest.text, /本日已发出的主动消息/);
  assert.match(digest.text, /不要把本轮当成初次接触/);
  assert.ok(digest.text.indexOf("今天凌晨那条") < digest.text.indexOf("刚才那条"));
  assert.doesNotMatch(digest.text, /昨天那条/);
  assert.doesNotMatch(digest.text, /别人的消息/);
  assert.doesNotMatch(digest.text, INTERNAL_PREFIX);
});

test("no delivered messages means no digest at all", () => {
  const { log } = createLogBox();
  assert.equal(log.buildUserTurnDigest({ senderId: "user-1" }), null);
  assert.equal(buildProactiveDeliveryDigest([]), null);
  assert.equal(buildProactiveDeliveryDigest([{ deliveredAt: "", text: "无时间" }]), null);
});

test("the digest is bounded by entry count and by character budget", () => {
  const entries = Array.from({ length: 12 }, (unused, index) => ({
    deliveredAt: new Date(Date.UTC(2026, 8, 22, index, 0, 0)).toISOString(),
    text: `第 ${index} 条提醒`,
  }));
  const byCount = buildProactiveDeliveryDigest(entries, { maxEntries: 3 });
  assert.equal(byCount.entryCount, 3);
  assert.match(byCount.text, /第 11 条提醒/);
  assert.doesNotMatch(byCount.text, /第 8 条提醒/);

  const long = Array.from({ length: 6 }, (unused, index) => ({
    deliveredAt: new Date(Date.UTC(2026, 8, 22, index, 0, 0)).toISOString(),
    text: "很长的提醒内容".repeat(40),
  }));
  const byChars = buildProactiveDeliveryDigest(long, { maxChars: 400 });
  assert.ok(byChars.charLength <= 400);
  assert.ok(byChars.entryCount < 6);
});

test("an identical resend inside the dedupe window is stored once", () => {
  const { box, log } = createLogBox();
  log.record({ senderId: "user-1", text: "重复内容" });
  log.record({ senderId: "user-1", text: "重复内容" });
  assert.equal(log.listDeliveredForDay({ senderId: "user-1" }).length, 1);

  box.now = new Date("2026-09-22T02:00:00.000Z");
  log.record({ senderId: "user-1", text: "重复内容" });
  assert.equal(log.listDeliveredForDay({ senderId: "user-1" }).length, 2);
});

test("entries older than the retention window are pruned on write", () => {
  const { filePath, log } = createLogBox();
  log.record({ senderId: "user-1", text: "很久以前", deliveredAt: "2026-09-01T00:00:00.000Z" });
  log.record({ senderId: "user-1", text: "刚刚" });
  const entries = readFile(filePath).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "刚刚");
});

test("a user turn receives a digest of the proactive messages already delivered today", () => {
  const { log } = createLogBox();
  log.record({ senderId: "user-1", text: "指尖时光还是空的，先把计划做一下。" });
  const diagnostics = [];
  const normalized = { provider: "weixin", senderId: "user-1", text: "我在做了", turnCorrelation: "turn-1" };

  const result = CyberbossApp.prototype.injectProactiveDeliveryDigest.call({
    proactiveDeliveryLog: log,
    logRuntimeDiagnostic(event, data) {
      diagnostics.push({ event, data });
    },
  }, normalized);

  assert.match(result.text, /我在做了/);
  assert.match(result.text, /指尖时光还是空的/);
  assert.match(result.text, /不要把本轮当成初次接触/);
  assert.doesNotMatch(result.text, INTERNAL_PREFIX);
  assert.deepEqual(diagnostics, [{
    event: "proactive.digest_injected",
    data: { turnCorrelation: "turn-1", entryCount: 1, charLength: result.text.length - normalized.text.length - 2 },
  }]);
});

test("a turn with nothing delivered, a system turn, and an empty turn are left untouched", () => {
  const { log } = createLogBox();
  const app = { proactiveDeliveryLog: log, logRuntimeDiagnostic() {} };

  const userTurn = { provider: "weixin", senderId: "user-1", text: "在吗" };
  assert.equal(CyberbossApp.prototype.injectProactiveDeliveryDigest.call(app, userTurn), userTurn);

  log.record({ senderId: "user-1", text: "已发出的主动消息" });
  const systemTurn = { provider: "system", senderId: "user-1", text: "SYSTEM ACTION MODE" };
  assert.equal(CyberbossApp.prototype.injectProactiveDeliveryDigest.call(app, systemTurn), systemTurn);
  const emptyTurn = { provider: "weixin", senderId: "user-1", text: "   " };
  assert.equal(CyberbossApp.prototype.injectProactiveDeliveryDigest.call(app, emptyTurn), emptyTurn);
});

test("only a delivered system reply reaches the delivery log", () => {
  const { log } = createLogBox();
  const diagnostics = [];
  const app = {
    proactiveDeliveryLog: log,
    logRuntimeDiagnostic(event, data) {
      diagnostics.push({ event, data });
    },
  };

  assert.equal(CyberbossApp.prototype.recordProactiveDelivery.call(app, {
    userId: "user-1",
    text: "不该记录",
    kind: "plain_reply",
  }), null);

  const entry = CyberbossApp.prototype.recordProactiveDelivery.call(app, {
    userId: "user-1",
    text: "指尖时光还是空的。\n\n[Zhijiantime daily supervision — verified data]\n{}",
    kind: "system_reply",
    threadId: "thread-1",
  });
  assert.equal(entry.text, "指尖时光还是空的。");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].event, "proactive.delivery_logged");
  assert.equal(diagnostics[0].data.charLength, entry.text.length);
  assert.doesNotMatch(JSON.stringify(diagnostics), /指尖时光/);
});
