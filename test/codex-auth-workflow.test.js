const test = require("node:test");
const assert = require("node:assert/strict");
const { runCodexAuthWorkflow } = require("../src/diagnostics/codex-auth/workflow");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

function baseConfig() {
  return {
    ok: true,
    command: "C:\\codex.exe",
    codexHome: "C:\\dedicated",
    defaultCodexHome: "C:\\Users\\me\\.codex",
    usesDedicatedCodexHome: true,
    stateDir: "C:\\state",
    pidFile: "C:\\state\\logs\\shared-app-server.pid",
    logFile: "C:\\state\\logs\\shared-app-server.log",
    loginLogFile: "C:\\dedicated\\log\\codex-login.log",
    port: 8765,
    listenUrl: "ws://127.0.0.1:8765",
    cwd: "C:\\work",
  };
}

function credentials(ok = true) {
  return ok
    ? { ok: true, credentialFileExists: true, credentialFileReopened: true, cliAuthMode: "chatgpt", loginLogState: "missing" }
    : { ok: false, code: RESULT_CODES.AUTH_MISSING, credentialFileExists: false, credentialFileReopened: false, cliAuthMode: "none" };
}

function processState() {
  return {
    ok: true,
    listenerPid: 100,
    pidFilePid: 100,
    pidFileState: "match",
    appServerIdentityVerified: true,
    readyz: true,
  };
}

test("Diagnose-only performs no login, restart or model probe", async () => {
  let loginCalls = 0;
  let probeCalls = 0;
  let restartCalls = 0;
  const result = await runCodexAuthWorkflow({ diagnoseOnly: true, port: 8765 }, {
    platform: "win32",
    configResolver: baseConfig,
    credentialDiagnoser: () => credentials(true),
    deviceLogin: async () => { loginCalls += 1; },
    probe: async () => { probeCalls += 1; },
    platformAdapter: {
      inspect: async () => processState(),
      restart: async () => { restartCalls += 1; },
    },
  });
  assert.equal(result.result, RESULT_CODES.DIAGNOSIS_COMPLETE);
  assert.equal(result.probeVerified, false);
  assert.deepEqual({ loginCalls, probeCalls, restartCalls }, { loginCalls: 0, probeCalls: 0, restartCalls: 0 });
});

test("Workflow logs into the dedicated profile and starts a missing App Server", async () => {
  let diagnosisCount = 0;
  let startCalls = 0;
  const result = await runCodexAuthWorkflow({ port: 8765 }, {
    platform: "win32",
    configResolver: baseConfig,
    credentialDiagnoser: () => credentials(++diagnosisCount > 1),
    deviceLogin: async (_config, dependencies) => ({
      ok: (await dependencies.verifyCredentials()).ok,
      deviceLoginCompleted: true,
    }),
    platformAdapter: {
      inspect: async () => ({ ok: false, code: RESULT_CODES.APP_SERVER_NOT_RUNNING, listenerPid: 0, pidFileState: "stale" }),
      start: async () => { startCalls += 1; return { ...processState(), started: true }; },
    },
    probe: async () => ({ ok: true, modelCount: 2, turnStatus: "completed", replyMatched: true }),
  });
  assert.equal(result.result, RESULT_CODES.REPAIR_SUCCEEDED);
  assert.equal(result.appServerStarted, true);
  assert.equal(startCalls, 1);
});

test("Workflow restarts only a verified App Server after a 401 and probes once more", async () => {
  let probeCalls = 0;
  let restartCalls = 0;
  const result = await runCodexAuthWorkflow({ port: 8765 }, {
    platform: "win32",
    configResolver: baseConfig,
    credentialDiagnoser: () => credentials(true),
    platformAdapter: {
      inspect: async () => processState(),
      restart: async () => { restartCalls += 1; return { ...processState(), restarted: true }; },
    },
    probe: async () => {
      probeCalls += 1;
      return probeCalls === 1
        ? { ok: false, code: RESULT_CODES.APP_SERVER_UNAUTHORIZED, turnStatus: "failed" }
        : { ok: true, modelCount: 3, turnStatus: "completed", replyMatched: true };
    },
  });
  assert.equal(result.result, RESULT_CODES.REPAIR_SUCCEEDED);
  assert.equal(result.appServerRestarted, true);
  assert.deepEqual({ probeCalls, restartCalls }, { probeCalls: 2, restartCalls: 1 });
});

test("Workflow refuses to stop an unverified listener after a 401", async () => {
  let restartCalls = 0;
  const unverified = { ...processState(), ok: false, code: RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED, appServerIdentityVerified: false };
  const result = await runCodexAuthWorkflow({ port: 8765 }, {
    platform: "win32",
    configResolver: baseConfig,
    credentialDiagnoser: () => credentials(true),
    platformAdapter: {
      inspect: async () => unverified,
      restart: async () => { restartCalls += 1; },
    },
    probe: async () => ({ ok: false, code: RESULT_CODES.APP_SERVER_UNAUTHORIZED, turnStatus: "failed" }),
  });
  assert.equal(result.result, RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED);
  assert.equal(restartCalls, 0);
});
