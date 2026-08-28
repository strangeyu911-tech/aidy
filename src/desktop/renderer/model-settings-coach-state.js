"use strict";

(function exposeModelSettingsCoachState(global) {
  const STEP_COUNT = 2;

  function createModelSettingsCoachState({ completed = false } = {}) {
    return {
      status: completed ? "completed" : "idle",
      step: 0,
    };
  }

  function transitionModelSettingsCoach(state = createModelSettingsCoachState(), action = {}) {
    switch (action.type) {
      case "start":
        return state.status === "idle" ? { status: "active", step: 1 } : { ...state };
      case "next":
        if (state.status !== "active") return { ...state };
        return state.step < STEP_COUNT
          ? { status: "active", step: state.step + 1 }
          : { status: "completed", step: 0 };
      case "skip":
        return state.status === "active" ? { status: "skipped", step: 0 } : { ...state };
      default:
        return { ...state };
    }
  }

  function resolveModelCoachPosition({
    targetRect,
    viewportWidth,
    viewportHeight,
    coachWidth,
    coachHeight,
    padding = 16,
    gap = 15,
  } = {}) {
    const belowTop = targetRect.bottom + gap;
    const aboveTop = targetRect.top - coachHeight - gap;
    const above = belowTop + coachHeight > viewportHeight - padding && aboveTop >= padding;
    const left = Math.max(padding, Math.min(
      viewportWidth - coachWidth - padding,
      targetRect.left + (targetRect.width - coachWidth) / 2,
    ));
    const unclampedTop = above ? aboveTop : Math.min(viewportHeight - coachHeight - padding, belowTop);
    const arrowLeft = Math.max(20, Math.min(
      coachWidth - 20,
      targetRect.left + targetRect.width / 2 - left,
    ));
    return {
      above,
      left,
      top: Math.max(padding, unclampedTop),
      arrowLeft,
    };
  }

  const api = {
    STEP_COUNT,
    createModelSettingsCoachState,
    resolveModelCoachPosition,
    transitionModelSettingsCoach,
  };
  global.cyberbossModelSettingsCoachState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
