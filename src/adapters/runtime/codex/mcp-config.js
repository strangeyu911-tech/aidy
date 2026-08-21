const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");

function resolveCodexProjectToolMcpServerConfig({ cyberbossHome = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
    autoApproveTools: listProjectToolNames(),
  };
}

function resolveAdditionalMcpServerConfigs({ filePath = "" } = {}) {
  const normalizedFilePath = normalizeNonEmptyString(filePath) || normalizeNonEmptyString(process.env.CYBERBOSS_MCP_SERVERS_FILE);
  if (!normalizedFilePath) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(normalizedFilePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    throw new Error(`Unable to read CYBERBOSS_MCP_SERVERS_FILE ${normalizedFilePath}: ${message}`);
  }
  const servers = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(servers)) {
    throw new Error(`CYBERBOSS_MCP_SERVERS_FILE must contain a JSON array or an object with a "servers" array: ${normalizedFilePath}`);
  }
  return servers.map((server, index) => normalizeExternalMcpServerConfig(server, index));
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  const configs = Array.isArray(mcpServerConfig)
    ? mcpServerConfig
    : [mcpServerConfig];
  const seenNames = new Set();
  const output = [];
  for (const config of configs) {
    if (!config || typeof config !== "object") {
      continue;
    }
    const name = normalizeMcpServerName(config.name) || "cyberboss_tools";
    if (seenNames.has(name)) {
      throw new Error(`Duplicate MCP server name: ${name}`);
    }
    const command = normalizeNonEmptyString(config.command);
    if (!command) {
      continue;
    }
    const args = Array.isArray(config.args)
      ? config.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
      : [];
    seenNames.add(name);
    output.push(
      "-c",
      `mcp_servers.${name}.command=${quoteTomlString(command)}`,
      "-c",
      `mcp_servers.${name}.args=${formatTomlArray(args)}`,
    );
    const autoApproveTools = Array.isArray(config.autoApproveTools)
      ? config.autoApproveTools
      : name === "cyberboss_tools"
        ? listProjectToolNames()
        : [];
    for (const toolName of autoApproveTools) {
      const normalizedToolName = normalizeNonEmptyString(toolName);
      if (!normalizedToolName) {
        continue;
      }
      output.push(
        "-c",
        `mcp_servers.${name}.tools.${normalizedToolName}.approval_mode=${quoteTomlString("auto")}`,
      );
    }
  }
  return output;
}

function normalizeExternalMcpServerConfig(server, index) {
  if (!server || typeof server !== "object") {
    throw new Error(`Invalid external MCP server at index ${index}`);
  }
  const name = normalizeMcpServerName(server.name);
  const command = normalizeNonEmptyString(server.command);
  if (!name || !command) {
    throw new Error(`External MCP server at index ${index} requires a valid name and command`);
  }
  return {
    name,
    command,
    args: Array.isArray(server.args)
      ? server.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
      : [],
  };
}

function normalizeMcpServerName(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : "";
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
};
