"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createModelSettingsCoachState,
  resolveModelCoachPosition,
  transitionModelSettingsCoach,
} = require("../src/desktop/renderer/model-settings-coach-state");

const configurationState = Object.freeze({
  activeProfileId: "active-profile",
  profiles: Object.freeze([{ id: "active-profile", status: "verified" }]),
  editorMode: "edit",
  editorProfileId: "active-profile",
});

test("showing the coach mark changes only coach state and cannot create a profile", () => {
  const coach = transitionModelSettingsCoach(createModelSettingsCoachState(), { type: "start" });

  assert.deepEqual(coach, { status: "active", step: 1 });
  assert.deepEqual(configurationState.profiles, [{ id: "active-profile", status: "verified" }]);
  assert.equal(configurationState.activeProfileId, "active-profile");
});

test("skipping coach marks does not change editor or active configuration state", () => {
  const active = transitionModelSettingsCoach(createModelSettingsCoachState(), { type: "start" });
  const skipped = transitionModelSettingsCoach(active, { type: "skip" });

  assert.deepEqual(skipped, { status: "skipped", step: 0 });
  assert.equal(configurationState.editorMode, "edit");
  assert.equal(configurationState.editorProfileId, "active-profile");
  assert.equal(configurationState.activeProfileId, "active-profile");
});

test("the two coach steps finish without entering create or edit state", () => {
  const first = transitionModelSettingsCoach(createModelSettingsCoachState(), { type: "start" });
  const second = transitionModelSettingsCoach(first, { type: "next" });
  const completed = transitionModelSettingsCoach(second, { type: "next" });

  assert.deepEqual(first, { status: "active", step: 1 });
  assert.deepEqual(second, { status: "active", step: 2 });
  assert.deepEqual(completed, { status: "completed", step: 0 });
  assert.equal(configurationState.editorMode, "edit");
  assert.equal(configurationState.editorProfileId, "active-profile");
});

test("a completed coach does not restart automatically", () => {
  const completed = createModelSettingsCoachState({ completed: true });
  assert.deepEqual(transitionModelSettingsCoach(completed, { type: "start" }), completed);
});

test("coach placement stays below a target when the viewport has room", () => {
  assert.deepEqual(resolveModelCoachPosition({
    targetRect: { left: 700, top: 80, bottom: 120, width: 120 },
    viewportWidth: 1120,
    viewportHeight: 760,
    coachWidth: 340,
    coachHeight: 150,
  }), {
    above: false,
    left: 590,
    top: 135,
    arrowLeft: 170,
  });
});

test("coach placement moves above a low target and clamps horizontal overflow", () => {
  assert.deepEqual(resolveModelCoachPosition({
    targetRect: { left: 1040, top: 680, bottom: 720, width: 64 },
    viewportWidth: 1120,
    viewportHeight: 760,
    coachWidth: 340,
    coachHeight: 150,
  }), {
    above: true,
    left: 764,
    top: 515,
    arrowLeft: 308,
  });
});
