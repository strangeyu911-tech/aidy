"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

const { CodeBuddyClient } = require("./client");

const DEFAULT_START_TIMEOUT_MS = 45_000;
const HEALTH_RETRY_MS = 250;

class CodeBuddyProcessHost {
  constructor({
    stateDir,
    fsImpl = fs,
    spawnImpl = spawn,
    reservePort = reserveLoopbackPort,
    protectDirectory = protectOverlayDirectory,
    healthProbe = defaultHealthProbe,
    randomUUID = crypto.randomUUID,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  } = {}) {
    this.stateDir = path.resolve(requireText(stateDir, "CODEBUDDY_START_TIMEOUT", "CodeBuddy state directory is required."));
    this.fs = fsImpl;
    this.spawnImpl = spawnImpl;
    this.reservePort = reservePort;
    this.protectDirectory = protectDirectory;
    this.healthProbe = healthProbe;
    this.randomUUID = randomUUID;
    this.startTimeoutMs = positiveInteger(startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
    this.child = null;
    this.overlayDir = "";
    this.closing = false;
  }

  async start({ distribution, workspaceRoot, servicePassword, model = "", mcpServers = {}, allowedTools = [] } = {}) {
    if (this.child) throw hostError("CODEBUDDY_START_TIMEOUT", "Managed CodeBuddy is already running.");
    const selected = requireDistribution(distribution);
    const password = requireText(servicePassword, "CODEBUDDY_AUTH_FAILED", "CodeBuddy service password is required.");
    const cwd = path.resolve(requireText(workspaceRoot, "CODEBUDDY_START_TIMEOUT", "CodeBuddy workspace is required."));
    const port = await this.reservePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const overlayDir = path.join(this.stateDir, "codebuddy", "runtime-overlays", this.randomUUID());
    this.overlayDir = overlayDir;
    try {
      await this.fs.promises.mkdir(overlayDir, { recursive: true });
      await this.protectDirectory(overlayDir);
      const overlayPath = path.join(overlayDir, "settings.json");
      const mcpConfigPath = path.join(overlayDir, "mcp.json");
      await writeAndReopenJson(this.fs, overlayPath, { gateway: { auth: "password", password } });
      await writeAndReopenJson(this.fs, mcpConfigPath, { mcpServers: normalizeMcpServers(mcpServers) });
      const args = [
        ...selected.argsPrefix,
        "--serve", "--host", "127.0.0.1", "--port", String(port),
        "--settings", overlayPath,
        "--strict-mcp-config", "--mcp-config", mcpConfigPath,
        ...(normalizeText(model) ? ["--model", normalizeText(model)] : []),
        ...buildToolRestrictionArgs(allowedTools),
      ];
      const child = this.spawnImpl(selected.command, args, {
        cwd,
        env: { ...process.env, CODEBUDDY_GATEWAY_AUTH: "password" },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child || typeof child.once !== "function") {
        throw hostError("CODEBUDDY_START_TIMEOUT", "Managed CodeBuddy process could not be started.");
      }
      this.child = child;
      let startupTail = "";
      const collectStartupOutput = (chunk) => {
        startupTail = `${startupTail}${String(chunk || "")}`.slice(-8 * 1024);
      };
      child.stdout?.on?.("data", collectStartupOutput);
      child.stderr?.on?.("data", collectStartupOutput);
      const earlyExit = new Promise((_, reject) => {
        child.once("error", () => reject(hostError(
          "CODEBUDDY_START_TIMEOUT",
          "Managed CodeBuddy failed before readiness.",
          redactDiagnostic(startupTail, [password, overlayDir, cwd, selected.command]),
        )));
        child.once("exit", (code) => {
          if (!this.closing) reject(hostError(
            "CODEBUDDY_START_TIMEOUT",
            `Managed CodeBuddy exited before readiness (${Number(code) || 0}).`,
            redactDiagnostic(startupTail, [password, overlayDir, cwd, selected.command]),
          ));
        });
      });
      const health = await Promise.race([
        this.healthProbe({ endpoint, servicePassword: password, child, timeoutMs: this.startTimeoutMs }),
        earlyExit,
      ]);
      return { endpoint, port, health, overlayPath, mcpConfigPath, pid: Number(child.pid) || 0 };
    } catch (error) {
      await this.stop();
      if (error?.code) throw error;
      throw hostError("CODEBUDDY_START_TIMEOUT", "Managed CodeBuddy failed to start.");
    }
  }

  async stop() {
    this.closing = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      try { child.kill("SIGTERM"); } catch {}
      await waitForExit(child, 2_000);
    }
    const overlayDir = this.overlayDir;
    this.overlayDir = "";
    if (overlayDir) {
      try { await this.fs.promises.rm(overlayDir, { recursive: true, force: true }); } catch {}
    }
    this.closing = false;
  }
}

async function defaultHealthProbe({ endpoint, servicePassword, child, timeoutMs }) {
  const deadline = Date.now() + positiveInteger(timeoutMs, DEFAULT_START_TIMEOUT_MS);
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw hostError("CODEBUDDY_START_TIMEOUT", "Managed CodeBuddy exited before readiness.");
    try {
      return await new CodeBuddyClient({ endpoint, servicePassword, timeoutMs: 1_000 }).probeCompatibility();
    } catch (error) {
      lastError = error;
      if (error?.code === "CODEBUDDY_API_INCOMPATIBLE" || error?.code === "CODEBUDDY_AUTH_FAILED") throw error;
    }
    await delay(HEALTH_RETRY_MS);
  }
  throw hostError("CODEBUDDY_START_TIMEOUT", lastError ? "Managed CodeBuddy did not become healthy." : "Managed CodeBuddy readiness timed out.");
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = Number(server.address()?.port) || 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function protectOverlayDirectory(directory) {
  if (process.platform !== "win32") {
    await fs.promises.chmod(directory, 0o700);
    return;
  }
  const identity = await execFilePromise("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw hostError("CODEBUDDY_START_TIMEOUT", "Current Windows user identity could not be resolved.");
  await execFilePromise("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`]);
}

async function writeAndReopenJson(fsImpl, filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fsImpl.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fsImpl.promises.rename(temporaryPath, filePath);
  const reopened = JSON.parse(await fsImpl.promises.readFile(filePath, "utf8"));
  if (!reopened || typeof reopened !== "object") throw new Error("overlay reopen failed");
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout || ""));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once?.("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function requireDistribution(value) {
  const source = value && typeof value === "object" ? value : {};
  const command = requireText(source.command, "CODEBUDDY_BINARY_NOT_FOUND", "CodeBuddy command is required.");
  return {
    command,
    argsPrefix: Array.isArray(source.argsPrefix) ? source.argsPrefix.map((item) => String(item)) : [],
  };
}

function normalizeMcpServers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hostError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy MCP configuration is invalid.");
  }
  const result = {};
  for (const [name, server] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !server || typeof server !== "object" || Array.isArray(server)) {
      throw hostError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy MCP server configuration is invalid.");
    }
    const command = requireText(server.command, "CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy MCP server command is required.");
    const args = Array.isArray(server.args) ? server.args.map((item) => String(item)) : [];
    const env = server.env && typeof server.env === "object" && !Array.isArray(server.env)
      ? Object.fromEntries(Object.entries(server.env).map(([key, item]) => [String(key), String(item)]))
      : {};
    result[name] = { type: "stdio", command, args, ...(Object.keys(env).length ? { env } : {}) };
  }
  return result;
}

function buildToolRestrictionArgs(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const tools = value.map((item) => String(item).trim());
  if (tools.some((item) => !/^[a-zA-Z0-9_.:-]{1,160}$/.test(item))) {
    throw hostError("CODEBUDDY_API_INCOMPATIBLE", "CodeBuddy tool allowlist is invalid.");
  }
  return ["--allowedTools", ...tools];
}

function redactDiagnostic(value, forbiddenValues) {
  let output = String(value || "").slice(-8 * 1024);
  for (const forbidden of forbiddenValues) {
    if (!forbidden) continue;
    output = output.split(String(forbidden)).join("[REDACTED]");
  }
  return output.replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]").trim();
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
function requireText(value, code, message) { const text = typeof value === "string" ? value.trim() : ""; if (!text) throw hostError(code, message); return text; }
function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function hostError(code, message, diagnostic = "") {
  const error = Object.assign(new Error(message), { code });
  if (diagnostic) Object.defineProperty(error, "diagnostic", { value: diagnostic, enumerable: false });
  return error;
}

module.exports = { CodeBuddyProcessHost };
