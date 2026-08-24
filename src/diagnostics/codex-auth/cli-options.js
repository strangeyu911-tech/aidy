function parseCliOptions(argv = [], { platform = process.platform, defaultPort = 8765 } = {}) {
  const options = {
    diagnoseOnly: false,
    json: false,
    noRestart: false,
    port: normalizePort(defaultPort),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "").trim();
    if (argument === "--diagnose-only") {
      options.diagnoseOnly = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--no-restart") {
      options.noRestart = true;
    } else if (argument === "--port") {
      if (index + 1 >= argv.length) {
        throw new Error("--port requires a value");
      }
      options.port = normalizePort(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--port=")) {
      options.port = normalizePort(argument.slice("--port=".length));
    } else {
      throw new Error(`Unknown option: ${argument || "(empty)"}`);
    }
  }

  if (platform !== "win32") {
    throw new Error(`Automatic Codex authentication repair is not supported on ${platform}`);
  }
  return options;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

module.exports = { parseCliOptions, normalizePort };
