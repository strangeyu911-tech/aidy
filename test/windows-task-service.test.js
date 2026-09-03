const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTaskXml, quoteWindowsArgument } = require("../src/desktop/windows-task-service");

test("desktop task launches only the Electron controller and ignores duplicates", () => {
  const xml = buildTaskXml({
    executable: "D:\\CyberBoss\\dist\\win-unpacked\\CyberBoss.exe",
    args: [],
    workingDirectory: "D:\\CyberBoss\\dist\\win-unpacked",
    userId: "DESKTOP\\user",
  });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count>/);
  assert.doesNotMatch(xml, /powershell/i);
  assert.match(xml, /CyberBoss\.exe/);
  assert.doesNotMatch(xml, /src\\desktop\\main\.js/);
});

test("task arguments preserve paths with spaces", () => {
  assert.equal(quoteWindowsArgument("D:\\My App\\main.js"), '"D:\\My App\\main.js"');
});
