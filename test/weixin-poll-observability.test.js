const test = require("node:test");
const assert = require("node:assert/strict");

const { getUpdates } = require("../src/adapters/channel/weixin/api");
const {
  buildPollError,
  buildPollResult,
  classifyPollError,
  readPollMeta,
} = require("../src/adapters/channel/weixin/poll-observability");
const { createInboundFilter } = require("../src/adapters/channel/weixin/message-utils");

function withFetch(implementation, callback) {
  const original = global.fetch;
  global.fetch = implementation;
  return Promise.resolve()
    .then(callback)
    .finally(() => { global.fetch = original; });
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

test("getUpdates exposes structured success metadata without changing response shape", async () => {
  let request;
  await withFetch(async (url, options) => {
    request = { url: String(url), options };
    return response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-next" }));
  }, async () => {
    const result = await getUpdates({
      baseUrl: "https://43.163.165.187",
      token: "private-token",
      getUpdatesBuf: "cursor-before",
      timeoutMs: 2_000,
    });
    assert.deepEqual(result.msgs, []);
    assert.equal(result.get_updates_buf, "cursor-next");
    assert.deepEqual(readPollMeta(result), {
      outcome: "success",
      httpStatus: 200,
      rpcSuccess: true,
      rpcCode: 0,
      responseEmpty: false,
      parseSuccess: true,
    });
    assert.equal(request.url.endsWith("/ilink/bot/getupdates"), true);
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.get_updates_buf, "cursor-before");
    assert.equal(JSON.stringify(readPollMeta(result)).includes("private-token"), false);
  });
});

test("poll result records empty, update, cursor, and parser counts without message bodies", () => {
  const empty = buildPollResult({
    pollSequenceId: "poll-1",
    startedAt: "2026-09-02T09:00:00.000Z",
    startedMonotonicMs: 10,
    cursorBefore: "same-cursor",
    cursorAfter: "same-cursor",
    responseMeta: { outcome: "success", httpStatus: 200, rpcSuccess: true, responseEmpty: false },
    updates: [],
  });
  assert.equal(empty.updateCount, 0);
  assert.equal(empty.cursorAdvanced, false);
  assert.equal(empty.parserCandidateCount, 0);

  const update = {
    message_type: 1,
    message_id: 42,
    create_time: 1_756_800_000,
    from_user_id: "wx-private-sender",
    item_list: [{ type: 1, text_item: { text: "private body" } }],
  };
  const result = buildPollResult({
    pollSequenceId: "poll-2",
    startedAt: "2026-09-02T09:00:00.000Z",
    startedMonotonicMs: 10,
    cursorBefore: "cursor-before",
    cursorAfter: "cursor-after",
    responseMeta: { outcome: "success", httpStatus: 200, rpcSuccess: true },
    updates: [update],
    parserAcceptedCount: 1,
    parserRejectedCount: 0,
  });
  assert.equal(result.updateCount, 1);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(result.parserAcceptedCount, 1);
  assert.equal(result.parserRejectedCount, 0);
  assert.equal(result.updateMetadata[0].updateType, 1);
  assert.equal(result.updateMetadata[0].messageId.startsWith("sha256:"), true);
  assert.equal(result.updateMetadata[0].senderFingerprint.startsWith("sha256:"), true);
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(JSON.stringify(result).includes("wx-private-sender"), false);
});

test("timeout remains the existing synthetic empty response but is distinguishable from an empty poll", async () => {
  await withFetch(async () => {
    const error = new Error("request aborted");
    error.name = "AbortError";
    throw error;
  }, async () => {
    const result = await getUpdates({ baseUrl: "https://example.test", token: "private-token", getUpdatesBuf: "cursor" });
    assert.deepEqual(result.msgs, []);
    // The explicit marker lets callers tell this apart from a real empty poll.
    assert.equal(result.timedOut, true);
    assert.deepEqual(readPollMeta(result), {
      outcome: "timeout",
      errorClass: "timeout",
      httpStatus: null,
      rpcSuccess: null,
      responseEmpty: true,
      parseSuccess: null,
    });
    assert.equal(classifyPollError({}, readPollMeta(result)), "timeout");
  });
});

test("a real empty poll (HTTP 200, zero messages) is NOT flagged as timed out", async () => {
  await withFetch(async () => response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "cursor-next" })), async () => {
    const result = await getUpdates({ baseUrl: "https://example.test", token: "private-token", getUpdatesBuf: "cursor" });
    assert.equal(result.timedOut, undefined);
    assert.equal(readPollMeta(result).outcome, "success");
  });
});

test("poll HTTP, network, RPC, and response parse failures are classified without retaining bodies", async () => {
  await withFetch(async () => response("private response body", 503), async () => {
    await assert.rejects(
      getUpdates({ baseUrl: "https://example.test", token: "private-token" }),
      (error) => error.httpStatus === 503 && error.pollErrorClass === "http",
    );
  });

  await withFetch(async () => { throw new Error("socket private-token failure"); }, async () => {
    await assert.rejects(
      getUpdates({ baseUrl: "https://example.test", token: "private-token" }),
      (error) => error.pollErrorClass === "network",
    );
  });

  await withFetch(async () => response(JSON.stringify({ ret: -14, errmsg: "private response detail" })), async () => {
    const result = await getUpdates({ baseUrl: "https://example.test", token: "private-token" });
    assert.equal(readPollMeta(result).rpcSuccess, false);
    assert.equal(readPollMeta(result).rpcCode, -14);
    const pollError = buildPollError({
      pollSequenceId: "poll-rpc",
      startedAt: "2026-09-02T09:00:00.000Z",
      startedMonotonicMs: 10,
      cursorBefore: "cursor",
      error: Object.assign(new Error("rpc failure"), { ret: -14 }),
      responseMeta: readPollMeta(result),
    });
    assert.equal(pollError.errorClass, "rpc");
    assert.equal(JSON.stringify(pollError).includes("private response detail"), false);
  });

  await withFetch(async () => response("private message body", 200), async () => {
    await assert.rejects(
      getUpdates({ baseUrl: "https://example.test", token: "private-token" }),
      (error) => error.pollErrorClass === "parse"
        && readPollMeta(error).parseSuccess === false
        && !JSON.stringify(readPollMeta(error)).includes("private message body"),
    );
  });
});

test("poll errors retain bounded transport cause and retry state without sensitive details", () => {
  const error = new TypeError("fetch failed with private-token");
  error.cause = Object.assign(new Error("socket private-token failure"), {
    code: "ECONNRESET",
    syscall: "read",
    address: "43.163.165.187",
    port: 443,
  });
  const result = buildPollError({
    pollSequenceId: "poll-network",
    startedAt: "2026-09-02T09:00:00.000Z",
    startedMonotonicMs: 10,
    cursorBefore: "cursor",
    error,
    endpointHost: "https://ilinkai.weixin.qq.com/",
    activePollCount: 0,
    consecutiveFailures: 3,
    retryDelayMs: 30_000,
  });
  assert.equal(result.endpointHost, "ilinkai.weixin.qq.com");
  assert.equal(result.activePollCount, 0);
  assert.equal(result.consecutiveFailures, 3);
  assert.equal(result.retryDelayMs, 30_000);
  assert.equal(result.errorCode, "ECONNRESET");
  assert.deepEqual(result.errorDetail, {
    name: "TypeError",
    code: null,
    causeName: "Error",
    causeCode: "ECONNRESET",
    syscall: "read",
    errno: null,
    address: "43.163.165.187",
    port: 443,
  });
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});

test("inbound filter detailed result preserves normalize semantics and explains filtered updates", () => {
  const filter = createInboundFilter();
  const config = { workspaceId: "workspace" };
  const bot = filter.normalizeDetailed({ message_type: 2, from_user_id: "bot" }, config, "account");
  assert.equal(bot.normalized, null);
  assert.equal(bot.rejectionReason, "bot_message");

  const accepted = filter.normalizeDetailed({
    message_type: 1,
    from_user_id: "sender",
    message_id: 1,
    item_list: [{ type: 1, text_item: { text: "hello" } }],
  }, config, "account");
  assert.equal(accepted.rejectionReason, null);
  assert.equal(accepted.normalized.text, "hello");
  assert.deepEqual(filter.normalize({
    message_type: 1,
    from_user_id: "sender-2",
    message_id: 2,
    item_list: [{ type: 1, text_item: { text: "hello" } }],
  }, config, "account").text, "hello");
});
