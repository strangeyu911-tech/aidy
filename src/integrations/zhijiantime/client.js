const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class ZhijiantimeClient {
  constructor({ command = "", args = [], cwd = "", env = {}, rootDir = "", mcpServersFile = "" } = {}) {
    const resolved = resolveZhijiantimeCommand({ command, args, cwd, env, rootDir, mcpServersFile });
    this.command = resolved.command;
    this.args = resolved.args;
    this.cwd = resolved.cwd;
    this.env = resolved.env;
    this.client = null;
    this.transport = null;
  }

  isConfigured() {
    return Boolean(this.command && this.args.length);
  }

  async connect() {
    if (this.client) return;
    if (!this.isConfigured()) throw integrationError("ZHIJIANTIME_NOT_CONFIGURED", "未找到指尖时光 MCP 服务。", "configuration");
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/client"),
      import("@modelcontextprotocol/client/stdio"),
    ]);
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd || undefined,
      env: { ...process.env, ...this.env },
      stderr: "pipe",
    });
    this.client = new Client({ name: "cyberboss-desktop", version: "0.1.0" });
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      this.client = null;
      this.transport = null;
      throw integrationError("ZHIJIANTIME_CONNECT_FAILED", error.message || "指尖时光连接失败。", "network");
    }
  }

  async call(name, args = {}) {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args });
    if (result?.isError) {
      const text = result.content?.find((item) => item.type === "text")?.text || "指尖时光操作失败。";
      throw integrationError("ZHIJIANTIME_TOOL_FAILED", text, "third-party");
    }
    return result.structuredContent || {};
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
      env: { ...process.env, ...env },
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

module.exports = { ZhijiantimeClient, resolveZhijiantimeCommand, runCredentialHelper };
