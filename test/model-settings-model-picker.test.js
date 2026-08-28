"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CODEBUDDY_MODEL,
  buildCodeBuddyModelOptions,
} = require("../src/desktop/renderer/model-settings-model-picker");

test("WorkBuddy always exposes Auto with the real id auto", () => {
  const options = buildCodeBuddyModelOptions([]);

  assert.deepEqual(options[0], DEFAULT_CODEBUDDY_MODEL);
  assert.equal(options[0].id, "auto");
  assert.equal(options[0].label, "Auto");
});

test("model labels are display-only and do not replace real ids", () => {
  const options = buildCodeBuddyModelOptions([{ id: "hy4", name: "Hy4 preview" }]);
  const selected = options.find((model) => model.label === "Hy4 preview");

  assert.equal(selected.id, "hy4");
  assert.notEqual(selected.id, selected.label);
});

test("empty and changed live catalogs preserve the current selection without activating it", () => {
  const old = buildCodeBuddyModelOptions([{ id: "hy4", name: "Hy4 preview" }], "hy4");
  const refreshed = buildCodeBuddyModelOptions([{ id: "glm-5", name: "GLM 5" }], "hy4");

  assert.equal(old.find((model) => model.id === "hy4").label, "Hy4 preview");
  assert.equal(refreshed.find((model) => model.id === "hy4").label, "hy4（当前配置，目录未返回）");
  assert.equal(buildCodeBuddyModelOptions([], "hy4").find((model) => model.id === "hy4").id, "hy4");
});
