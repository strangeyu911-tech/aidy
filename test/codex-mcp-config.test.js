const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
} = require("../src/adapters/runtime/codex/mcp-config");

test("external MCP servers are optional and remain approval-gated", () => {
  const args = buildCodexMcpConfigArgs({
    name: "zhijiantime",
    command: "node",
    args: ["dist/src/index.js"],
  });

  assert.deepEqual(args.slice(0, 4), [
    "-c",
    'mcp_servers.zhijiantime.command="node"',
    "-c",
    'mcp_servers.zhijiantime.args=["dist/src/index.js"]',
  ]);
  assert.equal(args.some((value) => value.includes("approval_mode")), false);
});

test("additional MCP server config loads from a local JSON file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mcp-config-"));
  const filePath = path.join(dir, "servers.json");
  fs.writeFileSync(filePath, JSON.stringify({
    servers: [{
      name: "zhijiantime",
      command: "node",
      args: ["dist/src/index.js"],
    }],
  }));

  assert.deepEqual(resolveAdditionalMcpServerConfigs({ filePath }), [{
    name: "zhijiantime",
    command: "node",
    args: ["dist/src/index.js"],
  }]);
});

test("external MCP reliability and approval fields are validated and forwarded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mcp-config-"));
  const filePath = path.join(dir, "servers.json");
  fs.writeFileSync(filePath, JSON.stringify({
    servers: [{
      name: "zhijiantime",
      command: "node",
      args: ["dist/src/index.js"],
      required: true,
      startupTimeoutSec: 20,
      toolTimeoutSec: 60,
      autoApproveTools: ["list_schedules", "list_todos", "list_schedules"],
    }],
  }));

  const configs = resolveAdditionalMcpServerConfigs({ filePath });
  assert.deepEqual(configs, [{
    name: "zhijiantime",
    command: "node",
    args: ["dist/src/index.js"],
    required: true,
    startupTimeoutSec: 20,
    toolTimeoutSec: 60,
    autoApproveTools: ["list_schedules", "list_todos"],
  }]);

  const args = buildCodexMcpConfigArgs(configs);
  assert.ok(args.includes("mcp_servers.zhijiantime.required=true"));
  assert.ok(args.includes("mcp_servers.zhijiantime.startup_timeout_sec=20"));
  assert.ok(args.includes("mcp_servers.zhijiantime.tool_timeout_sec=60"));
  assert.ok(args.includes('mcp_servers.zhijiantime.tools.list_schedules.approval_mode="auto"'));
  assert.ok(args.includes('mcp_servers.zhijiantime.tools.list_todos.approval_mode="auto"'));
  assert.equal(args.some((value) => value.includes("create_schedule.approval_mode")), false);
  assert.equal(args.some((value) => value.includes("update_todo.approval_mode")), false);
  assert.equal(args.some((value) => value.includes("complete_item.approval_mode")), false);
});

test("invalid external MCP reliability fields fail before startup", () => {
  const cases = [
    [{ required: "yes" }, /required must be a boolean/],
    [{ startupTimeoutSec: 0 }, /startupTimeoutSec must be a positive integer/],
    [{ toolTimeoutSec: 1.5 }, /toolTimeoutSec must be a positive integer/],
    [{ autoApproveTools: "list_schedules" }, /autoApproveTools must be an array/],
    [{ autoApproveTools: [""] }, /autoApproveTools contains an invalid tool/],
  ];
  for (const [patch, expected] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mcp-invalid-"));
    const filePath = path.join(dir, "servers.json");
    fs.writeFileSync(filePath, JSON.stringify({
      servers: [{ name: "zhijiantime", command: "node", ...patch }],
    }));
    assert.throws(() => resolveAdditionalMcpServerConfigs({ filePath }), expected);
  }
});

test("duplicate MCP server names are rejected", () => {
  assert.throws(() => buildCodexMcpConfigArgs([
    { name: "one", command: "node" },
    { name: "one", command: "node" },
  ]), /Duplicate MCP server name: one/);
});
