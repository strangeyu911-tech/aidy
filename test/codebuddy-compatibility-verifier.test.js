"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyCodeBuddyTestOk } = require("../src/adapters/runtime/codebuddy");

test("compatibility verifier owns discovery, managed process, ACP TEST_OK, and cleanup", async () => {
  const calls = [];
  const processHost = {
    async start(input) {
      calls.push(["start", input]);
      return { endpoint: "http://127.0.0.1:44129", health: { ok: true, status: "ok" } };
    },
    async stop() { calls.push(["stop"]); },
  };
  const client = {
    async runTestOk(input) {
      calls.push(["test", input]);
      return {
        ok: true,
        text: "TEST_OK",
        modelId: "auto",
        serverVersion: "",
        identityFingerprint: "a".repeat(64),
        sessionId: "must-not-be-public",
      };
    },
    async disconnect() { calls.push(["disconnect"]); },
  };

  const result = await verifyCodeBuddyTestOk({
    config: { stateDir: "D:\\state", workspaceRoot: "D:\\CyberBoss" },
    profile: { runtimeId: "codebuddy", modelId: "auto", options: { executablePath: "C:\\CodeBuddy\\codebuddy.exe" } },
    secrets: { servicePassword: "gateway-secret" },
    locateDistribution: async (input) => {
      calls.push(["locate", input]);
      return { source: "standalone", sourceLabel: "CodeBuddy", version: "2.115.0", executablePath: "C:\\CodeBuddy\\codebuddy.exe", command: "codebuddy.exe", argsPrefix: [], shell: false };
    },
    processHostFactory: () => processHost,
    clientFactory: () => client,
  });

  assert.deepEqual(result, {
    ok: true,
    text: "TEST_OK",
    runtimeId: "codebuddy",
    source: "standalone",
    sourceLabel: "CodeBuddy",
    cliVersion: "2.115.0",
    modelId: "auto",
    identityFingerprint: "a".repeat(64),
    health: { ok: true, status: "ok" },
  });
  assert.equal(JSON.stringify(result).includes("session"), false);
  assert.equal(JSON.stringify(result).includes("gateway-secret"), false);
  assert.deepEqual(calls.map(([name]) => name), ["locate", "start", "test", "disconnect", "stop"]);
});

test("compatibility verifier always closes resources and rejects incomplete profiles", async () => {
  let stopped = 0;
  let disconnected = 0;
  await assert.rejects(verifyCodeBuddyTestOk({
    config: { stateDir: "D:\\state", workspaceRoot: "D:\\CyberBoss" },
    profile: { runtimeId: "codebuddy", modelId: "auto", options: {} },
    secrets: { servicePassword: "gateway-secret" },
    locateDistribution: async () => ({ source: "path", sourceLabel: "CodeBuddy", version: "2.115.0", executablePath: "codebuddy.exe", command: "codebuddy.exe", argsPrefix: [] }),
    processHostFactory: () => ({ async start() { return { endpoint: "http://127.0.0.1:1", health: { ok: true } }; }, async stop() { stopped += 1; } }),
    clientFactory: () => ({ async runTestOk() { throw Object.assign(new Error("failed"), { code: "CODEBUDDY_TURN_FAILED" }); }, async disconnect() { disconnected += 1; } }),
  }), (error) => error.code === "CODEBUDDY_TURN_FAILED");
  assert.equal(disconnected, 1);
  assert.equal(stopped, 1);

  await assert.rejects(verifyCodeBuddyTestOk({
    config: { stateDir: "D:\\state", workspaceRoot: "D:\\CyberBoss" },
    profile: { runtimeId: "codex", modelId: "auto" },
    secrets: { servicePassword: "gateway-secret" },
  }), (error) => error.code === "INVALID_PROFILE");
});
