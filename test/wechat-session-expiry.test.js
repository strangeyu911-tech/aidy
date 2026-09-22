"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RuntimeSupervisor } = require("../src/desktop/runtime-supervisor");
const { CyberbossApp } = require("../src/core/app");
const { computeVerificationFingerprint } = require("../src/core/provider-profile-store");
const { resolveWechatStatus } = require("../src/desktop/connection-diagnostics");

function createSupervisor() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-session-expiry-"));
  const supervisor = new RuntimeSupervisor({
    rootDir: stateDir,
    stateDir,
    logger: null,
  });
  // In the real scenario the user wants Aidy running, so the bridge exit is not
  // an intentional stop. handleExit short-circuits on desiredState === "stopped".
  supervisor.desiredState = "running";
  supervisor.children.set("bridge", { exitCode: null });
  return { supervisor, stateDir };
}

test("bridge session-expiry output is captured as WECHAT_SESSION_EXPIRED", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(child.__cyberbossError?.capability, "wechat");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bridge session-expiry via numeric errcode -14 is captured as WECHAT_SESSION_EXPIRED", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "weixin getUpdates ret=null errcode=-14 errmsg=session expired", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_SESSION_EXPIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_SESSION_EXPIRED surfaces a wechat_login remediation through resolveWechatStatus", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。", true);
    const runtimeError = child.__cyberbossError;
    const result = resolveWechatStatus(
      { phase: "error", error: runtimeError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
    assert.match(result.detail, /微信连接已过期/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_LOGIN_REQUIRED still matches after the session-expiry branch was added", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "No saved WeChat account was found", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_LOGIN_REQUIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("WECHAT_ACCOUNT_SELECTION_REQUIRED still matches after the session-expiry branch was added", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "Multiple WeChat accounts were detected", true);
    assert.equal(child.__cyberbossError?.code, "WECHAT_ACCOUNT_SELECTION_REQUIRED");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function driveBridgeExit(supervisor, child, capturedText) {
  supervisor.handleOutput("bridge", "[cyberboss] bridge loop started; waiting for WeChat messages.");
  supervisor.handleOutput("bridge", capturedText, true);
  supervisor.handleExit("bridge", child, 1, null);
}

test("expired WeChat session surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(
      supervisor,
      child,
      "Error: The WeChat session has expired. 微信登录已过期，请在艾迪里点「连接微信」重新扫码。",
    );
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_SESSION_EXPIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("missing WeChat login surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(supervisor, child, "No saved WeChat account was found");
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_LOGIN_REQUIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "wechat_login");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("multiple WeChat accounts surfaces as a user-visible error and stops the restart loop", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(supervisor, child, "Multiple WeChat accounts were detected");
    assert.equal(supervisor.phase, "error");
    assert.equal(supervisor.lastError?.code, "WECHAT_ACCOUNT_SELECTION_REQUIRED");
    assert.equal(supervisor.restartTimes.length, 0);
    assert.equal(supervisor.retryTimer, null);
    const result = resolveWechatStatus(
      { phase: "error", error: supervisor.lastError },
      { configured: true, state: "ready", accountId: "account-1" },
    );
    assert.equal(result.state, "error");
    assert.equal(result.diagnostic.nextAction, "inspect_logs");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a bridge exit with no captured WeChat error still schedules a restart", () => {
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    supervisor.handleOutput("bridge", "[cyberboss] bridge loop started; waiting for WeChat messages.");
    supervisor.handleExit("bridge", child, 1, null);
    assert.equal(supervisor.phase, "starting");
    assert.equal(supervisor.restartTimes.length, 1);
    assert.equal(supervisor.lastError, undefined);
  } finally {
    if (supervisor.retryTimer) clearTimeout(supervisor.retryTimer);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

/**
 * Re-scan recovery: a live bridge has to be replaced, not reused.
 *
 * Scanning the QR code mints a new credential and revokes the previous one a few
 * seconds later, but `createWeixinChannelAdapter` memoizes the account when the
 * bridge process starts. `startBridge` deliberately keeps an already-running bridge,
 * so a recovery that only calls `start()` leaves the old process polling with the
 * revoked token until it dies with `rpcCode -14` — the observed symptom is "the scan
 * said connected, then WeChat went silent with the new token sitting unread on disk".
 */
function createBridgeReplacementHarness(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-bridge-replacement-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const profile = {
    id: "live",
    name: "live",
    runtimeId: "codebuddy",
    ownershipMode: "",
    providerId: "compatibility",
    protocolId: "",
    baseUrl: "http://127.0.0.1:1234",
    options: {},
    modelId: "hy3",
    modelVariant: "",
    visionProfileId: "",
    secretRefs: { apiKey: "", servicePassword: "", sensitiveHeaders: {} },
    secretGeneration: 0,
    status: "verified",
    verifiedFingerprint: "",
    capabilities: { streaming: true, tools: true, cancellation: true },
    verificationError: "",
    catalogMetadata: {},
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    verifiedAt: "2026-09-22T00:00:00.000Z",
  };
  profile.verifiedFingerprint = computeVerificationFingerprint(profile);
  const healthyClient = {
    async health() {
      return {
        runtimeReady: true,
        activeProfileId: profile.id,
        runtimeId: profile.runtimeId,
        modelId: profile.modelId,
        secretGeneration: profile.secretGeneration,
      };
    },
  };
  const supervisor = new RuntimeSupervisor({
    rootDir: path.resolve(__dirname, ".."),
    stateDir,
    profileStore: {
      get: (id) => (id === profile.id ? profile : null),
      getActive: () => profile,
    },
    env: {},
    logger: null,
    bridgeClientFactory: () => healthyClient,
  });
  supervisor.desiredState = "running";
  supervisor.bridgeClient = healthyClient;
  return { supervisor, profile };
}

function fakeBridgeChild(pid) {
  const child = {
    pid,
    exitCode: null,
    __cyberbossReady: true,
    kill() {
      child.exitCode = 0;
    },
  };
  return child;
}

test("retry() replaces a still-running bridge so a re-scanned token is actually read", async (t) => {
  const { supervisor } = createBridgeReplacementHarness(t);
  const memoizingBridge = fakeBridgeChild(1001);
  supervisor.children.set("bridge", memoizingBridge);
  const spawned = [];
  supervisor.spawnOwned = (component) => {
    const child = fakeBridgeChild(2000 + spawned.length);
    spawned.push(child);
    supervisor.children.set(component, child);
    return child;
  };

  await supervisor.retry();

  assert.equal(memoizingBridge.exitCode, 0, "the bridge that memoized the old account must be stopped");
  assert.equal(spawned.length, 1, "retry must spawn a replacement bridge");
  assert.equal(supervisor.children.get("bridge"), spawned[0]);
  assert.equal(supervisor.snapshot().bridgePid, 2000);
  assert.equal(supervisor.phase, "running");
  assert.equal(supervisor.forceBridgeRestart, false, "the one-shot force flag must not leak into later starts");
});

test("retry() does not count the planned bridge stop as a crash restart", async (t) => {
  const { supervisor } = createBridgeReplacementHarness(t);
  const memoizingBridge = fakeBridgeChild(1001);
  supervisor.children.set("bridge", memoizingBridge);
  supervisor.spawnOwned = (component) => {
    const child = fakeBridgeChild(2000);
    supervisor.children.set(component, child);
    return child;
  };

  await supervisor.retry();
  // handleExit runs for the stopped bridge; a planned stop must not schedule a restart.
  supervisor.handleExit("bridge", memoizingBridge, 0, null);

  assert.equal(supervisor.restartTimes.length, 0);
  assert.equal(supervisor.retryTimer, null);
  assert.equal(supervisor.children.get("bridge").pid, 2000);
});

test("an ordinary start keeps a healthy bridge instead of churning the process", async (t) => {
  const { supervisor } = createBridgeReplacementHarness(t);
  const liveBridge = fakeBridgeChild(1001);
  supervisor.children.set("bridge", liveBridge);
  let spawns = 0;
  supervisor.spawnOwned = (component) => {
    spawns += 1;
    const child = fakeBridgeChild(3000);
    supervisor.children.set(component, child);
    return child;
  };

  await supervisor.start();

  assert.equal(spawns, 0, "a healthy bridge must not be replaced on an ordinary start");
  assert.equal(liveBridge.exitCode, null);
  assert.equal(supervisor.children.get("bridge"), liveBridge);
});

test("the fatal session-expiry path releases the bridge control server", async () => {
  // The regression: when the shutdown list and the fatal-exit list were two copies
  // they drifted, and the fatal path forgot `bridgeControlServer`. That leftover
  // listening socket held the event loop open, so the bridge survived with nothing
  // polling WeChat. The supervisor only learns about failures from the child `exit`
  // event, so it kept reporting "connected" over a dead channel.
  const app = Object.create(CyberbossApp.prototype);
  const released = [];
  app.clearPendingImageInboundTimers = () => released.push("timers");
  app.bridgeControlServer = { async close() { released.push("bridgeControlServer"); } };
  app.closeLocationServer = async () => released.push("locationServer");
  app.zhijiantimeDailySupervisor = { async close() { released.push("zhijiantime"); } };
  app.runtimeAdapter = { async close() { released.push("runtimeAdapter"); } };

  await app.releaseRuntimeResources();

  assert.deepEqual(released, [
    "timers",
    "bridgeControlServer",
    "locationServer",
    "zhijiantime",
    "runtimeAdapter",
  ]);
});

test("WECHAT_SESSION_SUPERSEDED is retryable and must not read as 'please scan again'", () => {
  // The scan → revoke → scan-again self-lock: a re-scan revokes the live session
  // seconds later, the bridge dies with -14, and the old message demanded yet
  // another scan — revoking the fresh credential in turn. When the credential on
  // disk is newer than the process, the exit must land on the ordinary restart
  // path, NOT the fatal WECHAT_SESSION_EXPIRED branch.
  const { supervisor, stateDir } = createSupervisor();
  try {
    const child = supervisor.children.get("bridge");
    driveBridgeExit(
      supervisor,
      child,
      "Error: A newer WeChat login was saved after this bridge started; restarting to adopt it.",
    );
    assert.notEqual(supervisor.phase, "error", "a superseded session must not stop the restart loop");
    assert.notEqual(supervisor.lastError?.code, "WECHAT_SESSION_EXPIRED");
    assert.ok(supervisor.restartTimes.length >= 1, "the supervisor must schedule a bridge restart");
  } finally {
    if (supervisor.retryTimer) clearTimeout(supervisor.retryTimer);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hasWeChatCredentialNewerThanProcess is false when no credential postdates the process", () => {
  const app = Object.create(CyberbossApp.prototype);
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-credential-fresh-"));
  try {
    app.config = { accountsDir };
    app.startedAtMs = Date.now();
    fs.writeFileSync(path.join(accountsDir, "old-acct.json"), JSON.stringify({ accountId: "old-acct" }));
    // The credential predates the process by a minute — well outside the 5s race window.
    const stale = new Date(app.startedAtMs - 60_000);
    fs.utimesSync(path.join(accountsDir, "old-acct.json"), stale, stale);
    assert.equal(app.hasWeChatCredentialNewerThanProcess(), false);
  } finally {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  }
});

test("hasWeChatCredentialNewerThanProcess is true when a fresh login was saved after start", () => {
  const app = Object.create(CyberbossApp.prototype);
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-credential-fresh-"));
  try {
    app.config = { accountsDir };
    app.startedAtMs = Date.now();
    // Written now, so its mtime is newer than startedAtMs minus the race window.
    fs.writeFileSync(path.join(accountsDir, "new-acct.json"), JSON.stringify({ accountId: "new-acct" }));
    assert.equal(app.hasWeChatCredentialNewerThanProcess(), true);
  } finally {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  }
});

test("hasWeChatCredentialNewerThanProcess ignores retired credentials and missing directories", () => {
  const app = Object.create(CyberbossApp.prototype);
  app.startedAtMs = Date.now();

  app.config = { accountsDir: path.join(os.tmpdir(), "cyberboss-credential-missing-dir") };
  assert.equal(app.hasWeChatCredentialNewerThanProcess(), false);

  // A `.retired-...` file no longer ends in `.json`, so it must not count as a
  // fresh credential even though its mtime is current.
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-credential-retired-"));
  try {
    app.config = { accountsDir };
    fs.writeFileSync(path.join(accountsDir, "old-acct.json.retired-2026-09-22T10-00-00-000Z"), "{}");
    assert.equal(app.hasWeChatCredentialNewerThanProcess(), false);
  } finally {
    fs.rmSync(accountsDir, { recursive: true, force: true });
  }
});

