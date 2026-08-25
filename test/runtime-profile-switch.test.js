"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { computeVerificationFingerprint } = require("../src/core/provider-profile-store");
const { RuntimeSupervisor, normalizeGraceMs } = require("../src/desktop/runtime-supervisor");

test("supervisor refuses Running without a verified active profile", async (t) => {
  const supervisor = createSupervisor(t, { profiles: [], activeProfileId: "" });
  await assert.rejects(supervisor.setDesiredState("running"), (error) => error.code === "NO_ACTIVE_ENGINE");
  assert.equal(supervisor.snapshot().phase, "configuration_required");

  const startupSupervisor = createSupervisor(t, { profiles: [], activeProfileId: "" });
  startupSupervisor.desiredState = "running";
  await assert.rejects(startupSupervisor.start(), (error) => error.code === "NO_ACTIVE_ENGINE");
  assert.equal(startupSupervisor.snapshot().phase, "configuration_required");
});

test("switch grace is clamped to 30-600 seconds and defaults to 120 seconds", () => {
  assert.equal(normalizeGraceMs(undefined), 120_000);
  assert.equal(normalizeGraceMs(1), 30_000);
  assert.equal(normalizeGraceMs(30_000), 30_000);
  assert.equal(normalizeGraceMs(600_000), 600_000);
  assert.equal(normalizeGraceMs(900_000), 600_000);
});

test("runtime startup follows processKind and never starts an unrelated sidecar", async (t) => {
  const profiles = [
    verifiedProfile("api", "builtin-api"),
    verifiedProfile("external-opencode", "opencode", { ownershipMode: "external" }),
    verifiedProfile("managed-opencode", "opencode", { ownershipMode: "managed-local" }),
    verifiedProfile("codex", "codex"),
    verifiedProfile("claude", "claudecode"),
  ];
  const supervisor = createSupervisor(t, { profiles, activeProfileId: "api" });
  const calls = [];
  supervisor.ensureAppServer = async () => calls.push("codex-sidecar");
  supervisor.startBridge = async (profile) => calls.push(`bridge:${profile.id}`);

  for (const profile of profiles) {
    calls.length = 0;
    await supervisor.startProfileRuntime(profile);
    assert.deepEqual(calls, profile.runtimeId === "codex"
      ? ["codex-sidecar", `bridge:${profile.id}`]
      : [`bridge:${profile.id}`]);
  }
});

test("successful switch drains, aborts only after grace, and probes exact new live profile", async (t) => {
  const oldProfile = verifiedProfile("old", "builtin-api", { secretGeneration: 1 });
  const newProfile = verifiedProfile("new", "opencode", { ownershipMode: "external", secretGeneration: 2 });
  const state = { profiles: [oldProfile, newProfile], activeProfileId: oldProfile.id };
  const supervisor = createSupervisor(t, state);
  supervisor.desiredState = "running";
  supervisor.phase = "running";
  const calls = [];
  supervisor.bridgeClient = {
    async drain() { calls.push("drain-old"); return { activeTurns: 1, deadlineExceeded: true, nonInterruptibleBoundary: false }; },
    async abort() { calls.push("abort-old"); return { activeTurns: 0 }; },
  };
  supervisor.stopProfileRuntime = async (profile) => calls.push(`stop-${profile.id}`);
  supervisor.startProfileRuntime = async (profile) => calls.push(`start-${profile.id}`);
  supervisor.probeProfile = async (profile) => calls.push(`probe-${profile.id}`);

  await supervisor.switchProfile("new", { graceMs: 120_000 });
  assert.deepEqual(calls, ["drain-old", "abort-old", "stop-old", "start-new", "probe-new"]);
  assert.equal(state.activeProfileId, "new");
  assert.equal(supervisor.snapshot().phase, "running");
  assert.equal(supervisor.snapshot().switchTransaction.phase, "completed");
  const journal = JSON.parse(fs.readFileSync(path.join(supervisor.stateDir, "runtime-switch.json"), "utf8"));
  assert.equal(journal.transaction.phase, "completed");
  assert.equal(journal.transaction.newProfileId, "new");
});

test("reactivating the active External OpenCode profile still forces a live restart and probe", async (t) => {
  const profile = verifiedProfile("external", "opencode", { ownershipMode: "external" });
  const supervisor = createSupervisor(t, { profiles: [profile], activeProfileId: profile.id });
  supervisor.desiredState = "running";
  supervisor.phase = "running";
  const calls = [];
  supervisor.bridgeClient = { async drain() { calls.push("drain"); return { activeTurns: 0 }; } };
  supervisor.stopProfileRuntime = async () => calls.push("stop");
  supervisor.startProfileRuntime = async () => calls.push("start");
  supervisor.probeProfile = async () => calls.push("live-probe");

  await supervisor.switchProfile(profile.id);
  assert.deepEqual(calls, ["drain", "stop", "start", "live-probe"]);
});

test("failed new runtime restores selection, restarts and probes old runtime", async (t) => {
  const oldProfile = verifiedProfile("old", "builtin-api");
  const newProfile = verifiedProfile("new", "codex");
  const state = { profiles: [oldProfile, newProfile], activeProfileId: oldProfile.id };
  const supervisor = createSupervisor(t, state);
  supervisor.desiredState = "running";
  supervisor.phase = "running";
  const calls = [];
  supervisor.bridgeClient = {
    async drain() { calls.push("drain-old"); return { activeTurns: 0 }; },
  };
  supervisor.stopProfileRuntime = async (profile) => calls.push(`stop-${profile.id}`);
  supervisor.startProfileRuntime = async (profile) => {
    calls.push(`start-${profile.id}`);
    if (profile.id === "new") throw Object.assign(new Error("new failed"), { code: "NEW_FAILED" });
  };
  supervisor.probeProfile = async (profile) => calls.push(`probe-${profile.id}`);

  await assert.rejects(supervisor.switchProfile("new", { graceMs: 120_000 }), (error) => error.code === "NEW_FAILED");
  assert.deepEqual(calls, ["drain-old", "stop-old", "start-new", "stop-new", "start-old", "probe-old"]);
  assert.equal(state.activeProfileId, "old");
  assert.equal(supervisor.snapshot().phase, "running");
  assert.equal(supervisor.snapshot().switchTransaction.phase, "rolled_back");
});

test("rollback failure stays observable in Error and never reports either runtime healthy", async (t) => {
  const oldProfile = verifiedProfile("old", "builtin-api");
  const newProfile = verifiedProfile("new", "codex");
  const state = { profiles: [oldProfile, newProfile], activeProfileId: oldProfile.id };
  const supervisor = createSupervisor(t, state);
  supervisor.desiredState = "running";
  supervisor.phase = "running";
  supervisor.bridgeClient = { async drain() { return { activeTurns: 0 }; } };
  supervisor.stopProfileRuntime = async () => {};
  supervisor.startProfileRuntime = async (profile) => {
    throw Object.assign(new Error(`${profile.id} failed`), { code: `${profile.id.toUpperCase()}_FAILED` });
  };

  await assert.rejects(supervisor.switchProfile("new"), (error) => error.code === "SWITCH_ROLLBACK_FAILED");
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.phase, "error");
  assert.equal(snapshot.switchTransaction.phase, "rollback_failed");
  assert.equal(snapshot.activeProfileId, "");
  assert.equal(snapshot.error.code, "SWITCH_ROLLBACK_FAILED");
});

test("candidate must carry a current live-verification fingerprint before drain", async (t) => {
  const oldProfile = verifiedProfile("old", "builtin-api");
  const stale = { ...verifiedProfile("new", "builtin-api"), modelId: "changed-after-verification" };
  const supervisor = createSupervisor(t, { profiles: [oldProfile, stale], activeProfileId: oldProfile.id });
  let drained = false;
  supervisor.bridgeClient = { async drain() { drained = true; return { activeTurns: 0 }; } };

  await assert.rejects(supervisor.switchProfile("new"), (error) => error.code === "PROFILE_NOT_VERIFIED");
  assert.equal(drained, false);
});

test("health probe binds runtime, model, credential generation, and External OpenCode live catalog", async (t) => {
  const profile = verifiedProfile("external", "opencode", { ownershipMode: "external", secretGeneration: 7 });
  const supervisor = createSupervisor(t, { profiles: [profile], activeProfileId: profile.id });
  supervisor.bridgeClient = {
    async health() {
      return {
        runtimeReady: true,
        activeProfileId: profile.id,
        runtimeId: profile.runtimeId,
        modelId: profile.modelId,
        secretGeneration: profile.secretGeneration,
        catalogLive: false,
      };
    },
  };
  await assert.rejects(supervisor.probeProfile(profile), (error) => error.code === "OPENCODE_LIVE_CATALOG_REQUIRED");

  supervisor.bridgeClient.health = async () => ({
    runtimeReady: true,
    activeProfileId: profile.id,
    runtimeId: profile.runtimeId,
    modelId: profile.modelId,
    secretGeneration: profile.secretGeneration,
    catalogLive: true,
  });
  await supervisor.probeProfile(profile);
});

function createSupervisor(t, state) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-switch-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const profileStore = {
    get(id) { return state.profiles.find((profile) => profile.id === id) || null; },
    getActive() { return this.get(state.activeProfileId); },
    activate(id) {
      const profile = this.get(id);
      if (!profile) throw Object.assign(new Error("missing profile"), { code: "PROFILE_NOT_FOUND" });
      if (profile.status !== "verified" || profile.verifiedFingerprint !== computeVerificationFingerprint(profile)) {
        throw Object.assign(new Error("not verified"), { code: "PROFILE_NOT_VERIFIED" });
      }
      state.activeProfileId = id;
      return profile;
    },
  };
  return new RuntimeSupervisor({ rootDir: path.resolve(__dirname, ".."), stateDir, profileStore, env: {} });
}

function verifiedProfile(id, runtimeId, overrides = {}) {
  const profile = {
    id,
    name: id,
    runtimeId,
    ownershipMode: "",
    providerId: runtimeId === "builtin-api" ? "openai" : "compatibility",
    protocolId: runtimeId === "builtin-api" ? "openai" : "",
    baseUrl: "http://127.0.0.1:1234",
    options: {},
    modelId: `${id}-model`,
    modelVariant: "",
    visionProfileId: "",
    secretRefs: { apiKey: "", servicePassword: "", sensitiveHeaders: {} },
    secretGeneration: 0,
    status: "verified",
    verifiedFingerprint: "",
    capabilities: { streaming: true, tools: true, cancellation: true },
    verificationError: "",
    catalogMetadata: {},
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    verifiedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
  profile.verifiedFingerprint = computeVerificationFingerprint(profile);
  return profile;
}
