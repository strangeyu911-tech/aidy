"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  PROJECT_TOOLS_SERVER_NAME,
  SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
  buildCodeBuddyProjectMcpServerConfig,
  mergeCodeBuddyMcpServers,
} = require("../src/adapters/runtime/codebuddy/project-settings");

const ROOT = path.resolve(__dirname, "..");

test("CodeBuddy Project Tools config is deterministic and independent of shell cwd", () => {
  const first = buildCodeBuddyProjectMcpServerConfig({
    workspaceRoot: "D:\\CyberBoss",
    stateDir: "D:\\State",
    cyberbossHome: ROOT,
    nodeExecutable: "C:\\Aidy\\Aidy.exe",
    electron: true,
  });
  const second = buildCodeBuddyProjectMcpServerConfig({
    workspaceRoot: "D:\\CyberBoss",
    stateDir: "D:\\State",
    cyberbossHome: ROOT,
    nodeExecutable: "C:\\Aidy\\Aidy.exe",
    electron: true,
  });

  assert.deepEqual(first, second);
  assert.equal(first.type, "stdio");
  assert.equal(first.command, "C:\\Aidy\\Aidy.exe");
  assert.deepEqual(first.args, [
    path.join(ROOT, "bin", "cyberboss.js"),
    "tool-mcp-server",
    "--runtime-id", "codebuddy",
    "--workspace-root", path.resolve("D:\\CyberBoss"),
  ]);
  assert.deepEqual(first.env, {
    CYBERBOSS_STATE_DIR: path.resolve("D:\\State"),
    ELECTRON_RUN_AS_NODE: "1",
  });
});

test("CodeBuddy Project Tools merge preserves user servers and rejects reserved-name collisions", () => {
  const projectToolHost = { listTools: () => [], invokeTool: async () => null };
  const merged = mergeCodeBuddyMcpServers({
    existingServers: { user_tools: { command: "user-mcp.exe", args: ["serve"] } },
    projectToolHost,
    workspaceRoot: "D:\\CyberBoss",
    stateDir: "D:\\State",
    cyberbossHome: ROOT,
  });

  assert.deepEqual(merged.user_tools, { command: "user-mcp.exe", args: ["serve"] });
  assert.equal(merged[PROJECT_TOOLS_SERVER_NAME].args[1], "tool-mcp-server");
  assert.throws(
    () => mergeCodeBuddyMcpServers({
      existingServers: { [PROJECT_TOOLS_SERVER_NAME]: { command: "user-mcp.exe" } },
      projectToolHost,
      workspaceRoot: "D:\\CyberBoss",
      stateDir: "D:\\State",
      cyberbossHome: ROOT,
    }),
    (error) => error.code === "CODEBUDDY_MCP_SERVER_CONFLICT",
  );
});

test("supervisor Project Tools policy is explicit and excludes external side effects", () => {
  assert.deepEqual(SUPERVISOR_PROJECT_TOOL_ALLOWLIST, [
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
  assert.equal(SUPERVISOR_PROJECT_TOOL_ALLOWLIST.some((name) => /send|sticker|system/.test(name)), false);
});

test("missing CodeBuddy Project Tools entrypoint fails observably", () => {
  assert.throws(
    () => buildCodeBuddyProjectMcpServerConfig({
      workspaceRoot: "D:\\CyberBoss",
      stateDir: "D:\\State",
      cyberbossHome: "D:\\missing-cyberboss-home",
    }),
    (error) => error.code === "CODEBUDDY_MCP_UNAVAILABLE",
  );
});
