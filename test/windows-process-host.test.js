const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");

test("Windows process host closes its Job Object and child when the host exits", { skip: process.platform !== "win32", timeout: 10_000 }, async () => {
  const hostPath = path.resolve(__dirname, "..", "native", "win32", "CyberBoss.ProcessHost.exe");
  const child = spawn(hostPath, [String(process.pid), process.execPath, "-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const childPid = await waitForChildPid(child);
  assert.ok(isAlive(childPid));
  child.kill();
  await waitUntil(() => !isAlive(childPid), 5_000);
  assert.equal(isAlive(childPid), false);
});

function waitForChildPid(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`process host did not report a child pid: ${stderr}`)), 5_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/child-pid=(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("exit", (code) => { if (!/child-pid=/.test(stderr)) { clearTimeout(timer); reject(new Error(`process host exited ${code}: ${stderr}`)); } });
  });
}

async function waitUntil(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
