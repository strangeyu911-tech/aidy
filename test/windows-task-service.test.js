const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTaskXml, quoteWindowsArgument } = require("../src/desktop/windows-task-service");

test("desktop task launches only the Electron controller and ignores duplicates", () => {
  const xml = buildTaskXml({
    executable: "D:\\CyberBoss\\node_modules\\electron\\dist\\electron.exe",
    args: ["D:\\CyberBoss\\src\\desktop\\main.js"],
    workingDirectory: "D:\\CyberBoss",
    userId: "DESKTOP\\user",
  });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count>/);
  assert.doesNotMatch(xml, /powershell/i);
  assert.match(xml, /electron\.exe/);
});

test("task arguments preserve paths with spaces", () => {
  assert.equal(quoteWindowsArgument("D:\\My App\\main.js"), '"D:\\My App\\main.js"');
});
