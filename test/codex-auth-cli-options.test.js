const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCliOptions } = require("../src/diagnostics/codex-auth/cli-options");

test("Codex auth CLI parses supported Windows options", () => {
  assert.deepEqual(parseCliOptions([
    "--diagnose-only",
    "--json",
    "--no-restart",
    "--port",
    "9876",
  ], { platform: "win32" }), {
    diagnoseOnly: true,
    json: true,
    noRestart: true,
    port: 9876,
  });
});

test("Codex auth CLI rejects unsafe or unsupported input", () => {
  assert.throws(() => parseCliOptions(["--port", "0"], { platform: "win32" }), /Invalid port/);
  assert.throws(() => parseCliOptions(["--force"], { platform: "win32" }), /Unknown option/);
  assert.throws(() => parseCliOptions([], { platform: "linux" }), /not supported/);
});
