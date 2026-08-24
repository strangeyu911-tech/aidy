const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveCodexConfig,
  inspectAuthFile,
  inspectLoginStatus,
  classifyLoginLog,
  diagnoseCredentials,
} = require("../src/diagnostics/codex-auth/diagnostics");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

test("Codex auth diagnostics distinguish a dedicated CODEX_HOME and reopen auth.json", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-auth-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const codexHome = path.join(tempDir, "dedicated");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const config = resolveCodexConfig({
    env: {
      CYBERBOSS_RUNTIME: "codex",
      CYBERBOSS_CODEX_COMMAND: "codex",
      CODEX_HOME: codexHome,
    },
    homedir: tempDir,
    cwd: tempDir,
  });

  assert.equal(config.usesDedicatedCodexHome, true);
  const inspected = inspectAuthFile(codexHome);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.credentialFileReopened, true);
  assert.ok(inspected.credentialFileBytes > 0);
  assert.equal(Object.hasOwn(inspected, "auth_mode"), false);
});

test("Codex auth diagnostics reject missing, empty and damaged credential files", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-auth-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  assert.equal(inspectAuthFile(tempDir).code, RESULT_CODES.AUTH_MISSING);
  fs.writeFileSync(path.join(tempDir, "auth.json"), "");
  assert.equal(inspectAuthFile(tempDir).code, RESULT_CODES.AUTH_FILE_INVALID);
  fs.writeFileSync(path.join(tempDir, "auth.json"), "{");
  assert.equal(inspectAuthFile(tempDir).code, RESULT_CODES.AUTH_FILE_INVALID);
});

test("Codex login status always uses the configured CODEX_HOME", () => {
  let invocation = null;
  const status = inspectLoginStatus({ command: "codex", cwd: "C:\\work", codexHome: "C:\\dedicated" }, {
    runCommand(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    },
  });
  assert.equal(status.ok, true);
  assert.equal(invocation.options.env.CODEX_HOME, "C:\\dedicated");
});

test("Codex login status reports a missing executable as CLI_NOT_FOUND", () => {
  const status = inspectLoginStatus({ command: "missing-codex", cwd: ".", codexHome: "C:\\dedicated" }, {
    runCommand: () => ({ status: null, stdout: "", stderr: "", error: { code: "ENOENT" } }),
  });
  assert.equal(status.code, RESULT_CODES.CLI_NOT_FOUND);
});

test("Codex login log classification separates callback success from token exchange failure", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-auth-log-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const logFile = path.join(tempDir, "codex-login.log");
  fs.writeFileSync(logFile, "callback received state_valid=true");
  assert.equal(classifyLoginLog(logFile).loginLogState, "callback_valid");
  fs.writeFileSync(logFile, "callback received state_valid=true OAuth token exchange failed");
  assert.equal(classifyLoginLog(logFile).loginLogState, "token_exchange_failed");
});

test("Combined credential diagnosis reports CLI status without exposing auth fields", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-auth-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tempDir, "auth.json"), JSON.stringify({ access_token: "must-not-leak" }));
  const result = diagnoseCredentials({
    command: "codex",
    codexHome: tempDir,
    cwd: tempDir,
    loginLogFile: path.join(tempDir, "missing.log"),
  }, {
    runCommand: () => ({ status: 1, stdout: "Not logged in", stderr: "" }),
  });
  assert.equal(result.code, RESULT_CODES.CLI_STATUS_UNAUTHENTICATED);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});
