"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RUNTIME_IDS,
  getRuntimeDefinition,
  listRuntimeDefinitions,
} = require("../src/core/runtime-registry");

test("runtime registry exposes only the four approved runtime IDs", () => {
  assert.deepEqual(RUNTIME_IDS, ["builtin-api", "opencode", "codex", "claudecode"]);
  assert.deepEqual(
    listRuntimeDefinitions().map((definition) => definition.id),
    RUNTIME_IDS,
  );
  assert.equal(getRuntimeDefinition(" BUILTIN-API ").processKind, "none");
  assert.equal(getRuntimeDefinition("opencode").processKind, "opencode");
});

test("unknown runtime never falls back to codex", () => {
  assert.throws(() => getRuntimeDefinition(""), (error) => error.code === "INVALID_RUNTIME");
  assert.throws(() => getRuntimeDefinition("made-up"), (error) => error.code === "INVALID_RUNTIME");
  assert.equal(getRuntimeDefinition("builtin-api").id, "builtin-api");
});

test("runtime definitions and registry results are immutable", () => {
  const definitions = listRuntimeDefinitions();
  assert.equal(Object.isFrozen(RUNTIME_IDS), true);
  assert.equal(Object.isFrozen(definitions), true);
  assert.equal(Object.isFrozen(definitions[0]), true);
  assert.throws(() => definitions.push({ id: "made-up" }), TypeError);
});
