#!/usr/bin/env node
const os = require("os");
const path = require("path");

const { parseCliOptions } = require("../src/diagnostics/codex-auth/cli-options");
const { runCodexAuthWorkflow } = require("../src/diagnostics/codex-auth/workflow");
const { createPlatformAdapter } = require("../src/diagnostics/codex-auth/platform");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");
const {
  buildCodexMcpConfigArgs,
  resolveAdditionalMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
} = require("../src/adapters/runtime/codex/mcp-config");

async function main(argv = process.argv.slice(2)) {
  loadEnvironment();
  const wantsJson = argv.includes("--json");
  try {
    const options = parseCliOptions(argv);
    const rootDir = path.resolve(__dirname, "..");
    const appServerPrefixArgs = buildCodexMcpConfigArgs([
      resolveCodexProjectToolMcpServerConfig({
        cyberbossHome: process.env.CYBERBOSS_HOME || rootDir,
      }),
      ...resolveAdditionalMcpServerConfigs({
        filePath: process.env.CYBERBOSS_MCP_SERVERS_FILE,
      }),
    ]);
    const platformAdapter = createPlatformAdapter({ platform: process.platform });
    const report = await runCodexAuthWorkflow(options, {
      env: process.env,
      platform: process.platform,
      platformAdapter,
      appServerPrefixArgs,
      appServerEnv: {
        CYBERBOSS_STATE_DIR: process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"),
        TIMELINE_FOR_AGENT_STATE_DIR: process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"),
      },
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(formatHumanReport(report));
    }
    process.exitCode = isSuccessResult(report.result) ? 0 : 1;
    return report;
  } catch (error) {
    const report = {
      result: /not supported/i.test(String(error?.message || ""))
        ? RESULT_CODES.PLATFORM_UNSUPPORTED
        : RESULT_CODES.CONFIG_INVALID,
      platform: process.platform,
      error: sanitizeMessage(error),
    };
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stderr.write(`[FAIL] ${report.error}\nRESULT=${report.result}\n`);
    }
    process.exitCode = 1;
    return report;
  }
}

function formatHumanReport(report) {
  const lines = (report.events || []).map((event) => {
    const code = event.code ? ` (${event.code})` : "";
    return `[${event.level}] ${event.message}${code}`;
  });
  lines.push(`RESULT=${report.result}`);
  return `${lines.join("\n")}\n`;
}

function isSuccessResult(result) {
  return result === RESULT_CODES.REPAIR_SUCCEEDED || result === RESULT_CODES.DIAGNOSIS_COMPLETE;
}

function sanitizeMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/(token|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function loadEnvironment() {
  try {
    const dotenv = require("dotenv");
    dotenv.config({ path: path.join(process.cwd(), ".env") });
    dotenv.config({ path: path.join(os.homedir(), ".cyberboss", ".env") });
  } catch {
    // Environment variables may be provided by the parent process.
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, formatHumanReport, isSuccessResult };
