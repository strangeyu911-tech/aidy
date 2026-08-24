const { CodexRpcClient } = require("../../adapters/runtime/codex/rpc-client");
const {
  extractAssistantText,
  extractThreadId,
  extractThreadIdFromParams,
  isAssistantItemCompleted,
} = require("../../adapters/runtime/codex/message-utils");
const { RESULT_CODES } = require("./result-codes");

const EXPECTED_REPLY = "CYBERBOSS_AUTH_OK";
const PROBE_PROMPT = "Reply with exactly CYBERBOSS_AUTH_OK and nothing else.";

async function runAppServerProbe({ endpoint, cwd, timeoutMs = 120_000 }, {
  clientFactory = (options) => new CodexRpcClient(options),
} = {}) {
  const client = clientFactory({ endpoint });
  let threadId = "";
  let cleanupWarning = "";
  let completion = null;
  let outcome = null;
  try {
    await client.connect();
    await client.initialize();
    const models = await client.listModels();
    const modelCount = Array.isArray(models?.result?.data) ? models.result.data.length : 0;
    if (modelCount < 1) {
      outcome = {
        ok: false,
        code: RESULT_CODES.APP_SERVER_TURN_FAILED,
        modelCount,
        turnStatus: "not_started",
        replyMatched: false,
      };
      return outcome;
    }

    const started = await client.startThread({ cwd });
    threadId = extractThreadId(started) || "";
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    completion = waitForProbeCompletion(client, threadId, timeoutMs);
    await client.sendUserMessage({
      threadId,
      text: PROBE_PROMPT,
      workspaceRoot: cwd,
    });
    const completed = await completion;
    if (completed.turnStatus !== "completed") {
      outcome = {
        ok: false,
        code: isUnauthorized(completed.failureText)
          ? RESULT_CODES.APP_SERVER_UNAUTHORIZED
          : RESULT_CODES.APP_SERVER_TURN_FAILED,
        modelCount,
        threadId,
        turnStatus: completed.turnStatus,
        replyMatched: false,
      };
      return outcome;
    }
    const replyMatched = completed.reply.trim() === EXPECTED_REPLY;
    outcome = {
      ok: replyMatched,
      code: replyMatched ? null : RESULT_CODES.APP_SERVER_REPLY_MISMATCH,
      modelCount,
      threadId,
      turnStatus: completed.turnStatus,
      replyMatched,
    };
    return outcome;
  } catch (error) {
    completion?.cancel?.();
    outcome = {
      ok: false,
      code: isUnauthorized(error?.message)
        ? RESULT_CODES.APP_SERVER_UNAUTHORIZED
        : RESULT_CODES.APP_SERVER_TURN_FAILED,
      threadId,
      modelCount: 0,
      turnStatus: "failed",
      replyMatched: false,
      errorSummary: sanitizeError(error),
    };
    return outcome;
  } finally {
    if (threadId) {
      try {
        await client.sendRequest("thread/archive", { threadId });
      } catch {
        cleanupWarning = `Probe thread ${threadId} could not be archived`;
      }
    }
    try {
      await client.close();
    } catch {
      // best effort
    }
    if (cleanupWarning) {
      if (outcome) {
        outcome.cleanupWarning = cleanupWarning;
      }
    }
  }
}

function waitForProbeCompletion(client, threadId, timeoutMs) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const replyParts = [];
    const finish = (value, error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(null, new Error("Codex authentication probe timed out")), timeoutMs);
    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }
      if (isAssistantItemCompleted(message)) {
        const text = extractAssistantText(params);
        if (text) {
          replyParts.push(text);
        }
        return;
      }
      if (message?.method === "turn/failed") {
        finish({
          turnStatus: "failed",
          reply: replyParts.join("\n").trim(),
          failureText: extractFailureMessage(params),
        });
        return;
      }
      if (message?.method === "turn/completed") {
        const turnStatus = String(params?.turn?.status || "unknown").trim().toLowerCase();
        finish({
          turnStatus,
          reply: replyParts.join("\n").trim(),
          failureText: extractFailureMessage(params),
        });
      }
    });
    cancel = () => finish({ turnStatus: "cancelled", reply: "", failureText: "" });
  });
  promise.cancel = () => cancel();
  return promise;
}

function extractFailureMessage(params) {
  return String(params?.turn?.error?.message || params?.error?.message || "");
}

function isUnauthorized(value) {
  return /\b401\b|unauthorized|not authenticated/i.test(String(value || ""));
}

function sanitizeError(error) {
  const message = String(error?.message || error || "Unknown probe failure");
  return message.replace(/(token|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500);
}

module.exports = {
  EXPECTED_REPLY,
  PROBE_PROMPT,
  runAppServerProbe,
  waitForProbeCompletion,
  isUnauthorized,
};
