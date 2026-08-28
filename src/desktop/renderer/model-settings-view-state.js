"use strict";

(function exposeModelSettingsViewState(global) {
  const INITIAL_STATE = Object.freeze({
    guideOpen: false,
    editorMode: "closed",
    editorProfileId: "",
  });

  function createModelSettingsViewState() {
    return { ...INITIAL_STATE };
  }

  function transitionModelSettingsView(state = INITIAL_STATE, action = {}) {
    switch (action.type) {
      case "open-guide":
        return { ...state, guideOpen: true };
      case "close-guide":
        return { ...state, guideOpen: false };
      case "create-config":
        return { ...state, editorMode: "create", editorProfileId: "" };
      case "edit-config":
        return { ...state, editorMode: "edit", editorProfileId: String(action.profileId || "") };
      case "close-editor":
        return { ...state, editorMode: "closed", editorProfileId: "" };
      default:
        return { ...state };
    }
  }

  const api = {
    createModelSettingsViewState,
    transitionModelSettingsView,
  };
  global.cyberbossModelSettingsViewState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
