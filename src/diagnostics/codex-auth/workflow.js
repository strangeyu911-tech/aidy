const { resolveCodexConfig, diagnoseCredentials } = require("./diagnostics");
const { runDeviceLogin } = require("./device-login");
const { runAppServerProbe } = require("./app-server-probe");
const { createPlatformAdapter } = require("./platform");
const { RESULT_CODES } = require("./result-codes");

async function runCodexAuthWorkflow(options, {
  env = process.env,
  platform = process.platform,
  configResolver = resolveCodexConfig,
  credentialDiagnoser = diagnoseCredentials,
  deviceLogin = runDeviceLogin,
  platformAdapter = createPlatformAdapter({ platform }),
  probe = runAppServerProbe,
  configDependencies = {},
  diagnosticDependencies = {},
  deviceLoginDependencies = {},
  probeDependencies = {},
  appServerPrefixArgs = [],
  appServerEnv = {},
} = {}) {
  const events = [];
  const baseConfig = configResolver({ env });
  if (!baseConfig.ok) {
    addEvent(events, "FAIL", "config", "CyberBoss Codex configuration is invalid", baseConfig.code);
    return buildResult(baseConfig.code, baseConfig, {}, events, platform);
  }
  const config = {
    ...baseConfig,
    port: options.port || baseConfig.port,
    listenUrl: `ws://127.0.0.1:${options.port || baseConfig.port}`,
    appServerPrefixArgs,
    appServerEnv,
  };
  if (platformAdapter.unsupported) {
    addEvent(events, "FAIL", "platform", `Platform ${platform} is not supported`, RESULT_CODES.PLATFORM_UNSUPPORTED);
    return buildResult(RESULT_CODES.PLATFORM_UNSUPPORTED, config, {}, events, platform);
  }
  addEvent(events, "PASS", "config", "CyberBoss CODEX_HOME and Codex command resolved");

  let credentials = credentialDiagnoser(config, diagnosticDependencies);
  recordCredentialEvents(events, credentials);
  let processState = await safeInspect(platformAdapter, config);
  recordProcessEvents(events, processState);

  if (options.diagnoseOnly) {
    const code = credentials.ok
      ? processDiagnosisCode(processState)
      : credentials.code;
    if (!code) {
      addEvent(events, "PASS", "diagnosis", "Local diagnosis completed; model authentication was not probed");
    }
    return buildResult(code || RESULT_CODES.DIAGNOSIS_COMPLETE, config, {
      credentials,
      processState,
      probeVerified: false,
      mode: "diagnose-only",
    }, events, platform);
  }

  if (!credentials.ok) {
    if (!isLoginRepairable(credentials.code)) {
      return buildResult(credentials.code, config, { credentials, processState }, events, platform);
    }
    addEvent(events, "ACTION", "device-auth", "Device-code login required");
    const login = await deviceLogin(config, {
      ...deviceLoginDependencies,
      verifyCredentials: async () => credentialDiagnoser(config, diagnosticDependencies),
    });
    if (!login.ok) {
      addEvent(events, "FAIL", "device-auth", "Device-code login did not produce reusable credentials", login.code);
      return buildResult(login.code || RESULT_CODES.DEVICE_AUTH_FAILED, config, {
        credentials,
        processState,
        deviceLogin: summarizeDeviceLogin(login),
      }, events, platform);
    }
    credentials = credentialDiagnoser(config, diagnosticDependencies);
    recordCredentialEvents(events, credentials);
    if (!credentials.ok) {
      return buildResult(credentials.code, config, { credentials, processState }, events, platform);
    }
  }

  let appServerStarted = false;
  let appServerRestarted = false;
  if (processState.code === RESULT_CODES.APP_SERVER_NOT_RUNNING) {
    addEvent(events, "ACTION", "app-server", "Starting Codex App Server because no listener exists");
    processState = await platformAdapter.start(config);
    appServerStarted = Boolean(processState.started);
    recordProcessEvents(events, processState);
    if (!processState.ok) {
      return buildResult(processState.code || RESULT_CODES.APP_SERVER_START_FAILED, config, {
        credentials,
        processState,
        appServerStarted,
      }, events, platform);
    }
  }

  let probeResult = await probe({ endpoint: config.listenUrl, cwd: config.cwd }, probeDependencies);
  recordProbeEvent(events, probeResult);
  if (probeResult.ok) {
    return buildResult(RESULT_CODES.REPAIR_SUCCEEDED, config, {
      credentials,
      processState,
      probeResult,
      appServerStarted,
      appServerRestarted,
    }, events, platform);
  }
  if (probeResult.code !== RESULT_CODES.APP_SERVER_UNAUTHORIZED) {
    return buildResult(probeResult.code, config, {
      credentials,
      processState,
      probeResult,
      appServerStarted,
      appServerRestarted,
    }, events, platform);
  }

  processState = await safeInspect(platformAdapter, config);
  recordProcessEvents(events, processState);
  if (!processState.appServerIdentityVerified) {
    addEvent(events, "FAIL", "app-server", "Listener identity could not be proved; no process was stopped", RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED);
    return buildResult(RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED, config, {
      credentials,
      processState,
      probeResult,
    }, events, platform);
  }
  if (options.noRestart) {
    addEvent(events, "FAIL", "app-server", "Verified App Server needs a restart, but --no-restart was set", RESULT_CODES.APP_SERVER_UNAUTHORIZED);
    return buildResult(RESULT_CODES.APP_SERVER_UNAUTHORIZED, config, {
      credentials,
      processState,
      probeResult,
      restartRequired: true,
    }, events, platform);
  }

  addEvent(events, "ACTION", "app-server", "Restarting the verified Codex App Server");
  processState = await platformAdapter.restart(config);
  appServerRestarted = Boolean(processState.restarted);
  recordProcessEvents(events, processState);
  if (!processState.ok) {
    return buildResult(processState.code || RESULT_CODES.APP_SERVER_START_FAILED, config, {
      credentials,
      processState,
      probeResult,
      appServerRestarted,
    }, events, platform);
  }

  probeResult = await probe({ endpoint: config.listenUrl, cwd: config.cwd }, probeDependencies);
  recordProbeEvent(events, probeResult);
  return buildResult(probeResult.ok ? RESULT_CODES.REPAIR_SUCCEEDED : probeResult.code, config, {
    credentials,
    processState,
    probeResult,
    appServerStarted,
    appServerRestarted,
  }, events, platform);
}

async function safeInspect(adapter, config) {
  try {
    return await adapter.inspect(config);
  } catch (error) {
    return {
      ok: false,
      code: RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED,
      appServerIdentityVerified: false,
      inspectionError: String(error?.message || error).slice(0, 300),
    };
  }
}

function buildResult(result, config, state, events, platform) {
  const credentials = state.credentials || {};
  const processState = state.processState || {};
  const probeResult = state.probeResult || {};
  return {
    result,
    platform,
    mode: state.mode || "repair",
    codexHome: config.codexHome || "",
    usesDedicatedCodexHome: Boolean(config.usesDedicatedCodexHome),
    credentialFileExists: Boolean(credentials.credentialFileExists),
    credentialFileReopened: Boolean(credentials.credentialFileReopened),
    cliAuthMode: credentials.cliAuthMode || "none",
    loginLogState: credentials.loginLogState || "unknown",
    appServerPort: config.port || 0,
    pidFilePid: processState.pidFilePid || 0,
    listenerPid: processState.listenerPid || 0,
    pidFileState: processState.pidFileState || "unknown",
    appServerIdentityVerified: Boolean(processState.appServerIdentityVerified),
    appServerStarted: Boolean(state.appServerStarted),
    appServerRestarted: Boolean(state.appServerRestarted),
    restartRequired: Boolean(state.restartRequired),
    readyz: Boolean(processState.readyz),
    probeVerified: state.probeVerified === false ? false : Boolean(probeResult.ok),
    modelCount: probeResult.modelCount || 0,
    turnStatus: probeResult.turnStatus || "not_probed",
    replyMatched: Boolean(probeResult.replyMatched),
    events,
  };
}

function recordCredentialEvents(events, credentials) {
  if (credentials.credentialFileReopened) {
    addEvent(events, "PASS", "credentials", "auth.json exists and reopens successfully");
  } else {
    addEvent(events, "FAIL", "credentials", "Dedicated auth.json is missing or invalid", credentials.code);
  }
  if (credentials.cliAuthMode === "chatgpt") {
    addEvent(events, "PASS", "cli-status", "Configured CODEX_HOME is logged in using ChatGPT");
  } else {
    addEvent(events, "FAIL", "cli-status", "Configured CODEX_HOME is not logged in using ChatGPT", credentials.code);
  }
}

function recordProcessEvents(events, state) {
  if (state.pidFileState === "stale") {
    addEvent(events, "STALE", "pid-file", "PID file does not match the real listener");
  }
  if (state.appServerIdentityVerified) {
    addEvent(events, "PASS", "app-server", "App Server listener identity verified");
  } else if (state.code === RESULT_CODES.APP_SERVER_NOT_RUNNING) {
    addEvent(events, "FAIL", "app-server", "No App Server is listening", state.code);
  } else if (state.listenerPid) {
    addEvent(events, "STALE", "app-server", "App Server listener found, but restart identity is unverified");
  } else {
    addEvent(events, "FAIL", "app-server", "App Server listener identity is unverified", state.code);
  }
}

function recordProbeEvent(events, result) {
  if (result.ok) {
    addEvent(events, "PASS", "model-probe", "Real model probe returned CYBERBOSS_AUTH_OK");
  } else {
    addEvent(events, "FAIL", "model-probe", "Real model probe failed", result.code);
  }
}

function addEvent(events, level, stage, message, code = null) {
  events.push({ level, stage, message, ...(code ? { code } : {}) });
}

function isLoginRepairable(code) {
  return [
    RESULT_CODES.AUTH_MISSING,
    RESULT_CODES.AUTH_FILE_INVALID,
    RESULT_CODES.CLI_STATUS_UNAUTHENTICATED,
  ].includes(code);
}

function processDiagnosisCode(state) {
  if (state.code === RESULT_CODES.APP_SERVER_NOT_RUNNING) {
    return state.code;
  }
  if (state.listenerPid && !state.appServerIdentityVerified) {
    return RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED;
  }
  if (state.code === RESULT_CODES.APP_SERVER_IDENTITY_UNVERIFIED) {
    return state.code;
  }
  return null;
}

function summarizeDeviceLogin(login) {
  return {
    deviceLoginCompleted: Boolean(login.deviceLoginCompleted),
    deviceLoginTimedOut: Boolean(login.deviceLoginTimedOut),
    deviceLoginExitCode: login.deviceLoginExitCode ?? null,
  };
}

module.exports = { runCodexAuthWorkflow, buildResult };
