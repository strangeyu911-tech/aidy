"use strict";

const {
  assertContentType,
  context,
  customHeaders,
  emitDelta,
  iterateSse,
  imageContent,
  joinUrl,
  jsonHeaders,
  normalizeMessages,
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

function createOpenAiChatClient(args) {
  const requestContext = context(args.profile, args.secrets, args.fetchImpl, args.capture);
  return {
    listModels: ({ signal } = {}) => listOpenAiModels(requestContext, signal),
    streamTurn: (turn) => streamChatTurn(requestContext, turn || {}),
  };
}

function createOpenAiResponsesClient(args) {
  const requestContext = context(args.profile, args.secrets, args.fetchImpl, args.capture);
  return {
    listModels: ({ signal } = {}) => listOpenAiModels(requestContext, signal),
    streamTurn: (turn) => streamResponsesTurn(requestContext, turn || {}),
  };
}

async function listOpenAiModels(requestContext, signal) {
  const body = await performJsonRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "models"),
    headers: authorizationHeaders(requestContext),
    signal,
  });
  if (!Array.isArray(body?.data)) throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider returned an incompatible model catalog.");
  return normalizeModels(body.data, requestContext.profile.providerId);
}

async function streamChatTurn(requestContext, { messages = [], tools = [], signal, onDelta } = {}) {
  const normalizedMessages = await normalizeMessages(messages);
  const normalizedTools = normalizeTools(tools);
  const body = {
    model: requestContext.profile.modelId,
    messages: normalizedMessages.map(chatMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (normalizedTools.length) body.tools = normalizedTools.map(openAiChatTool);
  applyProfileOptions(body, requestContext.profile.options);

  return performStreamRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "chat/completions"),
    headers: authorizationHeaders(requestContext),
    body,
    signal,
  }, async (response, requestState) => {
    assertContentType(response, ["text/event-stream"]);
    let text = "";
    let usage = {};
    const calls = new Map();
    for await (const event of iterateSse(response.body, requestState)) {
      if (event.data === "[DONE]") break;
      const chunk = parseProtocolJson(event.data);
      if (chunk?.error) throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider emitted an error inside the response stream.");
      if (chunk?.usage) usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
      for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
        const delta = choice?.delta || {};
        const textDelta = typeof delta.content === "string" ? delta.content : "";
        if (textDelta) {
          text += textDelta;
          emitDelta(onDelta, textDelta);
        }
        collectChatToolCalls(calls, delta.tool_calls);
      }
    }
    return normalizedResult(text, finalizeToolCalls(calls), usage);
  });
}

async function streamResponsesTurn(requestContext, { messages = [], tools = [], signal, onDelta } = {}) {
  const normalizedMessages = await normalizeMessages(messages);
  const normalizedTools = normalizeTools(tools);
  const body = {
    model: requestContext.profile.modelId,
    input: responsesInput(normalizedMessages),
    stream: true,
  };
  if (normalizedTools.length) body.tools = normalizedTools.map(openAiResponsesTool);
  applyProfileOptions(body, requestContext.profile.options);

  return performStreamRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "responses"),
    headers: authorizationHeaders(requestContext),
    body,
    signal,
  }, async (response, requestState) => {
    assertContentType(response, ["text/event-stream"]);
    let text = "";
    let usage = {};
    const calls = new Map();
    for await (const event of iterateSse(response.body, requestState)) {
      if (event.data === "[DONE]") break;
      const value = parseProtocolJson(event.data);
      const type = value.type || event.event;
      if (type === "response.output_text.delta") {
        const delta = typeof value.delta === "string" ? value.delta : "";
        text += delta;
        emitDelta(onDelta, delta);
      } else if (type === "response.output_item.added" && value.item?.type === "function_call") {
        const index = value.output_index ?? calls.size;
        calls.set(index, {
          id: value.item.call_id || value.item.id || `call-${index + 1}`,
          name: value.item.name || "",
          argumentsText: typeof value.item.arguments === "string" ? value.item.arguments : "",
        });
      } else if (type === "response.function_call_arguments.delta") {
        const index = value.output_index ?? 0;
        const existing = calls.get(index) || { id: value.call_id || `call-${index + 1}`, name: value.name || "", argumentsText: "" };
        existing.argumentsText += typeof value.delta === "string" ? value.delta : "";
        calls.set(index, existing);
      } else if (type === "response.output_item.done" && value.item?.type === "function_call") {
        const index = value.output_index ?? calls.size;
        const existing = calls.get(index) || { id: value.item.call_id || value.item.id || `call-${index + 1}`, name: value.item.name || "", argumentsText: "" };
        existing.id = value.item.call_id || value.item.id || existing.id;
        existing.name = value.item.name || existing.name;
        if (typeof value.item.arguments === "string" && !existing.argumentsText) existing.argumentsText = value.item.arguments;
        calls.set(index, existing);
      } else if (type === "response.completed") {
        usage = {
          inputTokens: value.response?.usage?.input_tokens,
          outputTokens: value.response?.usage?.output_tokens,
        };
      } else if (type === "response.failed" || type === "error") {
        throw protocolError("INCOMPATIBLE_PROTOCOL", "The provider reported a failed streamed response.");
      }
    }
    return normalizedResult(text, finalizeToolCalls(calls), usage);
  });
}

function chatMessage(message) {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: textContent(message) };
  }
  const images = imageContent(message);
  const result = {
    role: message.role,
    content: images.length
      ? [
          ...(textContent(message) ? [{ type: "text", text: textContent(message) }] : []),
          ...images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
        ]
      : textContent(message),
  };
  if (message.role === "assistant" && message.toolCalls.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return result;
}

function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: textContent(message) });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls.length) {
      if (textContent(message)) input.push({ role: "assistant", content: [{ type: "output_text", text: textContent(message) }] });
      for (const call of message.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
      }
      continue;
    }
    const images = imageContent(message);
    input.push({
      role: message.role,
      content: [
        ...(textContent(message) ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: textContent(message) }] : []),
        ...images.map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` })),
      ],
    });
  }
  return input;
}

function openAiChatTool(tool) {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function openAiResponsesTool(tool) {
  return { type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false };
}

function collectChatToolCalls(calls, values) {
  for (const value of Array.isArray(values) ? values : []) {
    const index = Number.isSafeInteger(value?.index) ? value.index : calls.size;
    const existing = calls.get(index) || { id: `call-${index + 1}`, name: "", argumentsText: "" };
    if (value?.id) existing.id = value.id;
    if (value?.function?.name) existing.name += value.function.name;
    if (typeof value?.function?.arguments === "string") existing.argumentsText += value.function.arguments;
    calls.set(index, existing);
  }
}

function finalizeToolCalls(calls) {
  return [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => ({
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.argumentsText),
  }));
}

function authorizationHeaders(requestContext) {
  const apiKey = typeof requestContext.secrets.apiKey === "string" ? requestContext.secrets.apiKey.trim() : "";
  return jsonHeaders({
    ...customHeaders(requestContext.profile, requestContext.secrets),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  });
}

function applyProfileOptions(body, options) {
  const safeKeys = ["temperature", "top_p", "max_tokens", "max_output_tokens", "reasoning_effort"];
  for (const key of safeKeys) {
    if (options && options[key] !== undefined) body[key] = options[key];
  }
}

module.exports = { createOpenAiChatClient, createOpenAiResponsesClient };
