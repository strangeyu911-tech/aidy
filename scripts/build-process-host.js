const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const source = path.join(rootDir, "native", "win32", "CyberBoss.ProcessHost.cs");
const output = path.join(rootDir, "native", "win32", "CyberBoss.ProcessHost.exe");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

if (process.platform !== "win32") process.exit(0);
if (!fs.existsSync(compiler)) throw new Error("Windows C# compiler was not found.");
const result = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${output}`, source], {
  cwd: rootDir,
  windowsHide: true,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(`built ${output}`);
