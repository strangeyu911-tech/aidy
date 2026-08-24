const test = require("node:test");
const assert = require("node:assert/strict");
const { formatHumanReport, isSuccessResult } = require("../scripts/codex-auth-repair");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

test("Human Codex auth report uses stable prefixes and a final result line", () => {
  const output = formatHumanReport({
    result: RESULT_CODES.REPAIR_SUCCEEDED,
    events: [
      { level: "PASS", message: "Credentials reopened" },
      { level: "STALE", message: "PID file mismatch" },
    ],
  });
  assert.equal(output, "[PASS] Credentials reopened\n[STALE] PID file mismatch\nRESULT=REPAIR_SUCCEEDED\n");
  assert.equal(isSuccessResult(RESULT_CODES.REPAIR_SUCCEEDED), true);
  assert.equal(isSuccessResult(RESULT_CODES.DIAGNOSIS_COMPLETE), true);
  assert.equal(isSuccessResult(RESULT_CODES.APP_SERVER_UNAUTHORIZED), false);
});
