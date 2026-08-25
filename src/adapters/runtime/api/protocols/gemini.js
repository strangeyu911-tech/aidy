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
  performJsonRequest,
  performStreamRequest,
  protocolError,
  textContent,
} = require("../protocol-client");

function createGeminiClient(args) {
  const requestContext = context(args.profile, args.secrets, args.fetchImpl, args.capture);
  return {
    listModels: ({ signal } = {}) => listModels(requestContext, signal),
    streamTurn: (turn) => streamTurn(requestContext, turn || {}),
  };
}

async function listModels(requestContext, signal) {
  const body = await performJsonRequest(requestContext, {
    url: joinUrl(requestContext.profile.baseUrl, "models"),
    headers: geminiHeaders(requestContext),
    signal,
  });
  if (!Array.isArray(body?.models)) throw protocolError("INCOMPATIBLE_PROTOCOL", "Gemini returned an incompatible model catalog.");
  return normalizeModels(body.models, requestContext.profile.providerId);
}

async function streamTurn(requestContext, { messages = [], tools = [], signal, onDelta } = {}) {
  const normalizedMessages = messages.map(normalizeMessage);
  const normalizedTools = normalizeTools(tools);
  const systemText = normalizedMessages.filter((message) => message.role === "system").map(textContent).join("\n\n");
  const body = { contents: geminiContents(normalizedMessages.filter((message) => message.role !== "system")) };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (normalizedTools.length) {
    body.tools = [{ functionDeclarations: normalizedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })) }];
  }
  const generationConfig = {};
  if (requestContext.profile.options?.temperature !== undefined) generationConfig.temperature = requestContext.profile.options.temperature;
  if (requestContext.profile.options?.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = requestContext.profile.options.maxOutputTokens;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  return performStreamRequest(requestContext, {
    url: `${joinUrl(requestContext.profile.baseUrl, `models/${encodeURIComponent(requestContext.profile.modelId)}:streamGenerateContent`)}?alt=sse`,
    headers: geminiHeaders(requestContext),
    body,
    signal,
  }, async (response, requestState) => {
    assertContentType(response, ["text/event-stream"]);
    let text = "";
    const calls = [];
    let usage = {};
    for await (const event of iterateSse(response.body, requestState)) {
      const value = parseProtocolJson(event.data);
      usage = value.usageMetadata ? {
        inputTokens: value.usageMetadata.promptTokenCount,
        outputTokens: value.usageMetadata.candidatesTokenCount,
      } : usage;
      for (const candidate of Array.isArray(value.candidates) ? value.candidates : []) {
        for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
          if (typeof part.text === "string") {
            text += part.text;
            emitDelta(onDelta, part.text);
          }
          if (part.functionCall?.name) {
            calls.push({
              id: part.functionCall.id || `gemini-call-${calls.length + 1}`,
              name: part.functionCall.name,
              arguments: part.functionCall.args || {},
            });
          }
        }
      }
    }
    return normalizedResult(text, calls, usage);
  });
}

function geminiContents(messages) {
  const result = [];
  const callNames = new Map();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls) callNames.set(call.id, call.name);
  }
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: message.name || callNames.get(message.toolCallId) || message.toolCallId,
            response: { result: textContent(message) },
          },
        }],
      });
      continue;
    }
    const parts = [];
    if (textContent(message)) parts.push({ text: textContent(message) });
    if (message.role === "assistant") {
      for (const call of message.toolCalls) parts.push({ functionCall: { name: call.name, args: call.arguments, id: call.id } });
    }
    result.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  return result;
}

function geminiHeaders(requestContext) {
  const apiKey = typeof requestContext.secrets.apiKey === "string" ? requestContext.secrets.apiKey.trim() : "";
  return jsonHeaders({
    ...customHeaders(requestContext.profile, requestContext.secrets),
    ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
  });
}

module.exports = { createGeminiClient };
