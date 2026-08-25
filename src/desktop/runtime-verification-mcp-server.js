"use strict";

const { runToolMcpServer } = require("../tools/mcp-stdio-server");

const ECHO_TOOL_NAME = "cyberboss_capability_echo";

function createVerificationToolHost({ token } = {}) {
  const expected = normalizeToken(token);
  if (!expected) throw new Error("A verification token is required.");
  return {
    listTools() {
      return [{
        name: ECHO_TOOL_NAME,
        description: "Return the supplied synthetic capability-verification value unchanged. This tool has no side effects.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      }];
    },
    async invokeTool(name, input) {
      if (name !== ECHO_TOOL_NAME) throw new Error("Unknown verification tool.");
      if (!input || typeof input !== "object" || Array.isArray(input) || input.value !== expected
        || Object.keys(input).some((key) => key !== "value")) {
        throw new Error("The verification echo value did not match.");
      }
      return { text: expected };
    },
  };
}

function parseToken(argv) {
  const index = argv.indexOf("--token");
  return index >= 0 ? normalizeToken(argv[index + 1]) : "";
}

function normalizeToken(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9_-]{8,128}$/.test(text) ? text : "";
}

if (require.main === module) {
  const token = parseToken(process.argv.slice(2));
  if (!token) {
    process.stderr.write("A valid --token is required.\n");
    process.exitCode = 2;
  } else {
    runToolMcpServer({ toolHost: createVerificationToolHost({ token }), runtimeId: "verification" });
  }
}

module.exports = { ECHO_TOOL_NAME, createVerificationToolHost, parseToken };
