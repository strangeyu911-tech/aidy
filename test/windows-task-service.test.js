const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTaskXml, quoteWindowsArgument, TASK_NAME, LEGACY_DESKTOP_TASK_NAME } = require("../src/desktop/windows-task-service");

test("desktop task launches only the Electron controller and ignores duplicates", () => {
  const xml = buildTaskXml({
    executable: "D:\\CyberBoss\\dist\\win-unpacked\\Aidy.exe",
    args: [],
    workingDirectory: "D:\\CyberBoss\\dist\\win-unpacked",
    userId: "DESKTOP\\user",
  });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count>/);
  assert.doesNotMatch(xml, /powershell/i);
  assert.match(xml, /Aidy\.exe/);
  assert.match(xml, /Aidy desktop controller/);
  assert.doesNotMatch(xml, /src\\desktop\\main\.js/);
  assert.equal(TASK_NAME, "\\Aidy\\Aidy 桌面控制中心");
  assert.equal(LEGACY_DESKTOP_TASK_NAME, "\\CyberBoss\\CyberBoss 桌面控制中心");
});

test("task arguments preserve paths with spaces", () => {
  assert.equal(quoteWindowsArgument("D:\\My App\\main.js"), '"D:\\My App\\main.js"');
});
