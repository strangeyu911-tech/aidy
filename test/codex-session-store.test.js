const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SessionStore,
  migrateLegacyBinding,
} = require("../src/adapters/runtime/codex/session-store");
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

function runtimeScope(overrides = {}) {
  return {
    runtimeId: "codex",
    profileId: "codex-profile",
    modelId: "gpt-5",
    secretGeneration: 4,
    ...overrides,
  };
}

function compatibilityProfile(overrides = {}) {
  return {
    id: "codex-profile",
    runtimeId: "codex",
    providerId: "openai",
    modelId: "gpt-5",
    secretGeneration: 4,
    status: "verified",
    ...overrides,
  };
}

function legacyBinding(overrides = {}) {
  return {
    bindingKey: "binding-1",
    activeWorkspaceRoot: "/workspace",
    threadIdByWorkspaceRoot: { "/workspace": "legacy-thread" },
    codexParamsByWorkspaceRoot: {
      "/workspace": { model: "gpt-5", modelProvider: "openai" },
    },
    ...overrides,
  };
}

test("exact-scope lookup never reuses a thread across model, profile, runtime, or credential generation", () => {
  const filePath = createTempFile("sessions.json");
  const store = new SessionStore({ filePath, runtimeId: "codex" });
  const scope = runtimeScope();
  store.setThreadIdForScope("binding-1", "/workspace", scope, "scoped-thread");

  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", scope), "scoped-thread");
  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", { ...scope, runtimeId: "claudecode" }), "");
  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", { ...scope, profileId: "other" }), "");
  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", { ...scope, modelId: "gpt-5-mini" }), "");
  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", { ...scope, secretGeneration: 5 }), "");

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const record = Object.values(persisted.bindings["binding-1"].threadScopes)[0];
  assert.deepEqual(record.scope, scope);
  assert.deepEqual(record.threadIdByWorkspaceRoot, { "/workspace": "scoped-thread" });
});

test("ambiguous or unactivated legacy sessions stay read-only and request a fresh scoped session", () => {
  const noActive = migrateLegacyBinding(legacyBinding(), [compatibilityProfile()]);
  assert.equal(noActive.scopedThreadId, "");
  assert.equal(noActive.startFreshScopedSession, true);
  assert.deepEqual(noActive.legacySessions[0], {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    threadId: "legacy-thread",
    runtimeId: "codex",
    readOnly: true,
    resumable: false,
    reason: "legacy_scope_ambiguous",
    label: "旧版兼容会话（只读）",
    explanation: "无法确认原始运行时、档案和模型身份；后续交互将在新的 scoped 会话中继续。",
  });

  const ambiguous = migrateLegacyBinding(legacyBinding(), [
    compatibilityProfile({ id: "p1", active: true }),
    compatibilityProfile({ id: "p2", active: true }),
  ]);
  assert.equal(ambiguous.scopedThreadId, "");
});

test("legacy migration binds only one verified explicitly active compatible profile", () => {
  const binding = legacyBinding();
  const migrated = migrateLegacyBinding(binding, [
    compatibilityProfile(),
    compatibilityProfile({ id: "other", runtimeId: "builtin-api" }),
  ], { activeProfileId: "codex-profile" });

  assert.equal(migrated.scopedThreadId, "legacy-thread");
  assert.deepEqual(migrated.scope, runtimeScope());
  assert.deepEqual(migrated.legacySessions, []);

  for (const mismatched of [
    compatibilityProfile({ modelId: "gpt-5-mini" }),
    compatibilityProfile({ providerId: "azure" }),
    compatibilityProfile({ status: "unverified" }),
    compatibilityProfile({ runtimeId: "builtin-api" }),
    compatibilityProfile({ runtimeId: "opencode" }),
  ]) {
    const result = migrateLegacyBinding(binding, [mismatched], { activeProfileId: mismatched.id });
    assert.equal(result.scopedThreadId, "");
    assert.equal(result.legacySessions[0].readOnly, true);
  }
});

test("session store migrates compatible legacy history without deleting it or defaulting to Codex", () => {
  const filePath = createTempFile("sessions.json");
  fs.writeFileSync(filePath, JSON.stringify({
    bindings: {
      "binding-1": legacyBinding({ bindingKey: undefined }),
    },
  }, null, 2));
  const store = new SessionStore({ filePath, runtimeId: "" });

  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", runtimeScope()), "");
  assert.equal(store.listLegacyReadOnlySessions().length, 1);
  const results = store.migrateLegacyBindings([compatibilityProfile()], { activeProfileId: "codex-profile" });
  assert.equal(results[0].scopedThreadId, "legacy-thread");
  assert.equal(store.getThreadIdForScope("binding-1", "/workspace", runtimeScope()), "legacy-thread");
  assert.deepEqual(store.listLegacyReadOnlySessions(), []);

  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.bindings["binding-1"].threadIdByWorkspaceRoot["/workspace"], "legacy-thread");
  const reopened = new SessionStore({ filePath, runtimeId: "" });
  assert.equal(reopened.getThreadIdForScope("binding-1", "/workspace", runtimeScope()), "legacy-thread");
});

test("legacy Claude Code sessions remain readable and bind only to an explicit Claude Code profile", () => {
  const binding = legacyBinding({
    legacyRuntimeId: "claudecode",
    codexParamsByWorkspaceRoot: undefined,
  });
  const profile = compatibilityProfile({
    id: "claude-profile",
    runtimeId: "claudecode",
    providerId: "",
    modelId: "claude-sonnet-4-5",
    secretGeneration: 0,
  });
  const migrated = migrateLegacyBinding(binding, [profile], { activeProfileId: profile.id });
  assert.equal(migrated.scopedThreadId, "legacy-thread");
  assert.deepEqual(migrated.scope, {
    runtimeId: "claudecode",
    profileId: "claude-profile",
    modelId: "claude-sonnet-4-5",
    secretGeneration: 0,
  });

  const wrongRuntime = migrateLegacyBinding(binding, [
    compatibilityProfile({ id: "codex-profile", active: true }),
  ]);
  assert.equal(wrongRuntime.scopedThreadId, "");
  assert.equal(wrongRuntime.legacySessions[0].runtimeId, "claudecode");
});

test("legacy sessions without provable runtime metadata never default to Codex", () => {
  const unknown = legacyBinding({
    codexParamsByWorkspaceRoot: undefined,
    runtimeParamsByWorkspaceRootByRuntime: undefined,
    legacyRuntimeId: undefined,
    runtimeId: undefined,
  });
  const migrated = migrateLegacyBinding(unknown, [compatibilityProfile()], {
    activeProfileId: "codex-profile",
  });
  assert.equal(migrated.scopedThreadId, "");
  assert.equal(migrated.legacySessions[0].runtimeId, "");
  assert.equal(migrated.legacySessions[0].readOnly, true);
});
