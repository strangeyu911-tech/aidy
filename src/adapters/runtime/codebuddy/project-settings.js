"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_TOOLS_SERVER_NAME = "cyberboss_tools";
const SUPERVISOR_PROJECT_TOOL_ALLOWLIST = Object.freeze([
  "mcp__cyberboss_tools__cyberboss_diary_append",
  "mcp__cyberboss_tools__cyberboss_reminder_create",
  "mcp__cyberboss_tools__cyberboss_timeline_read",
  "mcp__cyberboss_tools__cyberboss_timeline_categories",
  "mcp__cyberboss_tools__cyberboss_timeline_proposals",
  "mcp__cyberboss_tools__cyberboss_timeline_write",
  "mcp__cyberboss_tools__cyberboss_timeline_build",
  "mcp__cyberboss_tools__whereabouts_snapshot",
  "mcp__cyberboss_tools__whereabouts_current_stay",
  "mcp__cyberboss_tools__whereabouts_recent_stays",
  "mcp__cyberboss_tools__whereabouts_recent_moves",
  "mcp__cyberboss_tools__whereabouts_summary",
]);

function buildCodeBuddyProjectMcpServerConfig({
  workspaceRoot,
  stateDir,
  cyberbossHome = "",
  nodeExecutable = process.execPath,
  electron = Boolean(process.versions.electron),
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw runtimeError("CODEBUDDY_MCP_UNAVAILABLE", "CodeBuddy Project Tools require a workspace root.");
  }
  const normalizedStateDir = normalizeText(stateDir);
  if (!normalizedStateDir) {
    throw runtimeError("CODEBUDDY_MCP_UNAVAILABLE", "CodeBuddy Project Tools require a state directory.");
  }
  const home = normalizeText(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    throw runtimeError("CODEBUDDY_MCP_UNAVAILABLE", `Cyberboss MCP entrypoint not found: ${scriptPath}`);
  }
  const command = normalizeText(nodeExecutable);
  if (!command) {
    throw runtimeError("CODEBUDDY_MCP_UNAVAILABLE", "CodeBuddy Project Tools require a node executable.");
  }
  return {
    type: "stdio",
    command,
    args: [
      scriptPath,
      "tool-mcp-server",
      "--runtime-id", "codebuddy",
      "--workspace-root", path.resolve(normalizedWorkspaceRoot),
    ],
    env: {
      CYBERBOSS_STATE_DIR: path.resolve(normalizedStateDir),
      ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}

function mergeCodeBuddyMcpServers({
  existingServers = {},
  projectToolHost = null,
  workspaceRoot,
  stateDir,
  cyberbossHome = "",
  nodeExecutable = process.execPath,
  electron = Boolean(process.versions.electron),
} = {}) {
  const existing = normalizeServerMap(existingServers);
  if (!projectToolHost) return { ...existing };
  if (Object.prototype.hasOwnProperty.call(existing, PROJECT_TOOLS_SERVER_NAME)) {
    throw runtimeError(
      "CODEBUDDY_MCP_SERVER_CONFLICT",
      `The reserved CodeBuddy MCP server name is already configured: ${PROJECT_TOOLS_SERVER_NAME}`,
    );
  }
  return {
    ...existing,
    [PROJECT_TOOLS_SERVER_NAME]: buildCodeBuddyProjectMcpServerConfig({
      workspaceRoot,
      stateDir,
      cyberbossHome,
      nodeExecutable,
      electron,
    }),
  };
}

function normalizeServerMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError("CODEBUDDY_MCP_CONFIG_INVALID", "CodeBuddy MCP servers must be an object.");
  }
  return Object.fromEntries(Object.entries(value).map(([name, server]) => [name, cloneJson(server)]));
}

function cloneJson(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

module.exports = {
  PROJECT_TOOLS_SERVER_NAME,
  SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
  buildCodeBuddyProjectMcpServerConfig,
  mergeCodeBuddyMcpServers,
};
