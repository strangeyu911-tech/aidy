const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { loadInstructionFile } = require("../src/adapters/runtime/shared-instructions");

test("WeChat operations require verified Zhijiantime reads and persistent planning follow-up", () => {
  const instructions = loadInstructionFile(
    path.resolve(__dirname, "..", "templates", "weixin-operations.md"),
    { userName: "测试用户" },
  );

  assert.match(instructions, /verify with the relevant read tool before answering/i);
  assert.match(instructions, /Never guess that the MCP, bridge, session, or tool is missing/i);
  assert.match(instructions, /require 测试用户 to make today's plan in 指尖时光/i);
  assert.match(instructions, /give one exact follow-up time/i);
  assert.match(instructions, /At the promised follow-up, verify again/i);
  assert.match(instructions, /never keep nagging an item marked completed/i);
  assert.match(instructions, /vary short wording/i);
});
