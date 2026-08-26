"use strict";

const RUNTIME_IDS = Object.freeze(["builtin-api", "opencode", "codex", "claudecode", "codebuddy"]);

const RUNTIME_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "builtin-api", name: "Built-in API", processKind: "none" }),
  Object.freeze({ id: "opencode", name: "OpenCode", processKind: "opencode" }),
  Object.freeze({ id: "codex", name: "Codex", processKind: "codex" }),
  Object.freeze({ id: "claudecode", name: "Claude Code", processKind: "claudecode" }),
  Object.freeze({ id: "codebuddy", name: "CodeBuddy", processKind: "codebuddy" }),
]);

const DEFINITION_BY_ID = new Map(RUNTIME_DEFINITIONS.map((definition) => [definition.id, definition]));

function getRuntimeDefinition(runtimeId) {
  const normalizedId = normalizeRuntimeId(runtimeId);
  const definition = DEFINITION_BY_ID.get(normalizedId);
  if (!definition) {
    throw Object.assign(new Error("A registered runtime is required."), {
      code: "INVALID_RUNTIME",
    });
  }
  return definition;
}

function listRuntimeDefinitions() {
  return RUNTIME_DEFINITIONS;
}

function normalizeRuntimeId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

module.exports = {
  RUNTIME_IDS,
  getRuntimeDefinition,
  listRuntimeDefinitions,
};
