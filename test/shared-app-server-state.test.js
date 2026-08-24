const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyWindowsAppServerInspection } = require("../scripts/shared-common");

test("Shared App Server state repairs only a verified stale PID mapping", () => {
  assert.deepEqual(classifyWindowsAppServerInspection({
    listenerPid: 20468,
    pidFilePid: 111,
    appServerIdentityVerified: true,
  }), {
    status: "already_running_pid_repaired",
    identityVerified: true,
  });
});

test("Shared App Server state never treats an unknown listener identity as verified", () => {
  assert.deepEqual(classifyWindowsAppServerInspection({
    listenerPid: 20468,
    pidFilePid: 20468,
    appServerIdentityVerified: false,
  }), {
    status: "already_running_unknown_identity",
    identityVerified: false,
  });
});
