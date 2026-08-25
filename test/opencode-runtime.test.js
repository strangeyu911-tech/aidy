"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { OpenCodeClient } = require("../src/adapters/runtime/opencode/client");
const { createOpenCodeRuntimeAdapter } = require("../src/adapters/runtime/opencode");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-opencode-test-"));
}

function externalProfile(overrides = {}) {
  return {
    id: "external-profile",
    runtimeId: "opencode",
    ownershipMode: "external",
    providerId: "dynamic-provider",
    modelId: "dynamic-model",
    secretGeneration: 0,
    status: "verified",
    baseUrl: "http://127.0.0.1:4096",
    options: { serviceUsername: "service-user" },
    ...overrides,
  };
}

function managedProfile(overrides = {}) {
  return {
    id: "managed-profile",
    runtimeId: "opencode",
    ownershipMode: "managed-local",
    providerId: "dynamic-provider",
    modelId: "dynamic-model",
    secretGeneration: 0,
    status: "verified",
    baseUrl: "https://provider.example.test/v1",
    options: {},
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "" },
    async text() { return ""; },
  };
}

function providerResponse(overrides = {}) {
  return {
    all: [{
      id: "dynamic-provider",
      name: "Dynamically discovered",
      source: "config",
      models: {
        "dynamic-model": {
          id: "dynamic-model",
          name: "Dynamic Model",
          modalities: { input: ["text", "image"] },
          limit: { context: 123456 },
        },
      },
    }],
    default: { "dynamic-provider": "dynamic-model" },
    connected: ["dynamic-provider"],
    ...overrides,
  };
}

function createFetchRouter(requests, { version = () => "1.2.3", events = [] } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push({
      url,
      path: parsed.pathname,
      method: init.method || "GET",
      headers: { ...(init.headers || {}) },
      body: init.body,
      signal: init.signal,
    });
    if (parsed.pathname.endsWith("/global/health")) {
      return jsonResponse({ healthy: true, version: version() });
    }
    if (parsed.pathname.endsWith("/provider")) return jsonResponse(providerResponse());
    if (parsed.pathname.endsWith("/event")) return sseResponse(events);
    if (parsed.pathname.endsWith("/session") && (init.method || "GET") === "POST") {
      return jsonResponse({ id: "session-1", title: "CyberBoss" });
    }
    if (parsed.pathname.endsWith("/message") && (init.method || "GET") === "GET") {
      return jsonResponse([{ info: { id: "message-1", role: "assistant" }, parts: [] }]);
    }
    if (parsed.pathname.endsWith("/prompt_async")) return emptyResponse();
    if (parsed.pathname.endsWith("/abort")) return jsonResponse(true);
    if (parsed.pathname.includes("/permissions/")) return jsonResponse(true);
    return jsonResponse({ error: "missing route" }, 404);
  };
}

function sseResponse(events) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      async *[Symbol.asyncIterator]() {
        const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
        if (text) {
          const split = Math.max(1, Math.floor(text.length / 2));
          yield encoder.encode(text.slice(0, split));
          yield encoder.encode(text.slice(split));
        }
      },
    },
  };
}

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for condition."));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("external activation always performs a live catalog refresh and never sends provider auth", async () => {
  const requests = [];
  const stateDir = makeStateDir();
  const adapter = createOpenCodeRuntimeAdapter({
    config: { stateDir, fetchImpl: createFetchRouter(requests) },
    profile: externalProfile(),
    secrets: {
      apiKey: "provider-key-must-not-leave-cyberboss",
      servicePassword: "external-service-password",
    },
  });

  const first = await adapter.initialize();
  const second = await adapter.initialize();
  assert.equal(requests.filter((request) => request.path.endsWith("/provider")).length, 2);
  assert.equal(requests.some((request) => request.path.startsWith("/auth/")), false);
  assert.equal(requests.some((request) => String(request.body || "").includes("provider-key-must-not-leave-cyberboss")), false);
  assert.equal(first.catalog.models[0].id, "dynamic-model");
  assert.equal(first.catalog.models[0].providerId, "dynamic-provider");
  assert.equal(first.catalog.models[0].contextWindow, 123456);
  assert.deepEqual(first.catalog.models[0].inputModalities, ["text", "image"]);
  assert.equal(second.catalog.cached, false);
  assert.match(first.catalogMetadata.connectedProviderFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.catalogMetadata.reportedVersion, "1.2.3");

  const expectedBasic = `Basic ${Buffer.from("service-user:external-service-password").toString("base64")}`;
  assert.equal(requests.find((request) => request.path.endsWith("/global/health")).headers.Authorization, expectedBasic);
  assert.equal(JSON.stringify(requests).includes("provider-key-must-not-leave-cyberboss"), false);
  await adapter.close();
});

test("non-loopback plaintext external endpoints and URL credentials are rejected before I/O", async () => {
  for (const endpoint of [
    "http://192.168.1.10:4096",
    "http://example.test:4096",
    "https://user:password@example.test:4096",
  ]) {
    let fetchCalls = 0;
    const adapter = createOpenCodeRuntimeAdapter({
      config: { stateDir: makeStateDir(), fetchImpl: async () => { fetchCalls += 1; } },
      profile: externalProfile({ baseUrl: endpoint }),
      secrets: { servicePassword: "service-secret" },
    });
    await assert.rejects(
      adapter.initialize(),
      (error) => ["INSECURE_ENDPOINT", "INVALID_ENDPOINT"].includes(error.code)
        && /HTTPS|loopback|credentials/i.test(error.message),
    );
    assert.equal(fetchCalls, 0);
  }
});

test("managed local writes only isolated non-secret config and injects the minimum secrets", async () => {
  const stateDir = makeStateDir();
  const workspaceRoot = path.join(stateDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const pretendGlobal = path.join(stateDir, "pretend-user-global-opencode.json");
  fs.writeFileSync(pretendGlobal, "user-owned", "utf8");
  const requests = [];
  const spawns = [];
  const child = makeChild();
  const adapter = createOpenCodeRuntimeAdapter({
    config: {
      stateDir,
      workspaceRoot,
      opencodeCommand: "C:\\Tools\\opencode.exe",
      opencodePort: 43123,
      fetchImpl: createFetchRouter(requests),
      env: {
        PATH: "C:\\Tools",
        OPENAI_API_KEY: "ambient-provider-secret",
        OPENCODE_CONFIG_CONTENT: '{"provider":{"ambient":{"options":{"apiKey":"global-secret"}}}}',
        UNRELATED_SETTING: "kept",
      },
    },
    profile: managedProfile(),
    secrets: {
      apiKey: "managed-provider-key",
      servicePassword: "managed-service-password",
    },
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
  });

  const ready = await adapter.initialize();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "C:\\Tools\\opencode.exe");
  assert.deepEqual(spawns[0].args, ["serve", "--hostname", "127.0.0.1", "--port", "43123"]);
  assert.equal(spawns[0].options.cwd, workspaceRoot);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.deepEqual(spawns[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawns[0].options.env.CYBERBOSS_OPENCODE_PROVIDER_KEY, "managed-provider-key");
  assert.equal(spawns[0].options.env.OPENCODE_SERVER_PASSWORD, "managed-service-password");
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(spawns[0].options.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(spawns[0].options.env.UNRELATED_SETTING, "kept");
  for (const variable of [
    "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_CACHE_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA",
  ]) {
    assert.equal(path.resolve(spawns[0].options.env[variable]).startsWith(path.resolve(stateDir)), true, variable);
  }

  assert.equal(fs.existsSync(ready.isolatedConfigPath), true);
  const reopenedConfig = JSON.parse(fs.readFileSync(ready.isolatedConfigPath, "utf8"));
  assert.equal(reopenedConfig.provider["dynamic-provider"].options.apiKey, "{env:CYBERBOSS_OPENCODE_PROVIDER_KEY}");
  assert.equal(reopenedConfig.provider["dynamic-provider"].options.baseURL, "https://provider.example.test/v1");
  assert.equal(JSON.stringify(reopenedConfig).includes("managed-provider-key"), false);
  assert.equal(JSON.stringify(reopenedConfig).includes("managed-service-password"), false);
  assert.equal(fs.readFileSync(pretendGlobal, "utf8"), "user-owned");

  await adapter.close();
  assert.equal(child.killed, true);
});

test("managed catalog uses the ten-minute cache and invalidates on version change", async () => {
  let version = "1.0.0";
  let now = 1_000;
  const requests = [];
  const child = makeChild();
  const adapter = createOpenCodeRuntimeAdapter({
    config: {
      stateDir: makeStateDir(),
      workspaceRoot: process.cwd(),
      opencodePort: 43124,
      now: () => now,
      fetchImpl: createFetchRouter(requests, { version: () => version }),
    },
    profile: managedProfile(),
    secrets: { apiKey: "managed-key", servicePassword: "service-key" },
    spawnImpl: () => child,
  });

  const first = await adapter.initialize();
  now += 9 * 60_000;
  const cached = await adapter.initialize();
  assert.equal(requests.filter((request) => request.path.endsWith("/provider")).length, 1);
  assert.equal(first.catalog.cached, false);
  assert.equal(cached.catalog.cached, true);

  version = "1.1.0";
  const changed = await adapter.initialize();
  assert.equal(requests.filter((request) => request.path.endsWith("/provider")).length, 2);
  assert.equal(changed.catalog.cached, false);
  assert.equal(changed.catalogMetadata.reportedVersion, "1.1.0");
  await adapter.close();
});

test("managed provider catalog events invalidate the live catalog within the TTL", async () => {
  const requests = [];
  const child = makeChild();
  const adapter = createOpenCodeRuntimeAdapter({
    config: {
      stateDir: makeStateDir(),
      workspaceRoot: process.cwd(),
      opencodePort: 43128,
      fetchImpl: createFetchRouter(requests, {
        events: [
          { type: "catalog.updated", properties: {} },
          { type: "session.idle", properties: { sessionID: "catalog-probe" } },
        ],
      }),
    },
    profile: managedProfile(),
    secrets: { apiKey: "managed-key", servicePassword: "service-key" },
    spawnImpl: () => child,
  });

  const events = [];
  adapter.onEvent((event) => events.push(event));
  await adapter.initialize();
  await waitFor(() => events.some((event) => event.type === "runtime.turn.completed"));
  await adapter.initialize();
  assert.equal(requests.filter((request) => request.path.endsWith("/provider")).length, 2);
  await adapter.close();
});

test("client maps official HTTP endpoints, cancellation, and safe error codes", async () => {
  const requests = [];
  const client = new OpenCodeClient({
    endpoint: "https://service.example.test/opencode",
    username: "opencode",
    password: "service-password",
    directory: "D:\\workspace",
    fetchImpl: createFetchRouter(requests),
  });

  assert.deepEqual(await client.health(), { healthy: true, version: "1.2.3" });
  assert.equal((await client.listProviders()).connected[0], "dynamic-provider");
  assert.equal((await client.createSession({ title: "CyberBoss" })).id, "session-1");
  assert.equal((await client.listMessages("session-1")).length, 1);
  await client.promptAsync("session-1", {
    messageID: "turn-1",
    model: { providerID: "dynamic-provider", modelID: "dynamic-model" },
    parts: [{ type: "text", text: "hello" }],
  });
  assert.equal(await client.abortSession("session-1"), true);
  assert.equal(await client.respondPermission("session-1", "permission-1", "always"), true);

  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ["GET", "/opencode/global/health"],
    ["GET", "/opencode/provider"],
    ["POST", "/opencode/session"],
    ["GET", "/opencode/session/session-1/message"],
    ["POST", "/opencode/session/session-1/prompt_async"],
    ["POST", "/opencode/session/session-1/abort"],
    ["POST", "/opencode/session/session-1/permissions/permission-1"],
  ]);
  assert.equal(new URL(requests[1].url).searchParams.get("directory"), "D:\\workspace");
  assert.deepEqual(JSON.parse(requests[4].body).model, { providerID: "dynamic-provider", modelID: "dynamic-model" });
  assert.deepEqual(JSON.parse(requests[6].body), { response: "always" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.health({ signal: controller.signal }), (error) => error.code === "CANCELLED");

  const denied = new OpenCodeClient({
    endpoint: "https://service.example.test",
    password: "do-not-leak-this",
    fetchImpl: async () => jsonResponse({ error: "do-not-leak-this" }, 401),
  });
  await assert.rejects(
    denied.health(),
    (error) => error.code === "INVALID_SERVICE_CREDENTIALS" && !error.message.includes("do-not-leak-this"),
  );

  const unhealthy = new OpenCodeClient({
    endpoint: "https://service.example.test",
    fetchImpl: async () => jsonResponse({ healthy: false, version: "1.2.3", detail: "internal-secret" }),
  });
  await assert.rejects(
    unhealthy.health(),
    (error) => error.code === "OPENCODE_UNHEALTHY" && !error.message.includes("internal-secret"),
  );
});

test("live catalog validation uses stable provider/model errors without response leakage", async () => {
  for (const [catalog, expectedCode] of [
    [providerResponse({ connected: [] }), "PROVIDER_UNAVAILABLE"],
    [providerResponse({ all: [{ id: "dynamic-provider", name: "Dynamic", source: "config", models: {} }] }), "MODEL_UNAVAILABLE"],
  ]) {
    const adapter = createOpenCodeRuntimeAdapter({
      config: {
        stateDir: makeStateDir(),
        fetchImpl: async (url) => {
          const pathname = new URL(url).pathname;
          if (pathname.endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.2.3" });
          if (pathname.endsWith("/provider")) return jsonResponse({ ...catalog, diagnostic: "provider-secret" });
          return sseResponse([]);
        },
      },
      profile: externalProfile(),
      secrets: { servicePassword: "service-password" },
    });
    await assert.rejects(
      adapter.initialize(),
      (error) => error.code === expectedCode && !error.message.includes("provider-secret"),
    );
    await adapter.close();
  }
});

test("managed health probing observes cancellation and pre-ready process exit", async () => {
  const cancelledChild = makeChild();
  const controller = new AbortController();
  const cancelled = createOpenCodeRuntimeAdapter({
    config: {
      stateDir: makeStateDir(),
      workspaceRoot: process.cwd(),
      opencodePort: 43126,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("abort"), { name: "AbortError" })), { once: true });
      }),
    },
    profile: managedProfile(),
    secrets: { apiKey: "managed-key", servicePassword: "service-password" },
    spawnImpl: () => cancelledChild,
  });
  const pending = cancelled.initialize({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
  await cancelled.close();

  const exitingChild = makeChild();
  const exiting = createOpenCodeRuntimeAdapter({
    config: {
      stateDir: makeStateDir(),
      workspaceRoot: process.cwd(),
      opencodePort: 43127,
      healthRetryDelayMs: 1,
      fetchImpl: async () => { throw new Error("not listening"); },
    },
    profile: managedProfile(),
    secrets: { apiKey: "managed-key", servicePassword: "service-password" },
    spawnImpl: () => {
      queueMicrotask(() => exitingChild.emit("exit", 12, null));
      return exitingChild;
    },
  });
  await assert.rejects(exiting.initialize(), (error) => error.code === "OPENCODE_PROCESS_EXITED");
  await exiting.close();
});

test("SSE session, message, permission, failure, abort, and permission reply map to runtime events", async () => {
  const requests = [];
  const events = [
    { type: "server.connected", properties: {} },
    {
      type: "message.updated",
      properties: { info: { id: "turn-1", sessionID: "session-1", role: "assistant", time: { created: 1 } } },
    },
    {
      type: "message.part.updated",
      properties: {
        part: { id: "part-1", sessionID: "session-1", messageID: "turn-1", type: "text", text: "hello" },
        delta: "hello",
      },
    },
    {
      type: "permission.updated",
      properties: {
        id: "permission-1", sessionID: "session-1", messageID: "turn-1", type: "bash",
        title: "Run command", pattern: ["npm", "test"], metadata: { secret: "must-not-be-forwarded" }, time: { created: 2 },
      },
    },
    { type: "session.idle", properties: { sessionID: "session-1" } },
    {
      type: "session.error",
      properties: { sessionID: "session-2", error: { name: "ProviderAuthError", data: { message: "provider-key-leak" } } },
    },
  ];
  const adapter = createOpenCodeRuntimeAdapter({
    config: { stateDir: makeStateDir(), fetchImpl: createFetchRouter(requests, { events }) },
    profile: externalProfile(),
    secrets: { servicePassword: "service-password" },
  });
  const mapped = [];
  adapter.onEvent((event) => mapped.push(event));
  await adapter.initialize();
  await waitFor(() => mapped.some((event) => event.type === "runtime.turn.failed"));

  assert.deepEqual(mapped.slice(0, 5).map((event) => event.type), [
    "runtime.turn.started",
    "runtime.reply.delta",
    "runtime.approval.requested",
    "runtime.turn.completed",
    "runtime.turn.failed",
  ]);
  const approval = mapped.find((event) => event.type === "runtime.approval.requested");
  assert.equal(approval.payload.requestId, "permission-1");
  assert.deepEqual(approval.payload.commandTokens, ["npm", "test"]);
  assert.equal(JSON.stringify(approval).includes("must-not-be-forwarded"), false);
  assert.equal(JSON.stringify(mapped).includes("provider-key-leak"), false);

  await adapter.respondApproval({ requestId: "permission-1", decision: "accept", remember: true });
  await adapter.cancelTurn({ threadId: "session-1", turnId: "turn-1" });
  const permissionRequest = requests.find((request) => request.path.endsWith("/permissions/permission-1"));
  assert.deepEqual(JSON.parse(permissionRequest.body), { response: "always" });
  assert.equal(requests.some((request) => request.path.endsWith("/session/session-1/abort")), true);
  await adapter.close();
});

test("adapter sends dynamically selected provider/model and reports managed process exit without stderr leakage", async () => {
  const requests = [];
  const child = makeChild();
  const adapter = createOpenCodeRuntimeAdapter({
    config: {
      stateDir: makeStateDir(),
      workspaceRoot: process.cwd(),
      opencodePort: 43125,
      randomUUID: () => "turn-dynamic",
      fetchImpl: createFetchRouter(requests),
    },
    profile: managedProfile({ providerId: "dynamic-provider", modelId: "dynamic-model" }),
    secrets: { apiKey: "managed-provider-key", servicePassword: "service-password" },
    spawnImpl: () => child,
  });
  const events = [];
  adapter.onEvent((event) => events.push(event));
  const turn = await adapter.sendTurn({
    bindingKey: "binding-1",
    workspaceRoot: process.cwd(),
    text: "hello opencode",
  });
  assert.deepEqual(turn, { threadId: "session-1", turnId: "turn-dynamic" });
  const prompt = requests.find((request) => request.path.endsWith("/prompt_async"));
  assert.deepEqual(JSON.parse(prompt.body).model, {
    providerID: "dynamic-provider",
    modelID: "dynamic-model",
  });

  child.stderr.emit("data", Buffer.from("managed-provider-key"));
  child.emit("exit", 23, null);
  await waitFor(() => events.some((event) => event.payload?.code === "OPENCODE_PROCESS_EXITED"));
  assert.equal(JSON.stringify(events).includes("managed-provider-key"), false);
  await adapter.close();
});

test("OpenCode session reuse is scoped to the exact profile identity", async () => {
  const stateDir = makeStateDir();
  let sessionsCreated = 0;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.2.3" });
    if (pathname.endsWith("/provider")) return jsonResponse(providerResponse());
    if (pathname.endsWith("/event")) return sseResponse([]);
    if (pathname.endsWith("/session") && init.method === "POST") {
      sessionsCreated += 1;
      return jsonResponse({ id: `session-${sessionsCreated}` });
    }
    if (pathname.endsWith("/prompt_async")) return emptyResponse();
    return jsonResponse({}, 404);
  };
  const first = createOpenCodeRuntimeAdapter({
    config: { stateDir, fetchImpl, randomUUID: () => "turn-1" },
    profile: externalProfile({ id: "profile-one", secretGeneration: 1 }),
    secrets: { servicePassword: "service-password" },
  });
  await first.sendTurn({ bindingKey: "binding", workspaceRoot: stateDir, text: "first" });
  await first.close();

  const second = createOpenCodeRuntimeAdapter({
    config: { stateDir, fetchImpl, randomUUID: () => "turn-2" },
    profile: externalProfile({ id: "profile-two", secretGeneration: 1 }),
    secrets: { servicePassword: "service-password" },
  });
  const turn = await second.sendTurn({ bindingKey: "binding", workspaceRoot: stateDir, text: "second" });
  assert.equal(sessionsCreated, 2);
  assert.equal(turn.threadId, "session-2");
  await second.close();
});

test("catalog fingerprint is deterministic and contains no provider credential material", async () => {
  const requests = [];
  const adapter = createOpenCodeRuntimeAdapter({
    config: { stateDir: makeStateDir(), fetchImpl: createFetchRouter(requests) },
    profile: externalProfile(),
    secrets: { apiKey: "provider-secret", servicePassword: "service-secret" },
  });
  const ready = await adapter.initialize();
  const expected = crypto.createHash("sha256").update(JSON.stringify(["dynamic-provider"])).digest("hex");
  assert.equal(ready.catalogMetadata.connectedProviderFingerprint, expected);
  assert.equal(JSON.stringify(ready).includes("provider-secret"), false);
  assert.equal(JSON.stringify(ready).includes("service-secret"), false);
  await adapter.close();
});
