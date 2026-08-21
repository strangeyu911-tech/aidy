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

test("duplicate MCP server names are rejected", () => {
  assert.throws(() => buildCodexMcpConfigArgs([
    { name: "one", command: "node" },
    { name: "one", command: "node" },
  ]), /Duplicate MCP server name: one/);
});
