"use strict";

const {
  assertContentType,
  context,
  customHeaders,
  emitDelta,
  iterateSse,
  joinUrl,
  jsonHeaders,
  normalizeMessage,
  normalizeModels,
  normalizeTools,
  normalizedResult,
  parseProtocolJson,
  parseToolArguments,
  performJsonRequest,
  performStreamRequest,
  protocolError,
  textContent,
} = require("../protocol-client");

function createAnthropicClient(args) {
  const requestContext = context(args.profile, args.secrets, args.fetchImpl, args.capture);
  return {
    listModels: ({ signal } = {}) => listModels(requestContext, signal),
    streamTurn: (turn) => streamTurn(requestContext, turn || {}),
  };
}

async function listModels(requestContext, signal) {
  const body = await performJsonRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "v1/models"),
    headers: anthropicHeaders(requestContext),
    signal,
  });
  if (!Array.isArray(body?.data)) throw protocolError("INCOMPATIBLE_PROTOCOL", "Anthropic returned an incompatible model catalog.");
  return normalizeModels(body.data, requestContext.profile.providerId);
}

async function streamTurn(requestContext, { messages = [], tools = [], signal, onDelta } = {}) {
  const normalizedMessages = messages.map(normalizeMessage);
  const normalizedTools = normalizeTools(tools);
  const system = normalizedMessages.filter((message) => message.role === "system").map(textContent).join("\n\n");
  const body = {
    model: requestContext.profile.modelId,
    messages: anthropicMessages(normalizedMessages.filter((message) => message.role !== "system")),
    max_tokens: positiveInteger(requestContext.profile.options?.max_tokens, 1_024),
    stream: true,
  };
  if (system) body.system = system;
  if (normalizedTools.length) body.tools = normalizedTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

  return performStreamRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "v1/messages"),
    headers: anthropicHeaders(requestContext),
    body,
    signal,
  }, async (response, requestState) => {
    assertContentType(response, ["text/event-stream"]);
    let text = "";
    const usage = {};
    const calls = new Map();
    for await (const event of iterateSse(response.body, requestState)) {
      const value = parseProtocolJson(event.data);
      const type = value.type || event.event;
      if (type === "message_start") usage.inputTokens = value.message?.usage?.input_tokens;
      else if (type === "content_block_start" && value.content_block?.type === "tool_use") {
        calls.set(value.index, {
          id: value.content_block.id || `call-${value.index + 1}`,
          name: value.content_block.name || "",
          argumentsText: Object.keys(value.content_block.input || {}).length ? JSON.stringify(value.content_block.input) : "",
        });
      } else if (type === "content_block_delta" && value.delta?.type === "text_delta") {
        const delta = typeof value.delta.text === "string" ? value.delta.text : "";
        text += delta;
        emitDelta(onDelta, delta);
      } else if (type === "content_block_delta" && value.delta?.type === "input_json_delta") {
        const existing = calls.get(value.index) || { id: `call-${value.index + 1}`, name: "", argumentsText: "" };
        existing.argumentsText += typeof value.delta.partial_json === "string" ? value.delta.partial_json : "";
        calls.set(value.index, existing);
      } else if (type === "message_delta") {
        if (value.usage?.input_tokens !== undefined) usage.inputTokens = value.usage.input_tokens;
        if (value.usage?.output_tokens !== undefined) usage.outputTokens = value.usage.output_tokens;
      } else if (type === "error") {
        throw protocolError("INCOMPATIBLE_PROTOCOL", "Anthropic reported an error inside the response stream.");
      }
    }
    const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
      id: call.id,
      name: call.name,
      arguments: parseToolArguments(call.argumentsText),
    }));
    return normalizedResult(text, toolCalls, usage);
  });
}

function anthropicMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: textContent(message) };
      const previous = result.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content)) previous.content.push(block);
      else result.push({ role: "user", content: [block] });
      continue;
    }
    const content = [];
    if (textContent(message)) content.push({ type: "text", text: textContent(message) });
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
    }
    result.push({ role: message.role, content });
  }
  return result;
}

function anthropicHeaders(requestContext) {
  const apiKey = typeof requestContext.secrets.apiKey === "string" ? requestContext.secrets.apiKey.trim() : "";
  return jsonHeaders({
    ...customHeaders(requestContext.profile, requestContext.secrets),
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = { createAnthropicClient };
