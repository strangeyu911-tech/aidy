"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodeBuddyClient } = require("../src/adapters/runtime/codebuddy/client");
const { CodeBuddyProcessHost } = require("../src/adapters/runtime/codebuddy/process-host");
const {
  buildCodeBuddyProjectMcpServerConfig,
  SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
} = require("../src/adapters/runtime/codebuddy/project-settings");

class FakeChild extends EventEmitter {
  constructor(pid = 4401) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

function distribution() {
  return {
    source: "workbuddy-bundled",
    sourceLabel: "WorkBuddy / CodeBuddy",
    version: "2.115.0",
    executablePath: "C:\\WorkBuddy\\codebuddy",
    command: "C:\\WorkBuddy\\node.exe",
    argsPrefix: ["C:\\WorkBuddy\\codebuddy"],
    shell: false,
  };
}

test("managed serve uses loopback, a protected file overlay, and no command-line password", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-host-"));
  const spawns = [];
  const protectedDirectories = [];
  const child = new FakeChild();
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44123,
    protectDirectory: async (directory) => protectedDirectories.push(directory),
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    healthProbe: async ({ endpoint }) => ({ ok: true, endpoint, version: "2.115.0" }),
  });

  const started = await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "not-on-command-line",
    mcpServers: {
      cyberboss_verifier: {
        type: "stdio",
        command: process.execPath,
        args: ["D:\\CyberBoss\\src\\desktop\\runtime-verification-mcp-server.js", "--token", "echo_token_123"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
    allowedTools: ["mcp__cyberboss_verifier__cyberboss_capability_echo"],
  });

  assert.equal(started.endpoint, "http://127.0.0.1:44123");
  assert.equal(started.health.ok, true);
  assert.equal(protectedDirectories.length, 1);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, distribution().command);
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].args.includes("--serve"), true);
  assert.equal(spawns[0].args.includes("--host"), true);
  assert.equal(spawns[0].args.includes("127.0.0.1"), true);
  assert.equal(spawns[0].args.includes("--port"), true);
  assert.equal(spawns[0].args.includes("44123"), true);
  assert.equal(spawns[0].args.includes("--auth"), false);
  assert.equal(spawns[0].options.env.CODEBUDDY_GATEWAY_AUTH, "password");
  assert.equal("CODEBUDDY_GATEWAY_PASSWORD" in spawns[0].options.env, false);
  assert.equal(spawns[0].args.join(" ").includes("not-on-command-line"), false);
  assert.deepEqual(spawns[0].args.slice(-2), [
    "--allowedTools", "mcp__cyberboss_verifier__cyberboss_capability_echo",
  ]);

  const overlayPath = started.overlayPath;
  const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
  assert.deepEqual(overlay, { gateway: { auth: "password", password: "not-on-command-line" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(started.mcpConfigPath, "utf8")), {
    mcpServers: {
      cyberboss_verifier: {
        type: "stdio",
        command: process.execPath,
        args: ["D:\\CyberBoss\\src\\desktop\\runtime-verification-mcp-server.js", "--token", "echo_token_123"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  });
  assert.equal(fs.existsSync(overlayPath), true);
  await host.stop();
  assert.equal(fs.existsSync(path.dirname(overlayPath)), false);
});

test("managed serve writes the merged Project Tools MCP server and explicit safe allowlist", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-project-overlay-"));
  const child = new FakeChild(4402);
  const spawns = [];
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44128,
    protectDirectory: async () => {},
    spawnImpl: (command, args) => { spawns.push({ command, args }); return child; },
    healthProbe: async () => ({ ok: true, status: "ok" }),
  });
  const projectServer = buildCodeBuddyProjectMcpServerConfig({
    workspaceRoot: stateDir,
    stateDir,
    cyberbossHome: path.resolve(__dirname, ".."),
  });

  const started = await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "temporary-secret",
    mcpServers: {
      user_tools: { command: "user-mcp.exe", args: ["serve"] },
      cyberboss_tools: projectServer,
    },
    allowedTools: SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(started.mcpConfigPath, "utf8")), {
    mcpServers: {
      user_tools: { type: "stdio", command: "user-mcp.exe", args: ["serve"] },
      cyberboss_tools: {
        type: "stdio",
        command: process.execPath,
        args: projectServer.args,
        env: projectServer.env,
      },
    },
  });
  assert.deepEqual(spawns[0].args.slice(-SUPERVISOR_PROJECT_TOOL_ALLOWLIST.length - 1), [
    "--allowedTools", ...SUPERVISOR_PROJECT_TOOL_ALLOWLIST,
  ]);
  await host.stop();
});

test("managed serve maps startup timeout and cleans the plaintext overlay", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-timeout-"));
  const child = new FakeChild();
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44124,
    protectDirectory: async () => {},
    spawnImpl: () => child,
    healthProbe: async () => {
      const error = new Error("not ready");
      error.code = "CODEBUDDY_START_TIMEOUT";
      throw error;
    },
  });

  await assert.rejects(host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "temporary-secret",
  }), (error) => error.code === "CODEBUDDY_START_TIMEOUT" && !error.message.includes("temporary-secret"));
  assert.equal(fs.existsSync(path.join(stateDir, "codebuddy", "runtime-overlays")), true);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "codebuddy", "runtime-overlays")), []);
});

test("managed serve passes the selected model id to CodeBuddy", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-model-"));
  const spawns = [];
  const child = new FakeChild();
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44126,
    protectDirectory: async () => {},
    spawnImpl(command, args) {
      spawns.push({ command, args });
      return child;
    },
    healthProbe: async () => ({ ok: true, status: "ok" }),
  });

  await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "temporary-secret",
    model: "hy4-real-id",
  });

  assert.deepEqual(spawns[0].args.slice(-2), ["--model", "hy4-real-id"]);
  await host.stop();
});

test("managed serve reports child process lifecycle failures after readiness", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-host-lifecycle-"));
  const child = new FakeChild();
  const lifecycle = [];
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44127,
    protectDirectory: async () => {},
    spawnImpl: () => child,
    onLifecycle: (event) => lifecycle.push(event),
    healthProbe: async () => ({ ok: true, status: "ok" }),
  });

  await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "temporary-secret",
  });
  child.exitCode = 23;
  child.emit("exit", 23, null);

  assert.deepEqual(lifecycle, [{ type: "process_exit", code: 23 }]);
  await host.stop();
});

test("health compatibility probe accepts documented envelope and rejects malformed health", async () => {
  const calls = [];
  const client = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44125",
    servicePassword: "gateway-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() { return { data: { status: "ok", version: "2.115.0" } }; },
      };
    },
  });
  const result = await client.probeCompatibility();
  assert.deepEqual(result, { ok: true, status: "ok", version: "2.115.0" });
  assert.equal(calls[0].url, "http://127.0.0.1:44125/api/v1/health");
  assert.equal(calls[0].options.headers["X-CodeBuddy-Request"], "1");
  assert.equal(calls[0].options.headers.Authorization, "Bearer gateway-secret");

  const malformed = new CodeBuddyClient({
    endpoint: "http://127.0.0.1:44125",
    servicePassword: "gateway-secret",
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { data: {} }; } }),
  });
  await assert.rejects(malformed.probeCompatibility(), (error) => error.code === "CODEBUDDY_API_INCOMPATIBLE");
});
