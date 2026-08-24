const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { runDeviceLogin } = require("../src/diagnostics/codex-auth/device-login");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

test("Device login inherits the terminal and re-verifies credentials", async () => {
  let invocation = null;
  const child = new EventEmitter();
  child.kill = () => {};
  const promise = runDeviceLogin({
    command: "C:\\codex.exe",
    cwd: "C:\\work",
    codexHome: "C:\\dedicated",
  }, {
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    verifyCredentials: async () => ({ ok: true }),
  });
  const result = await promise;
  assert.equal(result.ok, true);
  assert.deepEqual(invocation.args, ["login", "--device-auth"]);
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.env.CODEX_HOME, "C:\\dedicated");
});

test("Device login does not trust a zero exit code when credentials cannot be reopened", async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const promise = runDeviceLogin({ command: "codex", cwd: ".", codexHome: "C:\\dedicated" }, {
    spawnImpl() {
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    verifyCredentials: async () => ({ ok: false, code: RESULT_CODES.AUTH_FILE_INVALID }),
  });
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.code, RESULT_CODES.AUTH_FILE_INVALID);
});

test("Device login maps a token exchange failure to the network result code", async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const promise = runDeviceLogin({ command: "codex", cwd: ".", codexHome: "C:\\dedicated" }, {
    spawnImpl() {
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    },
    verifyCredentials: async () => ({
      ok: false,
      loginLogState: "token_exchange_failed",
      loginLogModifiedAt: Date.now(),
    }),
  });
  const result = await promise;
  assert.equal(result.code, RESULT_CODES.AUTH_NETWORK_FAILED);
});

test("Device login does not map an old token exchange log to a current network failure", async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const promise = runDeviceLogin({ command: "codex", cwd: ".", codexHome: "C:\\dedicated" }, {
    spawnImpl() {
      queueMicrotask(() => child.emit("exit", 1));
      return child;
    },
    verifyCredentials: async () => ({
      ok: false,
      loginLogState: "token_exchange_failed",
      loginLogModifiedAt: Date.now() - 60_000,
    }),
  });
  const result = await promise;
  assert.equal(result.code, RESULT_CODES.DEVICE_AUTH_FAILED);
});
