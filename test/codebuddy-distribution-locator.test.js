"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  locateCodeBuddyDistribution,
  probeCodeBuddyCandidate,
  sanitizeCodeBuddyDistribution,
} = require("../src/adapters/runtime/codebuddy/distribution-locator");

function createHarness({ files, responses = {}, installations = [] } = {}) {
  const available = new Set(files || []);
  const opens = [];
  const executions = [];
  const registryCalls = [];

  return {
    available,
    opens,
    executions,
    registryCalls,
    fsImpl: {
      promises: {
        async open(filePath) {
          opens.push(filePath);
          if (!available.has(filePath)) {
            const error = new Error("missing");
            error.code = "ENOENT";
            throw error;
          }
          return { async close() {} };
        },
      },
    },
    execFileImpl(command, args, options, callback) {
      executions.push({ command, args, options });
      const key = `${command}\u0000${args.join("\u0000")}`;
      const response = responses[key];
      if (response instanceof Error) return callback(response, "", "");
      if (!response) return callback(new Error("unexpected invocation"), "", "");
      return callback(null, response.stdout || "", response.stderr || "");
    },
    async queryWindowsInstallations(dependencies) {
      registryCalls.push(dependencies);
      return installations;
    },
  };
}

function standaloneResponses(executablePath, version = "2.115.0", help = "Usage: codebuddy --serve") {
  return {
    [`${executablePath}\u0000--version`]: { stdout: `CodeBuddy Code ${version}\n` },
    [`${executablePath}\u0000--help`]: { stdout: help },
  };
}

function bundledResponses(nodePath, cliPath, version = "2.115.0", help = "Options: --serve") {
  return {
    [`${nodePath}\u0000${cliPath}\u0000--version`]: { stdout: `codebuddy ${version}` },
    [`${nodePath}\u0000${cliPath}\u0000--help`]: { stdout: help },
  };
}

test("discovery uses explicit, codebuddy PATH, cbc PATH, registry, then known WorkBuddy precedence", async () => {
  const explicit = "C:\\saved\\codebuddy.exe";
  const codebuddy = "C:\\tools\\codebuddy.exe";
  const cbc = "C:\\tools\\cbc.exe";
  const registeredCli = "C:\\Registered WorkBuddy\\resources\\codebuddy\\cli.js";
  const registeredNode = "C:\\Registered WorkBuddy\\resources\\codebuddy\\node.exe";
  const knownRoot = "C:\\Users\\test\\AppData\\Local\\Programs\\WorkBuddy";
  const knownCli = path.win32.join(knownRoot, "resources", "codebuddy", "cli.js");
  const knownNode = path.win32.join(knownRoot, "resources", "codebuddy", "node.exe");
  const allFiles = [explicit, codebuddy, cbc, registeredCli, registeredNode, knownCli, knownNode];
  const allResponses = {
    ...standaloneResponses(explicit),
    ...standaloneResponses(codebuddy),
    ...standaloneResponses(cbc),
    ...bundledResponses(registeredNode, registeredCli),
    ...bundledResponses(knownNode, knownCli),
  };
  const scenarios = [
    { removed: [], expected: explicit, source: "explicit" },
    { removed: [explicit], expected: codebuddy, source: "path" },
    { removed: [explicit, codebuddy], expected: cbc, source: "path" },
    { removed: [explicit, codebuddy, cbc], expected: registeredCli, source: "workbuddy-bundled" },
    { removed: [explicit, codebuddy, cbc, registeredCli, registeredNode], expected: knownCli, source: "workbuddy-bundled" },
  ];

  for (const scenario of scenarios) {
    const files = allFiles.filter((filePath) => !scenario.removed.includes(filePath));
    const harness = createHarness({
      files,
      responses: allResponses,
      installations: [{
        installLocation: "C:\\Registered WorkBuddy",
        cliEntryPath: registeredCli,
        bundledNodePath: registeredNode,
      }],
    });
    const result = await locateCodeBuddyDistribution({
      explicitExecutablePath: explicit,
      env: {
        PATH: "C:\\tools",
        PATHEXT: ".EXE",
        LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      },
      platform: "win32",
      fsImpl: harness.fsImpl,
      execFileImpl: harness.execFileImpl,
      queryWindowsInstallations: harness.queryWindowsInstallations,
    });

    assert.equal(result.executablePath, scenario.expected);
    assert.equal(result.source, scenario.source);
    assert.equal(result.version, "2.115.0");
    assert.equal(result.shell, false);
  }
});

test("probe returns a frozen safe invocation and always uses bounded shell-free argument arrays", async () => {
  const executablePath = "C:\\safe path\\codebuddy.exe";
  const harness = createHarness({ files: [executablePath], responses: standaloneResponses(executablePath) });
  const result = await probeCodeBuddyCandidate({
    source: "explicit",
    sourceLabel: "CodeBuddy",
    executablePath,
    command: executablePath,
    argsPrefix: [],
    shell: false,
  }, harness);

  assert.deepEqual(result, {
    source: "explicit",
    sourceLabel: "CodeBuddy",
    version: "2.115.0",
    executablePath,
    command: executablePath,
    argsPrefix: [],
    shell: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.argsPrefix), true);
  assert.equal(harness.opens.filter((value) => value === executablePath).length, 2);
  for (const execution of harness.executions) {
    assert.equal(execution.options.shell, false);
    assert.equal(execution.options.maxBuffer, 64 * 1024);
    assert.equal(execution.options.windowsHide, true);
    assert.equal(typeof execution.options.timeout, "number");
  }
});

test("probe rejects missing, unreadable or replaced files, bad versions, missing serve support, and missing bundle runner", async () => {
  const cliPath = "C:\\WorkBuddy\\resources\\codebuddy\\cli.js";
  const nodePath = "C:\\WorkBuddy\\resources\\codebuddy\\node.exe";
  const candidate = {
    source: "workbuddy-bundled",
    sourceLabel: "WorkBuddy / CodeBuddy",
    executablePath: cliPath,
    command: nodePath,
    argsPrefix: [cliPath],
    shell: false,
  };
  const cases = [
    { name: "missing CLI", files: [nodePath], responses: bundledResponses(nodePath, cliPath) },
    { name: "missing runner", files: [cliPath], responses: bundledResponses(nodePath, cliPath) },
    { name: "unparseable version", files: [cliPath, nodePath], responses: bundledResponses(nodePath, cliPath, "unknown") },
    { name: "help omits serve", files: [cliPath, nodePath], responses: bundledResponses(nodePath, cliPath, "2.115.0", "Usage: codebuddy") },
  ];

  for (const scenario of cases) {
    const harness = createHarness(scenario);
    await assert.rejects(
      probeCodeBuddyCandidate(candidate, harness),
      (error) => error.code === "CODEBUDDY_VERSION_UNREADABLE" && !error.message.includes(cliPath),
      scenario.name,
    );
  }

  const replaced = createHarness({ files: [cliPath, nodePath], responses: bundledResponses(nodePath, cliPath) });
  const originalOpen = replaced.fsImpl.promises.open;
  let cliOpens = 0;
  replaced.fsImpl.promises.open = async (filePath) => {
    if (filePath === cliPath && ++cliOpens === 2) replaced.available.delete(cliPath);
    return originalOpen(filePath);
  };
  await assert.rejects(
    probeCodeBuddyCandidate(candidate, replaced),
    (error) => error.code === "CODEBUDDY_VERSION_UNREADABLE",
  );
});

test("locator aggregates failed candidates into a sanitized binary-not-found error", async () => {
  const harness = createHarness({ files: [], installations: [{ installLocation: "C:\\Broken" }] });
  await assert.rejects(
    locateCodeBuddyDistribution({
      explicitExecutablePath: "C:\\missing\\codebuddy.exe",
      env: { PATH: "C:\\empty", PATHEXT: ".EXE", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      platform: "win32",
      fsImpl: harness.fsImpl,
      execFileImpl: harness.execFileImpl,
      queryWindowsInstallations: harness.queryWindowsInstallations,
    }),
    (error) => {
      assert.equal(error.code, "CODEBUDDY_BINARY_NOT_FOUND");
      assert.equal(error.message.includes("C:\\"), false);
      assert.equal("attempts" in error, false);
      return true;
    },
  );
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.registryCalls.length, 1);
});

test("sanitizer exposes only approved UI metadata", () => {
  const sanitized = sanitizeCodeBuddyDistribution({
    source: "workbuddy-bundled",
    sourceLabel: "WorkBuddy / CodeBuddy",
    version: "2.115.0",
    executablePath: "C:\\WorkBuddy\\resources\\codebuddy\\cli.js",
    command: "C:\\WorkBuddy\\resources\\codebuddy\\node.exe",
    argsPrefix: ["secret-invocation-detail"],
    shell: false,
    env: { TOKEN: "secret" },
    registryDump: "secret registry output",
    helpOutput: "full help output",
    processOutput: "full process output",
  });

  assert.deepEqual(sanitized, {
    source: "workbuddy-bundled",
    sourceLabel: "WorkBuddy / CodeBuddy",
    version: "2.115.0",
    executablePath: "C:\\WorkBuddy\\resources\\codebuddy\\cli.js",
  });
  assert.equal(Object.isFrozen(sanitized), true);
});
