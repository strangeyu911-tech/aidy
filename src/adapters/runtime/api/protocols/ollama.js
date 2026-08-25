"use strict";

const {
  assertContentType,
  context,
  customHeaders,
  emitDelta,
  iterateJsonLines,
  imageContent,
  joinUrl,
  jsonHeaders,
  normalizeMessages,
  normalizeModels,
  normalizeTools,
  normalizedResult,
  performJsonRequest,
  performStreamRequest,
  textContent,
} = require("../protocol-client");

function createOllamaClient(args) {
  const requestContext = context(args.profile, args.secrets, args.fetchImpl, args.capture);
  return {
    listModels: ({ signal } = {}) => listModels(requestContext, signal),
    streamTurn: (turn) => streamTurn(requestContext, turn || {}),
  };
}

async function listModels(requestContext, signal) {
  const body = await performJsonRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "api/tags"),
    headers: ollamaHeaders(requestContext),
    signal,
  });
  return normalizeModels(Array.isArray(body?.models) ? body.models : [], requestContext.profile.providerId);
}

async function streamTurn(requestContext, { messages = [], tools = [], signal, onDelta } = {}) {
  const normalizedMessages = await normalizeMessages(messages);
  const normalizedTools = normalizeTools(tools);
  const body = {
    model: requestContext.profile.modelId,
    messages: normalizedMessages.map(ollamaMessage),
    stream: true,
  };
  if (normalizedTools.length) body.tools = normalizedTools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  if (requestContext.profile.options?.temperature !== undefined) body.options = { temperature: requestContext.profile.options.temperature };

  return performStreamRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "api/chat"),
    headers: ollamaHeaders(requestContext),
    body,
    signal,
  }, async (response, requestState) => {
    assertContentType(response, ["application/x-ndjson", "application/json"]);
    let text = "";
    const calls = [];
    let usage = {};
    for await (const value of iterateJsonLines(response.body, requestState)) {
      if (value?.error) throw Object.assign(new Error("Ollama reported a streamed error."), { code: "INCOMPATIBLE_PROTOCOL" });
      const delta = typeof value?.message?.content === "string" ? value.message.content : "";
      text += delta;
      emitDelta(onDelta, delta);
      for (const call of Array.isArray(value?.message?.tool_calls) ? value.message.tool_calls : []) {
        calls.push({
          id: call.id || `ollama-call-${calls.length + 1}`,
          name: call.function?.name,
          arguments: call.function?.arguments || {},
        });
      }
      if (value?.done) usage = { inputTokens: value.prompt_eval_count, outputTokens: value.eval_count };
    }
    return normalizedResult(text, calls, usage);
  });
}

function ollamaMessage(message) {
  if (message.role === "tool") {
    return { role: "tool", content: textContent(message), tool_call_id: message.toolCallId };
  }
  const result = { role: message.role, content: textContent(message) };
  const images = imageContent(message);
  if (images.length) result.images = images.map((image) => image.data);
  if (message.role === "assistant" && message.toolCalls.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return result;
}

function ollamaHeaders(requestContext) {
  return jsonHeaders(customHeaders(requestContext.profile, requestContext.secrets));
}

module.exports = { createOllamaClient };
