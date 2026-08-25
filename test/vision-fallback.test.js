"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { VisionFallback } = require("../src/services/vision-fallback");
const { resolveVisionContext } = require("../src/services/vision-context");
const { ProviderProfileStore } = require("../src/core/provider-profile-store");
const { ThreadStateStore } = require("../src/core/thread-state-store");

const attachment = Object.freeze({
  absolutePath: "D:\\inbox\\image.png",
  filePath: "D:\\inbox\\image.png",
  sourceFileName: "image.png",
  contentType: "image/png",
  isImage: true,
});

function profiles({ activeOverrides = {}, visionOverrides = {} } = {}) {
  const active = {
    id: "text-profile",
    runtimeId: "builtin-api",
    providerId: "text-provider",
    modelId: "text-model",
    secretGeneration: 1,
    status: "verified",
    capabilities: { imageInput: false },
    visionProfileId: "vision-profile",
    ...activeOverrides,
  };
  const vision = {
    id: "vision-profile",
    runtimeId: "builtin-api",
    providerId: "vision-provider",
    modelId: "vision-model",
    secretGeneration: 4,
    status: "verified",
    capabilities: { imageInput: true },
    visionProfileId: "",
    ...visionOverrides,
  };
  const byId = new Map([[active.id, active], [vision.id, vision]]);
  return {
    active,
    vision,
    store: {
      getActive: () => active,
      get: (id) => byId.get(id) || null,
      markUnverifiedCalls: [],
      markUnverified(id, reason) { this.markUnverifiedCalls.push({ id, reason }); },
    },
  };
}

function makeFallback(options = {}) {
  const fixture = options.fixture || profiles();
  return {
    fixture,
    fallback: new VisionFallback({
      profileStore: fixture.store,
      timeoutMs: options.timeoutMs || 1_000,
      runVisionOperation: options.runVisionOperation,
      capture: options.capture,
      randomUUID: options.randomUUID || (() => "vision-operation-1"),
    }),
  };
}

test("verified vision profile returns only text and attributes usage to the child profile and parent", async () => {
  const calls = [];
  const parentTurn = { id: "parent-turn", profileId: "text-profile" };
  const { fallback } = makeFallback({
    runVisionOperation: async (input) => {
      calls.push(input);
      return { description: "A blue bicycle beside a wall.", usage: { inputTokens: 120, outputTokens: 12 } };
    },
  });

  const result = await fallback.describeAttachment({ attachment, parentTurn });
  assert.equal(result.ok, true);
  assert.equal(result.description, "A blue bicycle beside a wall.");
  assert.equal(result.attachment, attachment);
  assert.equal(result.usage.profileId, "vision-profile");
  assert.deepEqual(result.usage.tokens, { inputTokens: 120, outputTokens: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.id, "vision-profile");
  assert.equal(calls[0].parentTurn.id, "parent-turn");
  assert.deepEqual(parentTurn.usage.byProfile["vision-profile"], { inputTokens: 120, outputTokens: 12 });
  assert.equal(parentTurn.usage.byProfile["text-profile"], undefined);
});

test("one retry is allowed only for transient transport or rate-limit failures", async () => {
  for (const code of ["MODEL_SERVICE_UNAVAILABLE", "RATE_LIMITED"]) {
    let attempts = 0;
    const { fallback } = makeFallback({
      runVisionOperation: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error(code), { code });
        return { description: "Recovered description", usage: {} };
      },
    });
    assert.equal((await fallback.describeAttachment({ attachment, parentTurn: { id: code } })).ok, true);
    assert.equal(attempts, 2);
  }

  let authenticationAttempts = 0;
  const auth = makeFallback({
    runVisionOperation: async () => {
      authenticationAttempts += 1;
      throw Object.assign(new Error("bad credentials"), { code: "INVALID_CREDENTIALS" });
    },
  });
  const failed = await auth.fallback.describeAttachment({ attachment, parentTurn: { id: "auth-parent" } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "VISION_PROFILE_AUTH_FAILED");
  assert.equal(authenticationAttempts, 1);
  assert.deepEqual(auth.fixture.store.markUnverifiedCalls, [{ id: "vision-profile", reason: "invalid_credentials" }]);
});

test("hard timeout and parent cancellation stop the child without retry", async () => {
  let timeoutAttempts = 0;
  const timed = makeFallback({
    timeoutMs: 20,
    runVisionOperation: ({ signal }) => new Promise((_resolve, reject) => {
      timeoutAttempts += 1;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  const timeoutResult = await timed.fallback.describeAttachment({ attachment, parentTurn: { id: "timeout-parent" } });
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.error.code, "VISION_TIMEOUT");
  assert.equal(timeoutAttempts, 1);

  let cancellationAttempts = 0;
  const controller = new AbortController();
  const cancelled = makeFallback({
    runVisionOperation: ({ signal }) => new Promise((_resolve, reject) => {
      cancellationAttempts += 1;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  });
  const pending = cancelled.fallback.describeAttachment({ attachment, parentTurn: { id: "cancel-parent" }, signal: controller.signal });
  controller.abort();
  const cancelledResult = await pending;
  assert.equal(cancelledResult.ok, false);
  assert.equal(cancelledResult.error.code, "VISION_CANCELLED");
  assert.equal(cancellationAttempts, 0);
});

test("deleted, unverified, non-visual, self-referencing, and cyclic profiles fail closed", async () => {
  const cases = [
    { fixture: profiles({ activeOverrides: { visionProfileId: "missing" } }), code: "VISION_PROFILE_NOT_FOUND" },
    { fixture: profiles({ visionOverrides: { status: "unverified" } }), code: "VISION_PROFILE_NOT_VERIFIED" },
    { fixture: profiles({ visionOverrides: { capabilities: { imageInput: false } } }), code: "VISION_PROFILE_NOT_CAPABLE" },
    { fixture: profiles({ activeOverrides: { visionProfileId: "text-profile" } }), code: "VISION_PROFILE_CYCLE" },
    { fixture: profiles({ visionOverrides: { visionProfileId: "text-profile" } }), code: "VISION_PROFILE_CYCLE" },
  ];
  for (const item of cases) {
    let calls = 0;
    const { fallback } = makeFallback({
      fixture: item.fixture,
      runVisionOperation: async () => { calls += 1; return { description: "must not run" }; },
    });
    const result = await fallback.describeAttachment({ attachment, parentTurn: { id: item.code } });
    assert.equal(result.ok, false, item.code);
    assert.equal(result.error.code, item.code);
    assert.equal(result.attachment, attachment);
    assert.equal(calls, 0);
  }
});

test("failed fallback preserves the attachment, exposes an image error, and blocks the text runtime", async () => {
  let textRuntimeCalls = 0;
  const { fallback } = makeFallback({
    runVisionOperation: async () => { throw Object.assign(new Error("malformed response"), { code: "INCOMPATIBLE_PROTOCOL" }); },
  });
  const prepared = { attachments: [attachment], text: "what is this?" };
  const context = await resolveVisionContext({
    prepared,
    runtimeAdapter: { getTurnCapabilities: () => ({ nativeImageInput: false, toolImageRead: false }) },
    visionFallback: fallback,
    parentTurn: { id: "parent-failure" },
  });
  if (!context.blockingError) textRuntimeCalls += 1;

  assert.equal(context.route, "none");
  assert.equal(context.blockingError.code, "VISION_PROCESSING_FAILED");
  assert.match(context.blockingError.message, /image could not be processed/i);
  assert.equal(context.errors[0].absolutePath, attachment.absolutePath);
  assert.equal(textRuntimeCalls, 0);
});

test("profile-based routing ignores legacy visionMode off so text-only models cannot bypass preprocessing", async () => {
  const { fallback } = makeFallback({
    runVisionOperation: async () => ({ description: "Required profile caption", usage: {} }),
  });
  const context = await resolveVisionContext({
    prepared: { attachments: [attachment] },
    config: { visionMode: "off" },
    runtimeAdapter: { getTurnCapabilities: () => ({ nativeImageInput: false, toolImageRead: false }) },
    visionFallback: fallback,
    parentTurn: { id: "legacy-mode-parent" },
  });
  assert.equal(context.route, "caption");
  assert.equal(context.items[0].description, "Required profile caption");
});

test("diagnostic capture includes child text and sanitized image metadata, never the original payload", async () => {
  const records = [];
  const { fallback } = makeFallback({
    capture: { async record(value) { records.push(value); } },
    runVisionOperation: async () => ({ description: "A desk with a notebook.", usage: {} }),
  });
  const withBytes = { ...attachment, bytes: Buffer.from("raw-original-image") };
  await fallback.describeAttachment({ attachment: withBytes, parentTurn: { id: "capture-parent" } });
  assert.equal(records.length, 2);
  assert.equal(records[0].kind, "vision");
  assert.equal(records[0].phase, "request");
  assert.equal(records[1].responseText, "A desk with a notebook.");
  assert.equal(Object.hasOwn(records[0], "bytes"), false);
  assert.equal(JSON.stringify(records).includes("raw-original-image"), false);
});

test("default child operation owns one vision runtime lifecycle and never exposes project tools", async () => {
  const fixture = profiles();
  const calls = [];
  let listener = null;
  const fallback = new VisionFallback({
    config: { workspaceRoot: "D:\\workspace" },
    profileStore: fixture.store,
    vault: { getGeneration: () => 4, read: async () => ({ apiKey: "secret" }) },
    adapterFactory: async (options) => {
      calls.push(["factory", options.profile.id, options.requireActive, options.projectToolHost.listTools().length]);
      return {
        onEvent(callback) { listener = callback; return () => { listener = null; }; },
        async initialize({ signal }) { calls.push(["initialize", signal.aborted]); },
        async sendTurn(input) {
          calls.push(["send", input.attachments[0].filePath, input.metadata.parentTurnId]);
          setImmediate(() => {
            listener({ type: "runtime.reply.completed", payload: { threadId: "vision-thread", turnId: "vision-turn", text: "Lifecycle caption" } });
            listener({ type: "runtime.turn.completed", payload: { threadId: "vision-thread", turnId: "vision-turn", usage: { inputTokens: 8, outputTokens: 2 } } });
          });
          return { threadId: "vision-thread", turnId: "vision-turn" };
        },
        async close() { calls.push(["close"]); },
      };
    },
  });

  const result = await fallback.describeAttachment({ attachment, parentTurn: { id: "parent-lifecycle" } });
  assert.equal(result.ok, true);
  assert.equal(result.description, "Lifecycle caption");
  assert.deepEqual(result.usage.tokens, { inputTokens: 8, outputTokens: 2 });
  assert.deepEqual(calls, [
    ["factory", "vision-profile", false, 0],
    ["initialize", false],
    ["send", attachment.filePath, "parent-lifecycle"],
    ["close"],
  ]);
});

test("vision usage is linked to the parent runtime turn and never charged to the text profile", () => {
  const store = new ThreadStateStore();
  store.recordUsage("thread-1", {
    kind: "vision",
    operationId: "vision-op",
    turnId: "turn-1",
    parentTurnId: "inbound-1",
    profileId: "vision-profile",
    tokens: { inputTokens: 10, outputTokens: 3 },
  });
  store.applyRuntimeEvent({
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      profileId: "text-profile",
      usage: { inputTokens: 20, outputTokens: 5 },
    },
  });
  const usage = store.getThreadState("thread-1").usage;
  assert.deepEqual(usage.total, { inputTokens: 30, outputTokens: 8 });
  assert.deepEqual(usage.byProfile["vision-profile"], { inputTokens: 10, outputTokens: 3 });
  assert.deepEqual(usage.byProfile["text-profile"], { inputTokens: 20, outputTokens: 5 });
});

test("deleting a vision profile clears persisted references and safely deactivates affected profiles", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-vision-delete-"));
  const store = new ProviderProfileStore({ stateDir, randomUUID: () => "unused" });
  store.upsertDraft({ id: "vision", runtimeId: "builtin-api", providerId: "p", modelId: "vision" });
  store.markVerified("vision", { secretGeneration: 0, capabilities: { imageInput: true } });
  store.upsertDraft({
    id: "text",
    runtimeId: "builtin-api",
    providerId: "p",
    modelId: "text",
    visionProfileId: "vision",
  });
  store.markVerified("text", { secretGeneration: 0, capabilities: { imageInput: false } });
  store.activate("text");

  assert.equal(store.delete("vision"), true);
  assert.equal(store.getActive(), null);
  assert.equal(store.get("text").visionProfileId, "");
  assert.equal(store.get("text").status, "draft");
  assert.equal(fs.existsSync(path.join(stateDir, "provider-profiles.json")), true);
  const reopened = new ProviderProfileStore({ stateDir });
  assert.equal(reopened.get("text").visionProfileId, "");
  assert.equal(reopened.getActive(), null);
});
