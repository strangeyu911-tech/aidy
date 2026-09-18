const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveOwnerUserId,
  classifyInboundOwnership,
  isOwnerInboundMessage,
  normalizeInboundMessage,
} = require("../src/adapters/channel/weixin/message-utils");

function makeOwnedMessage(overrides = {}) {
  return {
    message_type: 1,
    from_user_id: "owner-1",
    session_id: "sess-1",
    create_time_ms: 1700000000000,
    item_list: [{ type: 1, text_item: { text: "hello boss" } }],
    ...overrides,
  };
}

test("resolveOwnerUserId prefers explicit config.ownerUserId", () => {
  assert.equal(
    resolveOwnerUserId({
      config: { ownerUserId: "owner-1" },
      allowedUserIds: ["other"],
    }),
    "owner-1",
  );
});

test("resolveOwnerUserId falls back to first allowedUserIds entry", () => {
  assert.equal(
    resolveOwnerUserId({ config: {}, allowedUserIds: ["first", "second"] }),
    "first",
  );
});

test("resolveOwnerUserId returns empty string when nothing configured", () => {
  assert.equal(resolveOwnerUserId({ config: {}, allowedUserIds: [] }), "");
  assert.equal(resolveOwnerUserId({}), "");
});

test("classifyInboundOwnership passes through when no ownership info configured", () => {
  const result = classifyInboundOwnership(makeOwnedMessage());
  assert.deepEqual(result, {
    allowed: true,
    verified: false,
    reason: "no_ownership_configured",
  });
});

test("classifyInboundOwnership allows same owner id (ownerUserId)", () => {
  const message = makeOwnedMessage({ from_user_id: "owner-1" });
  const result = classifyInboundOwnership(message, { ownerId: "owner-1" });
  assert.equal(result.allowed, true);
  assert.equal(result.verified, true);
  assert.equal(result.reason, "sender_matches_owner");
});

test("classifyInboundOwnership rejects a different sender (ownerUserId)", () => {
  const message = makeOwnedMessage({ from_user_id: "intruder" });
  const result = classifyInboundOwnership(message, { ownerId: "owner-1" });
  assert.equal(result.allowed, false);
  assert.equal(result.verified, true);
  assert.equal(result.reason, "sender_not_owner");
});

test("classifyInboundOwnership allows any matching allowedUserIds entry", () => {
  const messageA = makeOwnedMessage({ from_user_id: "a" });
  const messageB = makeOwnedMessage({ from_user_id: "b" });
  const messageC = makeOwnedMessage({ from_user_id: "c" });
  const options = { allowedUserIds: ["a", "", "b"] };
  assert.equal(classifyInboundOwnership(messageA, options).allowed, true);
  assert.equal(classifyInboundOwnership(messageB, options).allowed, true);
  assert.equal(classifyInboundOwnership(messageC, options).allowed, false);
});

test("classifyInboundOwnership honors senderId alias for the sender field", () => {
  const message = { ...makeOwnedMessage(), from_user_id: undefined, senderId: "owner-1" };
  const result = classifyInboundOwnership(message, { ownerId: "owner-1" });
  assert.equal(result.allowed, true);
});

test("classifyInboundOwnership rejects when sender field is missing", () => {
  const message = makeOwnedMessage({ from_user_id: undefined });
  const result = classifyInboundOwnership(message, { ownerId: "owner-1" });
  assert.equal(result.allowed, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "missing_sender");
});

test("classifyInboundOwnership trims sender and owner ids", () => {
  const message = makeOwnedMessage({ from_user_id: "  owner-1  " });
  const result = classifyInboundOwnership(message, { ownerId: "owner-1" });
  assert.equal(result.allowed, true);
});

test("isOwnerInboundMessage reflects classification booleans", () => {
  assert.equal(isOwnerInboundMessage(makeOwnedMessage(), { ownerId: "owner-1" }), true);
  assert.equal(isOwnerInboundMessage(makeOwnedMessage({ from_user_id: "x" }), { ownerId: "owner-1" }), false);
});

test("normalizeInboundMessage returns normalized result without owner gate", () => {
  const result = normalizeInboundMessage(makeOwnedMessage(), { config: { workspaceId: "default" }, accountId: "acc-1" });
  assert.ok(result);
  assert.equal(result.senderId, "owner-1");
  assert.equal(result.chatId, "owner-1");
  assert.equal(result.text, "hello boss");
  assert.equal(result.workspaceId, "default");
});

test("normalizeInboundMessage drops message from non-owner when owner configured", () => {
  const message = makeOwnedMessage({ from_user_id: "intruder" });
  const result = normalizeInboundMessage(message, {
    config: { workspaceId: "default" },
    accountId: "acc-1",
    owner: { ownerUserId: "owner-1" },
  });
  assert.equal(result, null);
});

test("normalizeInboundMessage keeps message from owner", () => {
  const message = makeOwnedMessage({ from_user_id: "owner-1" });
  const result = normalizeInboundMessage(message, {
    config: { workspaceId: "default" },
    accountId: "acc-1",
    owner: { ownerUserId: "owner-1" },
  });
  assert.ok(result);
  assert.equal(result.senderId, "owner-1");
});

test("normalizeInboundMessage keeps message matching any allowedUserIds", () => {
  const message = makeOwnedMessage({ from_user_id: "b" });
  const result = normalizeInboundMessage(message, {
    owner: { allowedUserIds: ["a", "b"] },
  });
  assert.ok(result);
  assert.equal(result.senderId, "b");
});

test("normalizeInboundMessage drops message when no sender field present", () => {
  const message = makeOwnedMessage({ from_user_id: undefined });
  const result = normalizeInboundMessage(message, {
    owner: { ownerUserId: "owner-1" },
  });
  assert.equal(result, null);
});

test("normalizeInboundMessage passes through when owner gate has no ownership info", () => {
  // owner gate enabled but empty -> fail open, same as no gate.
  const result = normalizeInboundMessage(makeOwnedMessage(), { owner: { ownerUserId: "", allowedUserIds: [] } });
  assert.ok(result);
});

test("rejection paths never leak message content into reason or returned fields", () => {
  const secret = "TOP SECRET diary entry with private details";
  const intruderMessage = makeOwnedMessage({ from_user_id: "intruder", item_list: [{ type: 1, text_item: { text: secret } }] });
  const missingMessage = makeOwnedMessage({ from_user_id: undefined, item_list: [{ type: 1, text_item: { text: secret } }] });

  const intruderClass = classifyInboundOwnership(intruderMessage, { ownerId: "owner-1" });
  assert.ok(!JSON.stringify(intruderClass).includes(secret));
  assert.equal(intruderClass.reason, "sender_not_owner");

  const missingClass = classifyInboundOwnership(missingMessage, { ownerId: "owner-1" });
  assert.ok(!JSON.stringify(missingClass).includes(secret));
  assert.equal(missingClass.reason, "missing_sender");

  // The dropped normalization result is null, so no content can be returned.
  const dropped = normalizeInboundMessage(intruderMessage, { owner: { ownerUserId: "owner-1" } });
  assert.equal(dropped, null);
});
