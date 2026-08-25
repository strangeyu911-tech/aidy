"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { ProviderProfileStore } = require("../src/core/provider-profile-store");
const { CredentialVault } = require("../src/security/credential-vault");
const { ProviderVerifier } = require("../src/services/provider-verifier");

function makeProtector() {
  return {
    protectText: async (text) => Buffer.from(text, "utf8").toString("base64"),
    unprotectText: async (text) => Buffer.from(text, "base64").toString("utf8"),
  };
}

function writeSse(response, objects) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const object of objects) response.write(`data: ${JSON.stringify(object)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function startVerificationServer({ status = 200, rejectContinuation = false } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    requests.push({ url: request.url, headers: request.headers, body });

    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: status === 429 ? "rate limited" : "credential rejected" } }));
      return;
    }
    if (request.method === "GET" && request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "synthetic-model", input_modalities: ["text", "image"] }] }));
      return;
    }

    const messages = body.messages || [];
    const latestText = JSON.stringify(messages.at(-1) || {});
    if (latestText.includes("cancellation probe")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => response.end('data: {"choices":[{"delta":{"content":"late"}}]}\n\n'), 200);
      return;
    }
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = messages.some((message) => message.role === "tool");
    if (!hasTools) {
      writeSse(response, [{ choices: [{ delta: { content: "stream-ok" } }] }]);
      return;
    }
    if (hasToolResult) {
      if (rejectContinuation) {
        writeSse(response, [{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
      } else {
        writeSse(response, [{ choices: [{ delta: { content: "tool-result-ok" }, finish_reason: "stop" }] }]);
      }
      return;
    }
    writeSse(response, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "echo-1", function: { name: "cyberboss_capability_echo", arguments: '{"value":"verification-token"}' } }] }, finish_reason: "tool_calls" }] },
    ]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function makeHarness(server, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-verifier-test-"));
  const profileStore = new ProviderProfileStore({ stateDir, now: () => new Date("2026-08-25T02:00:00.000Z") });
  const profile = profileStore.upsertDraft({
    id: "profile-1",
    name: "Test provider",
    runtimeId: "builtin-api",
    providerId: "openrouter",
    protocolId: "openai-chat",
    baseUrl: server.url,
    modelId: "synthetic-model",
    options: { overallTimeoutMs: 1_000, chunkTimeoutMs: 500 },
    secretRefs: { apiKey: "vault:profile-1:api-key" },
  });
  const credentialVault = new CredentialVault({ stateDir, protector: makeProtector() });
  await credentialVault.write(profile.id, { apiKey: "synthetic-key" });
  const verifier = new ProviderVerifier({
    profileStore,
    credentialVault,
    now: () => new Date("2026-08-25T02:00:00.000Z"),
    cancellationDelayMs: 20,
    ...options,
  });
  return { credentialVault, profile, profileStore, verifier };
}

test("verifier performs live auth, model, streaming, tool, continuation, cancellation, and optional image checks", async (t) => {
  const server = await startVerificationServer();
  t.after(server.close);
  const { profile, profileStore, verifier } = await makeHarness(server, {
    imageProbe: async () => { throw Object.assign(new Error("image rejected"), { code: "IMAGE_UNSUPPORTED" }); },
  });

  const result = await verifier.verify(profile.id);

  assert.equal(result.ok, true);
  assert.equal(result.secretGeneration, 1);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.capabilities, {
    authentication: true,
    modelAccess: true,
    streaming: true,
    tools: true,
    toolContinuation: true,
    cancellation: true,
    imageInput: false,
  });
  assert.equal(result.verifiedAt, "2026-08-25T02:00:00.000Z");
  assert.equal(profileStore.get(profile.id).status, "verified");
  assert.doesNotThrow(() => profileStore.activate(profile.id));
  assert.equal(server.requests.some((request) => request.url === "/models"), true);
  assert.equal(server.requests.every((request) => !JSON.stringify(request).includes("vault:profile-1")), true);
});

test("verifier rejects a model that cannot continue after a tool result", async (t) => {
  const server = await startVerificationServer({ rejectContinuation: true });
  t.after(server.close);
  const { profile, profileStore, verifier } = await makeHarness(server);
  const result = await verifier.verify(profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TOOL_CONTINUATION_UNSUPPORTED");
  assert.equal(profileStore.get(profile.id).status, "draft");
  assert.throws(() => profileStore.activate(profile.id), (error) => error.code === "PROFILE_NOT_VERIFIED");
});

test("401 and 403 mark a verified profile unverified and clear activation", async (t) => {
  for (const status of [401, 403]) {
    await t.test(String(status), async (subtest) => {
      const server = await startVerificationServer({ status });
      subtest.after(server.close);
      const harness = await makeHarness(server);
      harness.profileStore.markVerified(harness.profile.id, { secretGeneration: 1, capabilities: { streaming: true, tools: true } });
      harness.profileStore.activate(harness.profile.id);
      const result = await harness.verifier.verify(harness.profile.id);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "INVALID_CREDENTIALS");
      assert.equal(harness.profileStore.get(harness.profile.id).status, "unverified");
      assert.equal(harness.profileStore.getActive(), null);
    });
  }
});

test("429, quota exhaustion, and transient network failures never invalidate credentials", async (t) => {
  const cases = [
    ["rate", async () => startVerificationServer({ status: 429 }), "RATE_LIMITED"],
    ["quota", async () => ({ url: "http://127.0.0.1:1", close: async () => {} }), "MODEL_SERVICE_UNAVAILABLE"],
  ];
  for (const [name, createServer, code] of cases) {
    await t.test(name, async (subtest) => {
      const server = await createServer();
      subtest.after(server.close);
      const harness = await makeHarness(server);
      harness.profileStore.markVerified(harness.profile.id, { secretGeneration: 1, capabilities: { streaming: true, tools: true } });
      harness.profileStore.activate(harness.profile.id);
      const result = await harness.verifier.verify(harness.profile.id);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code);
      assert.equal(harness.profileStore.get(harness.profile.id).status, "verified");
      assert.equal(harness.profileStore.getActive().id, harness.profile.id);
    });
  }

  const harness = await makeHarness({ url: "http://127.0.0.1:1" }, {
    clientFactory: () => ({
      listModels: async () => { throw Object.assign(new Error("quota"), { code: "QUOTA_EXHAUSTED" }); },
      streamTurn: async () => { throw new Error("must not run"); },
    }),
  });
  harness.profileStore.markVerified(harness.profile.id, { secretGeneration: 1, capabilities: { streaming: true, tools: true } });
  harness.profileStore.activate(harness.profile.id);
  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.error.code, "QUOTA_EXHAUSTED");
  assert.equal(harness.profileStore.get(harness.profile.id).status, "verified");
  assert.equal(harness.profileStore.getActive().id, harness.profile.id);
});

test("verification result is bound to the current secret generation even after an equal-value rewrite", async (t) => {
  const server = await startVerificationServer();
  t.after(server.close);
  const harness = await makeHarness(server);
  const originalRead = harness.credentialVault.read.bind(harness.credentialVault);
  let rewritten = false;
  harness.credentialVault.read = async (profileId) => {
    const value = await originalRead(profileId);
    if (!rewritten) {
      rewritten = true;
      await harness.credentialVault.write(profileId, value);
    }
    return value;
  };

  const result = await harness.verifier.verify(harness.profile.id);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CREDENTIAL_CHANGED");
  assert.equal(harness.credentialVault.getGeneration(harness.profile.id), 2);
  assert.equal(harness.profileStore.get(harness.profile.id).status, "draft");
});

test("unknown, missing, and unverified profiles cannot become active through verifier failure", async () => {
  const profileStore = {
    get: () => null,
    markVerified() { throw new Error("must not be called"); },
    markUnverified() { throw new Error("must not be called"); },
  };
  const verifier = new ProviderVerifier({
    profileStore,
    credentialVault: { getGeneration: () => 0, read: async () => null },
  });
  const result = await verifier.verify("missing");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROFILE_NOT_FOUND");
});
