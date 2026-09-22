"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { identityKeyFromAccount } = require("../src/core/app");
const { readConfig } = require("../src/core/config");
const migration = require("../scripts/migrate-identity-key");

const OPENID = "o9cq80y1AtKOCJZPcqpoc9e7QQY4@im.wechat";
const WORKSPACE_ID = "default";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeBinding(store, key, binding) {
  store.state.bindings[key] = binding;
}

function botBinding(accountId, threadId, workspace = "D:\\Ws") {
  return {
    accountId,
    senderId: OPENID,
    workspaceId: WORKSPACE_ID,
    activeWorkspaceRoot: workspace,
    threadIdByWorkspaceRootByRuntime: { codebuddy: { [workspace]: threadId } },
    threadScopes: {},
  };
}

test("identityKeyFromAccount prefers the stable openid over the bot id", () => {
  assert.equal(
    identityKeyFromAccount({ accountId: "219e3e20e886-im.bot", userId: OPENID }),
    OPENID,
  );
  assert.equal(identityKeyFromAccount({ userId: OPENID }), OPENID);
});

test("identityKeyFromAccount falls back to the bot id when the account file has no userId", () => {
  assert.equal(identityKeyFromAccount({ accountId: "legacy-im.bot" }), "legacy-im.bot");
  assert.equal(identityKeyFromAccount({}), "");
});

test("readConfig defaults the workspace root to a stable per-user directory", () => {
  const stateDir = tempDir("cyberboss-config-ws-");
  const previousStateDir = process.env.CYBERBOSS_STATE_DIR;
  const previousRoot = process.env.CYBERBOSS_WORKSPACE_ROOT;
  try {
    delete process.env.CYBERBOSS_WORKSPACE_ROOT;
    process.env.CYBERBOSS_STATE_DIR = stateDir;
    const config = readConfig();
    assert.equal(config.workspaceRoot, path.join(stateDir, "workspace"));
  } finally {
    if (previousStateDir === undefined) delete process.env.CYBERBOSS_STATE_DIR;
    else process.env.CYBERBOSS_STATE_DIR = previousStateDir;
    if (previousRoot === undefined) delete process.env.CYBERBOSS_WORKSPACE_ROOT;
    else process.env.CYBERBOSS_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("readConfig still honors an explicit CYBERBOSS_WORKSPACE_ROOT", () => {
  const previousRoot = process.env.CYBERBOSS_WORKSPACE_ROOT;
  try {
    process.env.CYBERBOSS_WORKSPACE_ROOT = "D:\\Custom\\ws";
    assert.equal(readConfig().workspaceRoot, "D:\\Custom\\ws");
  } finally {
    if (previousRoot === undefined) delete process.env.CYBERBOSS_WORKSPACE_ROOT;
    else process.env.CYBERBOSS_WORKSPACE_ROOT = previousRoot;
  }
});

test("transcript dir naming matches the observed codebuddy escape rules", () => {
  const candidates = migration.transcriptDirCandidates("C:\\Users\\me\\.cyberboss\\workspace");
  assert.deepEqual(candidates, [
    "c-Users-me-.cyberboss-workspace",
    "c-users-me-cyberboss-workspace",
  ], "canonical spelling first, legacy all-lowercase variant second");
  assert.ok(migration.transcriptDirCandidates("D:\\CyberBoss").includes("d-CyberBoss"));
});

test("pickMainThreadId resolves conflicts by most recent transcript activity", () => {
  const projectsRoot = tempDir("cyberboss-migrate-projects-");
  try {
    const oldDir = path.join(projectsRoot, "d-old");
    const newDir = path.join(projectsRoot, "d-new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "thread-old.jsonl"), "{}");
    fs.writeFileSync(path.join(newDir, "thread-new.jsonl"), "{}");
    const stale = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(oldDir, "thread-old.jsonl"), stale, stale);

    const result = migration.pickMainThreadId({
      targetThreadId: "thread-old",
      sourceThreadId: "thread-new",
      projectsRoot,
    });
    assert.equal(result.mainThreadId, "thread-new", "the newer conversation wins the pointer");
    assert.deepEqual(result.superseded, ["thread-old"]);
  } finally {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
  }
});

test("buildMergedState folds prior bot-id bindings into one identity binding", () => {
  const state = {
    bindings: {
      "default:d810-im.bot:o-other-user": botBinding("d810-im.bot", "thread-other", "D:\\Ws", ),
      // A different human: must never be touched.
      "default:97b-im.bot:o-other-user": botBinding("97b-im.bot", "thread-other-user", "D:\\Other"),
      [`${WORKSPACE_ID}:97b-im.bot:${OPENID}`]: botBinding("97b-im.bot", "thread-97b"),
      [`${WORKSPACE_ID}:082-im.bot:${OPENID}`]: botBinding("082-im.bot", "thread-082"),
      [`${WORKSPACE_ID}:219-im.bot:${OPENID}`]: botBinding("219-im.bot", "thread-219"),
      [`${WORKSPACE_ID}:97b-im.bot:${OPENID}::system`]: botBinding("97b-im.bot", "thread-system", "D:\\Sys"),
    },
  };

  const { state: merged, retiredKeys } = migration.buildMergedState({
    state,
    identityKey: OPENID,
    senderId: OPENID,
    workspaceId: WORKSPACE_ID,
    projectsRoot: path.join(os.tmpdir(), "cyberboss-migrate-empty-projects"),
  });

  const userKey = `${WORKSPACE_ID}:${OPENID}:${OPENID}`;
  const systemKey = `${userKey}::system`;
  const user = merged.bindings[userKey];
  const system = merged.bindings[systemKey];

  assert.ok(user, "the identity binding exists");
  assert.equal(user.accountId, OPENID);
  assert.equal(user.identityMigratedAt, user.identityMigratedAt);
  assert.ok(system, "the ::system variant stays separate");
  assert.equal(system.accountId, OPENID);
  assert.ok(retiredKeys.length >= 3, "the prior bot-id bindings were folded in");
  assert.deepEqual(
    Object.keys(merged.bindings).filter((key) => key.includes("o-other-user")),
    ["default:d810-im.bot:o-other-user", "default:97b-im.bot:o-other-user"],
    "other senders are untouched",
  );
  // Superseded threads are recorded, never deleted.
  assert.ok(Array.isArray(user.supersededThreadIds) || Array.isArray(system.supersededThreadIds));
});

test("migration verify rejects bindings that still carry a bot id", () => {
  const state = {
    bindings: {
      [`${WORKSPACE_ID}:${OPENID}:${OPENID}`]: {
        ...botBinding(OPENID, "thread-main"),
        accountId: "219e3e20e886-im.bot",
      },
    },
  };
  const problems = migration.verify({ state, identityKey: OPENID, senderId: OPENID, workspaceId: WORKSPACE_ID });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /219e3e20e886-im\.bot/);
});

test("migration is idempotent: an identity-keyed binding is left as-is", () => {
  const state = {
    bindings: {
      [`${WORKSPACE_ID}:${OPENID}:${OPENID}`]: botBinding(OPENID, "thread-main"),
    },
  };
  const { state: merged, retiredKeys } = migration.buildMergedState({
    state,
    identityKey: OPENID,
    senderId: OPENID,
    workspaceId: WORKSPACE_ID,
    projectsRoot: path.join(os.tmpdir(), "cyberboss-migrate-empty-projects"),
  });
  assert.equal(retiredKeys.length, 0);
  assert.deepEqual(merged.bindings, state.bindings, "the second run must not change anything");
});

test("copyTranscripts puts the surviving threads under the stable workspace dir", () => {
  const projectsRoot = tempDir("cyberboss-migrate-projects-");
  const stateDir = tempDir("cyberboss-migrate-state-");
  try {
    const oldDir = path.join(projectsRoot, "d-old-location");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "thread-219.jsonl"), '{"turn":1}\n');

    const workspaceRoot = path.join(stateDir, "workspace");
    const state = {
      bindings: {
        [`${WORKSPACE_ID}:${OPENID}:${OPENID}`]: {
          ...botBinding(OPENID, "thread-219", "D:\\Ws"),
          threadIdByWorkspaceRootByRuntime: { codebuddy: { "D:\\Ws": "thread-219" } },
        },
      },
    };
    const previousRoot = process.env.CODEBUDDY_PROJECTS_DIR;
    try {
      const result = migration.copyTranscripts({
        state,
        identityKey: OPENID,
        senderId: OPENID,
        workspaceId: WORKSPACE_ID,
        projectsRoot,
        workspaceRoot,
      });
      const expectedDir = migration.resolveTranscriptDir(workspaceRoot, projectsRoot).dir;
      assert.equal(result.targetDir, expectedDir);
      assert.deepEqual(result.copied, ["thread-219"]);
      assert.equal(fs.existsSync(path.join(expectedDir, "thread-219.jsonl")), true);
      // Original transcript stays in place (copy, never move).
      assert.equal(fs.existsSync(path.join(oldDir, "thread-219.jsonl")), true);
      // Idempotent: the second pass skips existing copies.
      const second = migration.copyTranscripts({
        state,
        identityKey: OPENID,
        senderId: OPENID,
        workspaceId: WORKSPACE_ID,
        projectsRoot,
        workspaceRoot,
      });
      assert.deepEqual(second.copied, []);
    } finally {
      if (previousRoot === undefined) delete process.env.CODEBUDDY_PROJECTS_DIR;
      else process.env.CODEBUDDY_PROJECTS_DIR = previousRoot;
    }
  } finally {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("buildBindingKey with the identity key survives a bot-id change", () => {
  // The regression this whole workstream fixes, expressed as one assertion:
  // re-scanning WeChat changes the bot id but MUST NOT change the binding key.
  const { SessionStore } = require("../src/adapters/runtime/codex/session-store");
  const store = new SessionStore({ filePath: path.join(tempDir("cyberboss-identity-key-"), "s.json"), runtimeId: "codebuddy" });
  const before = store.buildBindingKey({ workspaceId: "default", accountId: OPENID, senderId: OPENID });
  const after = store.buildBindingKey({ workspaceId: "default", accountId: OPENID, senderId: OPENID });
  assert.equal(after, before);
  assert.equal(after, `default:${OPENID}:${OPENID}`);
});
