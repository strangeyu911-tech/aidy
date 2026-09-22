"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWechatLoginRecovery } = require("../src/desktop/wechat-login-recovery");

function createSupervisor({ desiredState = "running", fail = false } = {}) {
  const retries = [];
  return {
    retries,
    desiredState,
    phase: "error",
    async retry() {
      retries.push("retry");
      if (fail) throw new Error("bridge spawn failed");
      this.phase = "starting";
    },
  };
}

test("a successful scan restarts the parked background exactly once", async () => {
  const supervisor = createSupervisor();
  const recovery = createWechatLoginRecovery({ supervisor });

  for (const status of ["starting", "waiting", "scanned", "confirmed", "connected"]) {
    await recovery.handleStatus(status);
  }
  // The runner flushes one more update from its `finally` block; it must not
  // become a second restart.
  await recovery.handleStatus("connected");

  assert.deepEqual(supervisor.retries, ["retry"]);
});

test("intermediate login states never touch the supervisor", async () => {
  const supervisor = createSupervisor();
  const recovery = createWechatLoginRecovery({ supervisor });

  for (const status of ["", "idle", "starting", "waiting", "scanned", "confirmed", undefined, null]) {
    await recovery.handleStatus(status);
  }

  assert.deepEqual(supervisor.retries, []);
});

test("a later scan re-arms the recovery", async () => {
  const supervisor = createSupervisor();
  const recovery = createWechatLoginRecovery({ supervisor });

  await recovery.handleStatus("connected");
  await recovery.handleStatus("waiting");
  await recovery.handleStatus("connected");

  assert.deepEqual(supervisor.retries, ["retry", "retry"]);
});

test("a user who explicitly stopped Aidy keeps that choice", async () => {
  const supervisor = createSupervisor({ desiredState: "stopped" });
  const recovery = createWechatLoginRecovery({ supervisor });

  const restarted = await recovery.handleStatus("connected");

  assert.equal(restarted, false);
  assert.deepEqual(supervisor.retries, []);
});

test("a failing retry is logged, not thrown into the login path", async () => {
  const supervisor = createSupervisor({ fail: true });
  const warnings = [];
  const recovery = createWechatLoginRecovery({
    supervisor,
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });

  const restarted = await recovery.handleStatus("connected");

  assert.equal(restarted, false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /wechat\.login_recovery_failed/);
});

test("reset re-arms the recovery for a fresh runner state", async () => {
  const supervisor = createSupervisor();
  const recovery = createWechatLoginRecovery({ supervisor });

  await recovery.handleStatus("connected");
  recovery.reset();
  await recovery.handleStatus("connected");

  assert.deepEqual(supervisor.retries, ["retry", "retry"]);
});
