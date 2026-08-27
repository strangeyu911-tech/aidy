"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatProfileTestFailure,
  resolveProfileCardState,
  resolveProfileEditorState,
} = require("../src/desktop/renderer/profile-editor-state");

const activeProfile = {
  id: "a",
  name: "我的 WorkBuddy",
  runtimeId: "codebuddy",
  modelId: "auto",
  status: "verified",
};

const draftProfile = {
  id: "b",
  name: "未命名配置",
  runtimeId: "codebuddy",
  modelId: "Deepseek v4 flash",
  status: "draft",
};

test("editing a failed draft binds the failure to draft B and leaves active A healthy", () => {
  const failure = {
    profileId: "b",
    modelId: draftProfile.modelId,
    isError: true,
    text: "draft failure",
  };
  const state = resolveProfileEditorState({
    profiles: [activeProfile, draftProfile],
    profileId: "b",
    activeProfileId: "a",
    testResult: failure,
  });

  assert.equal(state.name, "未命名配置");
  assert.equal(state.modelId, "Deepseek v4 flash");
  assert.equal(state.active, false);
  assert.equal(state.status, "测试失败");
  assert.equal(state.testResult, failure);

  const text = formatProfileTestFailure({
    profile: draftProfile,
    activeProfile,
    error: {
      code: "CODEBUDDY_MODEL_UNAVAILABLE",
      summary: "CodeBuddy 当前无法使用这个模型。",
      repairAction: "填写 CodeBuddy 中实际显示的模型 ID，再次测试。",
    },
  });
  assert.match(text, /未命名配置/);
  assert.match(text, /Deepseek v4 flash/);
  assert.match(text, /当前仍在使用“我的 WorkBuddy”/);
  assert.match(text, /不会影响它/);
  assert.doesNotMatch(text, /配置“我的 WorkBuddy”测试失败/);
});

test("switching back to active A restores A's own active and verified state", () => {
  const state = resolveProfileEditorState({
    profiles: [activeProfile, draftProfile],
    profileId: "a",
    activeProfileId: "a",
    testResult: {
      profileId: "b",
      modelId: draftProfile.modelId,
      isError: true,
      text: "draft failure",
    },
  });

  assert.equal(state.name, "我的 WorkBuddy");
  assert.equal(state.modelId, "auto");
  assert.equal(state.active, true);
  assert.equal(state.status, "当前使用 · 已验证");
  assert.equal(state.testResult, null);
});

test("a stored test result is ignored when the edited model has changed", () => {
  const state = resolveProfileEditorState({
    profiles: [{ ...draftProfile, modelId: "another-model" }],
    profileId: "b",
    activeProfileId: "a",
    testResult: {
      profileId: "b",
      modelId: draftProfile.modelId,
      isError: true,
      text: "stale failure",
    },
  });

  assert.equal(state.status, "草稿 · 需要测试");
  assert.equal(state.testResult, null);
});

test("does not read model details when no profile is selected", () => {
  const state = resolveProfileEditorState({
    profiles: [activeProfile, draftProfile],
    profileId: "",
    activeProfileId: "a",
    testResult: { isError: true },
  });

  assert.equal(state.profile, null);
  assert.equal(state.status, "草稿 · 需要测试");
});

test("active profile card is labeled 已激活 and disabled", () => {
  assert.deepEqual(resolveProfileCardState({ profile: activeProfile, activeProfileId: "a" }), {
    active: true,
    label: "已激活",
    disabled: true,
  });
});

test("verified inactive profile card remains an enabled 激活 action", () => {
  assert.deepEqual(resolveProfileCardState({ profile: { ...activeProfile, id: "b" }, activeProfileId: "a" }), {
    active: false,
    label: "激活",
    disabled: false,
  });
});

test("profile card states follow the real active profile when activation switches", () => {
  const profileA = { ...activeProfile, id: "a" };
  const profileB = { ...activeProfile, id: "b" };

  assert.equal(resolveProfileCardState({ profile: profileA, activeProfileId: "a" }).label, "已激活");
  assert.equal(resolveProfileCardState({ profile: profileB, activeProfileId: "a" }).label, "激活");
  assert.equal(resolveProfileCardState({ profile: profileA, activeProfileId: "b" }).label, "激活");
  assert.equal(resolveProfileCardState({ profile: profileB, activeProfileId: "b" }).label, "已激活");
});
