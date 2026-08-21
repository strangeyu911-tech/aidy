const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
const { CyberbossApp } = require("../src/core/app");
const { normalizeWorkspaceRoot } = require("../src/core/workspace-path");

function createTempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-session-test-"));
  return path.join(dir, name);
}

test("Windows workspace path variants resolve to one canonical Codex thread", () => {
  const filePath = createTempFile("sessions.json");
  const bindingKey = "default:account:user";
  fs.writeFileSync(filePath, JSON.stringify({
    bindings: {
      [bindingKey]: {
        activeWorkspaceRoot: "D:\\CyberBoss",
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "D:/CyberBoss": "old-thread",
            "D:\\CyberBoss": "current-thread",
          },
        },
        runtimeParamsByWorkspaceRootByRuntime: {
          codex: {
            "D:/CyberBoss": { model: "old-model" },
            "D:\\CyberBoss": { model: "current-model" },
          },
        },
      },
    },
  }, null, 2));

  const store = new SessionStore({ filePath, runtimeId: "codex" });
  assert.equal(normalizeWorkspaceRoot("D:/CyberBoss"), "D:\\CyberBoss");
  assert.equal(store.getThreadIdForWorkspace(bindingKey, "D:/CyberBoss"), "current-thread");
  assert.equal(store.getThreadIdForWorkspace(bindingKey, "D:\\CyberBoss"), "current-thread");
  assert.deepEqual(store.getRuntimeParamsForWorkspace(bindingKey, "D:/CyberBoss"), {
    model: "current-model",
    modelProvider: "",
  });

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const threadMap = persisted.bindings[bindingKey].threadIdByWorkspaceRootByRuntime.codex;
  assert.deepEqual(threadMap, { "D:\\CyberBoss": "current-thread" });
});

test("pending check-in stays queued when a user message arrived in the cycle", async () => {
  const checkin = { id: "checkin:one" };
  const reminder = { id: "reminder:one" };
  const requeued = [];
  const dispatched = [];
  const appLike = {
    systemMessageDispatcher: {
      drainPending() {
        return [checkin, reminder];
      },
      requeue(message) {
        requeued.push(message);
      },
    },
    async dispatchSystemMessage(message) {
      dispatched.push(message);
      return true;
    },
  };

  await CyberbossApp.prototype.flushPendingSystemMessages.call(appLike, { skipCheckin: true });

  assert.deepEqual(requeued, [checkin]);
  assert.deepEqual(dispatched, [reminder]);
});
