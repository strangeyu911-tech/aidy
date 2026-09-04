const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const READ_TOOL_NAMES = new Set(["list_schedules", "list_todos", "get_daily_overview", "get_period_stats"]);
const MAX_READ_ATTEMPTS = 2;
const READ_RETRY_DELAY_MS = 250;

class ZhijiantimeClient {
  constructor({ command = "", args = [], cwd = "", env = {}, rootDir = "", mcpServersFile = "", logger = null } = {}) {
    const resolved = resolveZhijiantimeCommand({ command, args, cwd, env, rootDir, mcpServersFile });
    this.command = resolved.command;
    this.args = resolved.args;
    this.cwd = resolved.cwd;
    this.env = resolved.env;
    this.logger = logger;
    this.client = null;
    this.transport = null;
    this.connectPromise = null;
    this.connectionGeneration = 0;
  }

  isConfigured() {
    return Boolean(this.command && this.args.length);
  }

  async connect() {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;
    if (!this.isConfigured()) throw integrationError("ZHIJIANTIME_NOT_CONFIGURED", "未找到指尖时光 MCP 服务。", "configuration");
    this.connectPromise = (async () => {
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import("@modelcontextprotocol/client"),
        import("@modelcontextprotocol/client/stdio"),
      ]);
      this.transport = new StdioClientTransport({
        command: this.command,
        args: this.args,
        cwd: this.cwd || undefined,
        env: buildZhijiantimeProcessEnv({ ...process.env, ...this.env }),
        stderr: "pipe",
      });
      this.client = new Client({ name: "cyberboss-desktop", version: "0.1.0" });
      try {
        await this.client.connect(this.transport);
        this.connectionGeneration += 1;
      } catch (error) {
        this.client = null;
        this.transport = null;
        throw integrationError("ZHIJIANTIME_CONNECT_FAILED", error.message || "指尖时光连接失败。", "network");
      }
    })();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async call(name, args = {}) {
    const maxAttempts = READ_TOOL_NAMES.has(name) ? MAX_READ_ATTEMPTS : 1;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.connect();
        const result = await this.client.callTool({ name, arguments: args });
        if (result?.isError) {
          const text = result.content?.find((item) => item.type === "text")?.text || "指尖时光操作失败。";
          throw integrationError("ZHIJIANTIME_TOOL_FAILED", text, "third-party");
        }
        return result.structuredContent || {};
      } catch (error) {
        lastError = error;
        this.logger?.warn?.("zhijiantime.read_attempt_failed", {
          tool: name,
          attempt,
          maxAttempts,
          connectionGeneration: this.connectionGeneration,
          errorCode: normalizeErrorCode(error),
          errorClass: normalizeErrorClass(error),
          errorKind: classifyToolError(error),
        });
        if (attempt >= maxAttempts) break;
        await this.close();
        await delay(READ_RETRY_DELAY_MS);
      }
    }
    throw lastError || integrationError("ZHIJIANTIME_TOOL_FAILED", "指尖时光操作失败。", "third-party");
  }

  listSchedules(date) { return this.call("list_schedules", { from: date, to: date, limit: 500 }); }
  listTodos(date) { return this.call("list_todos", { from: date, to: date, limit: 500 }); }
  updateItem(kind, payload) { return this.call(kind === "schedule" ? "update_schedule" : "update_todo", payload); }

  async close() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    await client?.close().catch(() => {});
  }

  async reauthorize(token) {
    const normalized = String(token || "").trim();
    if (!normalized) throw integrationError("ZHIJIANTIME_TOKEN_REQUIRED", "请输入指尖时光 token。", "authentication");
    const serverScript = this.args.find((value) => /index\.js$/i.test(String(value || "")));
    const authScript = serverScript ? path.resolve(path.dirname(serverScript), "..", "scripts", "configure-auth.js") : "";
    if (!authScript || !fs.existsSync(authScript)) throw integrationError("ZHIJIANTIME_AUTH_HELPER_MISSING", "找不到指尖时光授权程序。", "configuration");
    await this.close();
    await runCredentialHelper(this.command, authScript, normalized, this.cwd, this.env);
    return { authorized: true };
  }
}

function resolveZhijiantimeCommand({ command, args, cwd, env, rootDir, mcpServersFile = "" }) {
  if (command && Array.isArray(args) && args.length) return { command, args, cwd, env };
  const envCommand = process.env.CYBERBOSS_ZHIJIANTIME_COMMAND;
  const envArgs = parseJsonArray(process.env.CYBERBOSS_ZHIJIANTIME_ARGS);
  if (envCommand && envArgs.length) return { command: envCommand, args: envArgs, cwd, env };

  const serverFromMcpFile = resolveFromExternalMcpFile(mcpServersFile || process.env.CYBERBOSS_MCP_SERVERS_FILE);
  if (serverFromMcpFile) return serverFromMcpFile;

  const candidates = [
    path.resolve(path.dirname(rootDir || process.cwd()), "指尖时光MCP", "指尖时光MCP", "dist", "src", "index.js"),
    "D:\\指尖时光MCP\\指尖时光MCP\\dist\\src\\index.js",
  ];
  const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!scriptPath) return { command: "", args: [], cwd: "", env: {} };
  const nodeCommand = process.env.CYBERBOSS_NODE_COMMAND
    || (fs.existsSync("D:\\Node_js\\node.exe") ? "D:\\Node_js\\node.exe" : process.execPath);
  return { command: nodeCommand, args: [scriptPath], cwd: path.resolve(scriptPath, "..", "..", ".."), env: {} };
}

function resolveFromExternalMcpFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const servers = Array.isArray(parsed) ? parsed : parsed?.servers || [];
    const server = servers.find((item) => /zhijian|指尖/i.test(String(item?.name || "")));
    return server ? { command: server.command, args: server.args || [], cwd: server.cwd || "", env: server.env || {} } : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}
function runCredentialHelper(command, scriptPath, token, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [scriptPath], {
      cwd: cwd || undefined,
      env: buildZhijiantimeProcessEnv({ ...process.env, ...env }),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000); });
    child.once("error", (error) => reject(integrationError("ZHIJIANTIME_AUTH_FAILED", error.message, "authentication")));
    child.once("exit", (code) => code === 0 ? resolve() : reject(integrationError("ZHIJIANTIME_AUTH_FAILED", stderr.trim() || "指尖时光授权失败。", "authentication")));
    child.stdin.end(token);
  });
}
function integrationError(code, message, category) { const error = new Error(message); error.code = code; error.category = category; return error; }

function buildZhijiantimeProcessEnv(env = process.env, platform = process.platform) {
  const result = { ...env };
  if (platform !== "win32") return result;
  result.PSModulePath = resolveZhijiantimePowerShellModulePath(result, platform);
  return result;
}

function resolveZhijiantimePowerShellModulePath(env = process.env, platform = process.platform) {
  if (platform !== "win32") return String(env.PSModulePath || "");
  const current = String(env.PSModulePath || "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && !/codex-runtimes[\\/].*powershell[\\/]Modules/i.test(item));
  const windir = String(env.WINDIR || env.SystemRoot || "C:\\Windows").trim() || "C:\\Windows";
  const programFiles = String(env.ProgramFiles || "C:\\Program Files").trim() || "C:\\Program Files";
  const required = [
    path.join(programFiles, "WindowsPowerShell", "Modules"),
    path.join(windir, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  ];
  return [...new Set([...current, ...required])].join(";");
}

function normalizeErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null;
}

function normalizeErrorClass(error) {
  return typeof error?.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : "Error";
}

function classifyToolError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("dpapi")) return "dpapi";
  if (message.includes("network") || message.includes("timeout")) return "network";
  if (message.includes("auth") || message.includes("凭据")) return "authentication";
  return "unknown";
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = {
  ZhijiantimeClient,
  buildZhijiantimeProcessEnv,
  resolveZhijiantimeCommand,
  resolveZhijiantimePowerShellModulePath,
  runCredentialHelper,
};
