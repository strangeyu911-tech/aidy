"use strict";

const DEFAULT_MAX_TOOL_STEPS = 8;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

async function runAgentTurn({
  client,
  conversation,
  toolBridge,
  signal,
  emit = () => {},
  limits = {},
  context = {},
  beforeFailure,
} = {}) {
  requireConversation(conversation);
  if (!client || typeof client.streamTurn !== "function") {
    throw new TypeError("runAgentTurn requires a streaming protocol client.");
  }
  if (!toolBridge || typeof toolBridge.listTools !== "function" || typeof toolBridge.invoke !== "function") {
    throw new TypeError("runAgentTurn requires a RuntimeToolBridge-compatible object.");
  }

  const maxToolSteps = Math.min(
    positiveInteger(limits.maxToolSteps, DEFAULT_MAX_TOOL_STEPS),
    DEFAULT_MAX_TOOL_STEPS,
  );
  const timeoutMs = Math.min(
    positiveInteger(limits.timeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    DEFAULT_TURN_TIMEOUT_MS,
  );
  const turnAbort = createTurnAbort(signal, timeoutMs);
  const messages = cloneMessages(conversation.messages);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let toolSteps = 0;
  let modelStep = 0;

  emitEvent(emit, "runtime.turn.started", conversation);
  try {
    while (true) {
      throwIfTurnAborted(turnAbort);
      modelStep += 1;
      const itemId = `${conversation.turnId}-assistant-${modelStep}`;
      const result = await client.streamTurn({
        messages: cloneMessages(messages),
        tools: toolBridge.listTools(),
        signal: turnAbort.controller.signal,
        onDelta(text) {
          const normalized = String(text || "");
          if (!normalized) return;
          emitEvent(emit, "runtime.reply.delta", conversation, { itemId, text: normalized });
        },
      });
      throwIfTurnAborted(turnAbort);
      const assistant = normalizeAssistantResult(result);
      usage.inputTokens += nonNegativeInteger(result?.usage?.inputTokens);
      usage.outputTokens += nonNegativeInteger(result?.usage?.outputTokens);
      await conversation.appendAssistant(assistant);
      messages.push(assistant);

      if (!assistant.toolCalls.length) {
        const text = messageText(assistant);
        emitEvent(emit, "runtime.reply.completed", conversation, { itemId, text });
        emitEvent(emit, "runtime.turn.completed", conversation, { text, usage });
        return {
          threadId: conversation.threadId,
          turnId: conversation.turnId,
          text,
          usage,
          toolSteps,
        };
      }

      for (const call of assistant.toolCalls) {
        toolSteps += 1;
        if (toolSteps > maxToolSteps) {
          throw agentError("TOOL_STEP_LIMIT", `Agent turn exceeded ${maxToolSteps} tool steps.`);
        }
        const value = await toolBridge.invoke({
          call,
          context: { ...context, threadId: conversation.threadId, turnId: conversation.turnId },
          signal: turnAbort.controller.signal,
        });
        const toolResult = {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: [{ type: "text", text: serializeToolResult(value) }],
        };
        await conversation.appendToolResult(toolResult);
        messages.push(toolResult);
      }
    }
  } catch (error) {
    const failure = normalizeTurnError(error, turnAbort);
    await Promise.resolve(conversation.abort()).catch(() => {});
    if (typeof beforeFailure === "function") await beforeFailure(failure);
    emitEvent(emit, "runtime.turn.failed", conversation, {
      code: failure.code || "RUNTIME_ERROR",
      text: failure.message,
    });
    throw failure;
  } finally {
    turnAbort.cleanup();
  }
}

function normalizeAssistantResult(result) {
  const source = isRecord(result?.message) ? result.message : {};
  return {
    ...source,
    role: "assistant",
    content: source.content ?? "",
    toolCalls: (Array.isArray(result?.toolCalls) ? result.toolCalls : [])
      .map((call, index) => ({
        id: normalizeText(call?.id) || `call-${index + 1}`,
        name: normalizeText(call?.name),
        arguments: isRecord(call?.arguments) ? call.arguments : {},
      }))
      .filter((call) => call.name),
  };
}

function createTurnAbort(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let reason = "";
  const onParentAbort = () => {
    reason = "cancelled";
    controller.abort();
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, timeoutMs);
  return {
    controller,
    get reason() { return reason; },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.("abort", onParentAbort);
    },
  };
}

function throwIfTurnAborted(turnAbort) {
  if (!turnAbort.controller.signal.aborted) return;
  if (turnAbort.reason === "timeout") {
    throw agentError("AGENT_TURN_TIMEOUT", "Agent turn exceeded the overall time limit.");
  }
  throw agentError("CANCELLED", "Agent turn was cancelled.");
}

function normalizeTurnError(error, turnAbort) {
  if (turnAbort.reason === "timeout") {
    return agentError("AGENT_TURN_TIMEOUT", "Agent turn exceeded the overall time limit.");
  }
  if (turnAbort.reason === "cancelled" || error?.name === "AbortError") {
    return agentError("CANCELLED", "Agent turn was cancelled.");
  }
  if (error instanceof Error) return error;
  return agentError("RUNTIME_ERROR", String(error || "The model turn failed."));
}

function emitEvent(emit, type, conversation, extra = {}) {
  emit({
    type,
    payload: {
      threadId: conversation.threadId,
      turnId: conversation.turnId,
      ...extra,
    },
  });
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("");
}

function serializeToolResult(value) {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch {
    throw agentError("TOOL_RESULT_NOT_SERIALIZABLE", "Tool result is not JSON serializable.");
  }
}

function requireConversation(value) {
  const valid = value
    && normalizeText(value.threadId)
    && normalizeText(value.turnId)
    && Array.isArray(value.messages)
    && typeof value.appendAssistant === "function"
    && typeof value.appendToolResult === "function"
    && typeof value.abort === "function";
  if (!valid) throw new TypeError("runAgentTurn requires a writable conversation.");
}

function cloneMessages(value) {
  return JSON.parse(JSON.stringify(Array.isArray(value) ? value : []));
}

function agentError(code, message) {
  return Object.assign(new Error(`${message} [${code}]`), { code });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function nonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  DEFAULT_MAX_TOOL_STEPS,
  DEFAULT_TURN_TIMEOUT_MS,
  runAgentTurn,
};
