"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { CyberbossApp } = require("../src/core/app");
const { BridgeControlServer } = require("../src/core/bridge-control-server");
const { BridgeControlClient } = require("../src/desktop/bridge-control-client");

test("bridge control authenticates loopback health, drain, and abort", async (t) => {
  const calls = [];
  const app = {
    getBridgeControlStatus: () => ({ draining: false, activeTurns: 1, nonInterruptibleBoundary: false }),
    async drainForSwitch(input) { calls.push(["drain", input]); return { draining: true, activeTurns: 1, nonInterruptibleBoundary: false }; },
    async abortActiveTurns(reason) { calls.push(["abort", reason]); return { draining: true, activeTurns: 0, nonInterruptibleBoundary: false }; },
  };
  const server = new BridgeControlServer({ app, token: "test-token", port: 0 });
  await server.start();
  t.after(() => server.close());
  const client = new BridgeControlClient({ port: server.address().port, token: "test-token" });

  assert.deepEqual(await client.health(), {
    draining: false,
    activeTurns: 1,
    nonInterruptibleBoundary: false,
  });
  assert.equal((await client.drain({ deadlineAt: "2026-08-25T00:02:00.000Z" })).draining, true);
  assert.equal((await client.abort("runtime profile switch grace expired")).activeTurns, 0);
  assert.deepEqual(calls, [
    ["drain", { deadlineAt: "2026-08-25T00:02:00.000Z" }],
    ["abort", "runtime profile switch grace expired"],
  ]);
});

test("bridge control rejects missing credentials, unknown actions, and oversized bodies", async (t) => {
  const server = new BridgeControlServer({
    app: { getBridgeControlStatus: () => ({}) },
    token: "test-token",
    port: 0,
    maxBodyBytes: 32,
  });
  await server.start();
  t.after(() => server.close());
  const port = server.address().port;

  assert.equal((await request({ port, path: "/health" })).statusCode, 401);
  assert.equal((await request({ port, path: "/resume", token: "test-token", method: "POST" })).statusCode, 404);
  assert.equal((await request({
    port,
    path: "/drain",
    token: "test-token",
    method: "POST",
    body: JSON.stringify({ padding: "x".repeat(64) }),
  })).statusCode, 413);
});

test("drain waits for an active long tool turn and abort acknowledges cancellation", async () => {
  let cancelled = false;
  const app = Object.create(CyberbossApp.prototype);
  app.drainingForSwitch = false;
  app.nonInterruptibleBoundaryCount = 0;
  app.activeTurnRecords = new Map([["run-1", {
    threadId: "thread-1",
    turnId: "turn-1",
    workspaceRoot: "D:\\workspace",
    controller: new AbortController(),
  }]]);
  app.runtimeAdapter = {
    async cancelTurn() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cancelled = true;
      app.activeTurnRecords.clear();
    },
    getSessionStore() { return { clearApprovalPrompt() {} }; },
  };
  app.threadStateStore = { resolveApproval() {} };

  const drained = await app.drainForSwitch({ deadlineAt: new Date(Date.now() + 15).toISOString() });
  assert.equal(drained.activeTurns, 1);
  assert.equal(drained.deadlineExceeded, true);
  const aborted = await app.abortActiveTurns("switch timeout");
  assert.equal(cancelled, true);
  assert.equal(aborted.activeTurns, 0);
});

test("drain never crosses a declared non-interruptible safety boundary", async () => {
  const app = Object.create(CyberbossApp.prototype);
  app.drainingForSwitch = false;
  app.nonInterruptibleBoundaryCount = 1;
  app.activeTurnRecords = new Map([["run-1", { threadId: "thread-1", turnId: "turn-1" }]]);

  let settled = false;
  const pending = app.drainForSwitch({ deadlineAt: new Date(Date.now() - 1).toISOString() }).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  app.leaveNonInterruptibleBoundary();
  const result = await pending;
  assert.equal(result.deadlineExceeded, true);
  assert.equal(result.nonInterruptibleBoundary, false);
});

test("abort failure is not mistaken for cancellation acknowledgement", async () => {
  const app = Object.create(CyberbossApp.prototype);
  app.drainingForSwitch = true;
  app.nonInterruptibleBoundaryCount = 0;
  app.activeTurnRecords = new Map([["run-1", {
    id: "run-1",
    threadId: "thread-1",
    turnId: "turn-1",
    workspaceRoot: "D:\\workspace",
    controller: new AbortController(),
  }]]);
  app.runtimeAdapter = {
    async cancelTurn() { throw Object.assign(new Error("not acknowledged"), { code: "CANCEL_FAILED" }); },
    getSessionStore() { return { clearApprovalPrompt() {} }; },
  };
  app.threadStateStore = { resolveApproval() {} };
  app.turnGateStore = { releaseThread() {} };
  app.pendingOperationByRunKey = new Map();

  await assert.rejects(app.abortActiveTurns("switch timeout"), (error) => error.code === "CANCEL_FAILED");
  assert.equal(app.activeTurnRecords.size, 1);
});

function request({ port, path, method = "GET", token = "", body = "" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let responseBody = "";
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: responseBody }));
    });
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
