"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createModelSettingsViewState,
  transitionModelSettingsView,
} = require("../src/desktop/renderer/model-settings-view-state");

test("opening the model guide does not create a config draft or enter the editor", () => {
  const initial = createModelSettingsViewState();
  const state = transitionModelSettingsView(initial, { type: "open-guide" });

  assert.deepEqual(state, {
    guideOpen: true,
    editorMode: "closed",
    editorProfileId: "",
  });
});

test("creating a config enters a new editor independently from the guide", () => {
  const initial = createModelSettingsViewState();
  const state = transitionModelSettingsView(initial, { type: "create-config" });

  assert.deepEqual(state, {
    guideOpen: false,
    editorMode: "create",
    editorProfileId: "",
  });
});

test("opening and closing the guide preserves an existing edit selection", () => {
  const editing = transitionModelSettingsView(createModelSettingsViewState(), {
    type: "edit-config",
    profileId: "active-profile",
  });
  const guideOpen = transitionModelSettingsView(editing, { type: "open-guide" });
  const guideClosed = transitionModelSettingsView(guideOpen, { type: "close-guide" });

  assert.deepEqual(guideClosed, editing);
  assert.equal(guideClosed.editorMode, "edit");
  assert.equal(guideClosed.editorProfileId, "active-profile");
});

test("closing the guide cannot change the active configuration data", () => {
  const configurationState = {
    activeProfileId: "active-profile",
    profiles: [{ id: "active-profile", status: "verified" }],
  };
  const guideOpen = transitionModelSettingsView(createModelSettingsViewState(), { type: "open-guide" });
  const guideClosed = transitionModelSettingsView(guideOpen, { type: "close-guide" });

  assert.equal(guideClosed.guideOpen, false);
  assert.equal(configurationState.activeProfileId, "active-profile");
  assert.deepEqual(configurationState.profiles, [{ id: "active-profile", status: "verified" }]);
});

test("closing the editor does not close the guide", () => {
  const editingWithGuide = {
    guideOpen: true,
    editorMode: "edit",
    editorProfileId: "draft-profile",
  };
  const state = transitionModelSettingsView(editingWithGuide, { type: "close-editor" });

  assert.deepEqual(state, {
    guideOpen: true,
    editorMode: "closed",
    editorProfileId: "",
  });
});
