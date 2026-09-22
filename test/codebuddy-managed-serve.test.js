"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CodeBuddyClient } = require("../src/adapters/runtime/codebuddy/client");
const { CodeBuddyProcessHost } = require("../src/adapters/runtime/codebuddy/process-host");
const http = require("node:http");

class BannerAuthServer {
  // Mimics the CLI 2.137.1 auth-contract regression: the gateway only accepts
  // the machine-generated password it printed on its startup banner and
  // rejects the vault password the overlay carries.
  constructor({ acceptedPassword }) {
    this.acceptedPassword = acceptedPassword;
    this.seen = [];
    this.server = http.createServer((request, response) => {
      const auth = String(request.headers.authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      this.seen.push(token);
      if (token !== this.acceptedPassword) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "AUTH_REQUIRED" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", version: "2.137.1" }));
    });
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve(this.server.address().port)));
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

test("when the vault password is rejected the banner credential is adopted for this process", async (t) => {
  const BANNER_PASSWORD = "banner-generated-password-0123456789abcdef";
  const auth = new BannerAuthServer({ acceptedPassword: BANNER_PASSWORD });
  const port = await auth.listen();
  t.after(() => auth.close());

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-banner-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => port,
    protectDirectory: async () => {},
    spawnImpl() {
      const child = new FakeChild(4403);
      queueMicrotask(() => child.stdout.emit("data", `Managed gateway ready. Password ${BANNER_PASSWORD}\n`));
      return child;
    },
    // No healthProbe injection: exercise the real probe and its banner fallback.
  });

  const started = await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "vault-password-rejected-by-cli",
  });

  assert.equal(started.effectiveServicePassword, BANNER_PASSWORD);
  assert.equal(started.health.ok, true);
  assert.equal(auth.seen.includes("vault-password-rejected-by-cli"), true, "the vault credential is tried first");
  assert.equal(auth.seen.includes(BANNER_PASSWORD), true, "the banner credential is the fallback");
  await host.stop();
});

test("a gateway that rejects both passwords still fails the start", async (t) => {
  const auth = new BannerAuthServer({ acceptedPassword: "some-other-credential-entirely" });
  const port = await auth.listen();
  t.after(() => auth.close());

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-banner-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => port,
    protectDirectory: async () => {},
    startTimeoutMs: 1_500,
    spawnImpl() {
      const child = new FakeChild(4404);
      queueMicrotask(() => child.stdout.emit("data", "Password banner-generated-password-0123456789abcdef\n"));
      return child;
    },
  });

  await assert.rejects(
    host.start({
      distribution: distribution(),
      workspaceRoot: stateDir,
      servicePassword: "vault-password-rejected-by-cli",
    }),
    (error) => error.code === "CODEBUDDY_AUTH_FAILED",
  );
  await host.stop();
});
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

test("managed serve uses loopback, a protected file overlay, and no command-line password", async (t) => {
  // The child inherits the parent environment, and a shell that is itself hosted
  // by CodeBuddy/WorkBuddy already exports CODEBUDDY_GATEWAY_PASSWORD. Clear it so
  // this assertion checks what the host puts in the child env, not what our own
  // shell happens to carry (src never references this variable).
  const ambientPassword = process.env.CODEBUDDY_GATEWAY_PASSWORD;
  delete process.env.CODEBUDDY_GATEWAY_PASSWORD;
  t.after(() => {
    if (ambientPassword === undefined) delete process.env.CODEBUDDY_GATEWAY_PASSWORD;
    else process.env.CODEBUDDY_GATEWAY_PASSWORD = ambientPassword;
  });

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
  // The gateway password MUST be injected via env: CLI 2.137.1+ persists its
  // own machine-level password and ignores the --settings overlay credential,
  // and the documented auth precedence is env > CLI args > config. The
  // password must still never appear on the command line (asserted below).
  assert.equal(spawns[0].options.env.CODEBUDDY_GATEWAY_PASSWORD, "not-on-command-line");
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

test("managed serve resolves permission decisions in-process when a non-default mode is requested", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codebuddy-permission-mode-"));
  const spawns = [];
  const host = new CodeBuddyProcessHost({
    stateDir,
    reservePort: async () => 44131,
    protectDirectory: async () => {},
    spawnImpl(command, args) { spawns.push({ command, args }); return new FakeChild(4403); },
    healthProbe: async () => ({ ok: true, status: "ok" }),
  });

  await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "secret",
    permissionMode: "dontAsk",
  });
  const args = spawns[0].args;
  assert.equal(args.includes("--permission-mode"), true);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  await host.stop();

  // The default mode stays implicit so the managed process keeps its own default.
  await host.start({
    distribution: distribution(),
    workspaceRoot: stateDir,
    servicePassword: "secret",
  });
  assert.equal(spawns[1].args.includes("--permission-mode"), false);
  await host.stop();

  await assert.rejects(
    host.start({
      distribution: distribution(),
      workspaceRoot: stateDir,
      servicePassword: "secret",
      permissionMode: "yolo",
    }),
    (error) => error.code === "CODEBUDDY_API_INCOMPATIBLE",
  );
  assert.equal(spawns.length, 2);
});
