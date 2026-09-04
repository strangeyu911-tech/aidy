const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");
const { resolveZhijiantimePowerShellModulePath } = require("../../../integrations/zhijiantime/client");

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
    if (typeof config.required === "boolean") {
      output.push(
        "-c",
        `mcp_servers.${name}.required=${config.required}`,
      );
    }
    if (Number.isInteger(config.startupTimeoutSec) && config.startupTimeoutSec > 0) {
      output.push(
        "-c",
        `mcp_servers.${name}.startup_timeout_sec=${config.startupTimeoutSec}`,
      );
    }
    if (Number.isInteger(config.toolTimeoutSec) && config.toolTimeoutSec > 0) {
      output.push(
        "-c",
        `mcp_servers.${name}.tool_timeout_sec=${config.toolTimeoutSec}`,
      );
    }
    const suppliedEnv = isRecord(config.env) ? config.env : {};
    const env = Object.fromEntries(Object.entries(suppliedEnv)
        .map(([key, value]) => [normalizeMcpEnvName(key), normalizeNonEmptyString(value)])
        .filter(([key, value]) => key && value));
    if (/zhijian|指尖/i.test(name) && process.platform === "win32") {
      env.PSModulePath = resolveZhijiantimePowerShellModulePath(process.env, process.platform);
    }
    if (Object.keys(env).length) {
      output.push(
        "-c",
        `mcp_servers.${name}.env=${formatTomlInlineTable(env)}`,
      );
    }
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
  const normalized = {
    name,
    command,
    args: Array.isArray(server.args)
      ? server.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
      : [],
  };
  if (Object.prototype.hasOwnProperty.call(server, "required")) {
    if (typeof server.required !== "boolean") {
      throw new Error(`External MCP server ${name} field required must be a boolean`);
    }
    normalized.required = server.required;
  }
  for (const [field, sourceField] of [
    ["startupTimeoutSec", "startupTimeoutSec"],
    ["toolTimeoutSec", "toolTimeoutSec"],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(server, sourceField)) {
      continue;
    }
    const value = server[sourceField];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`External MCP server ${name} field ${sourceField} must be a positive integer`);
    }
    normalized[field] = value;
  }
  if (Object.prototype.hasOwnProperty.call(server, "autoApproveTools")) {
    if (!Array.isArray(server.autoApproveTools)) {
      throw new Error(`External MCP server ${name} field autoApproveTools must be an array`);
    }
    const tools = server.autoApproveTools.map((value, toolIndex) => {
      const toolName = normalizeNonEmptyString(value);
      if (!toolName) {
        throw new Error(`External MCP server ${name} field autoApproveTools contains an invalid tool at index ${toolIndex}`);
      }
      return toolName;
    });
    normalized.autoApproveTools = [...new Set(tools)];
  }
  return normalized;
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

function formatTomlInlineTable(value) {
  return `{${Object.entries(value).map(([key, item]) => `${key}=${quoteTomlString(item)}`).join(",")}}`;
}

function normalizeMcpEnvName(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized) ? normalized : "";
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
};
