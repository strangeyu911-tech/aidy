"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createProtocolClient } = require("../src/adapters/runtime/api/protocol-client");

const weatherTool = {
  name: "weather",
  description: "Read synthetic weather.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

function profile(protocolId, baseUrl, overrides = {}) {
  return {
    id: `${protocolId}-profile`,
    runtimeId: "builtin-api",
    providerId: protocolId === "openai-chat" ? "openrouter" : protocolId.split("-")[0],
    protocolId,
    baseUrl,
    modelId: "synthetic-model",
    options: { overallTimeoutMs: 2_000, chunkTimeoutMs: 500 },
    ...overrides,
  };
}

async function startServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    requests.push(entry);
    await handler(entry, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendChunks(response, contentType, pieces) {
  response.writeHead(200, { "content-type": contentType });
  for (const piece of pieces) response.write(piece);
  response.end();
}

test("openai chat client normalizes incremental UTF-8 text and tool calls", async (t) => {
  const server = await startServer((_request, response) => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"Checking 上海"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Shang"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hai\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const bytes = Buffer.from(payload, "utf8");
    const split = bytes.indexOf(Buffer.from("上海", "utf8")) + 1;
    sendChunks(response, "text/event-stream", [bytes.subarray(0, split), bytes.subarray(split, split + 1), bytes.subarray(split + 1)]);
  });
  t.after(server.close);

  const client = createProtocolClient({
    profile: profile("openai-chat", server.url),
    secrets: { apiKey: "test-key" },
  });
  const deltas = [];
  const result = await client.streamTurn({
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    tools: [weatherTool],
    onDelta: (text) => deltas.push(text),
  });

  assert.equal(deltas.join(""), "Checking 上海");
  assert.equal(result.message.content[0].text, "Checking 上海");
  assert.deepEqual(result.toolCalls[0], { id: "call-1", name: "weather", arguments: { city: "Shanghai" } });
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 4 });
  assert.equal(server.requests[0].url, "/chat/completions");
  assert.equal(server.requests[0].headers.authorization, "Bearer test-key");
  assert.equal(server.requests[0].body.stream, true);
  assert.equal(server.requests[0].body.tools[0].function.name, "weather");
});

test("openai responses client maps response events and continuation input", async (t) => {
  let turn = 0;
  const server = await startServer((_request, response) => {
    turn += 1;
    if (turn === 1) {
      sendChunks(response, "text/event-stream", [
        'event: response.output_text.delta\ndata: {"delta":"Checking"}\n\n',
        'event: response.output_item.added\ndata: {"output_index":1,"item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"output_index":1,"delta":"{\\"city\\":\\"Shanghai\\"}"}\n\n',
        'event: response.completed\ndata: {"response":{"usage":{"input_tokens":5,"output_tokens":3}}}\n\n',
      ]);
      return;
    }
    sendChunks(response, "text/event-stream", [
      'event: response.output_text.delta\ndata: {"delta":"Sunny"}\n\n',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":8,"output_tokens":1}}}\n\n',
    ]);
  });
  t.after(server.close);
  const client = createProtocolClient({ profile: profile("openai-responses", server.url), secrets: { apiKey: "key" } });
  const first = await client.streamTurn({ messages: [{ role: "user", content: "weather" }], tools: [weatherTool] });
  const second = await client.streamTurn({
    messages: [
      { role: "user", content: "weather" },
      { ...first.message, toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "25 C" }] },
    ],
    tools: [weatherTool],
  });

  assert.deepEqual(first.toolCalls[0], { id: "call-1", name: "weather", arguments: { city: "Shanghai" } });
  assert.equal(second.message.content[0].text, "Sunny");
  assert.equal(server.requests[0].url, "/responses");
  assert.equal(server.requests[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "call-1"), true);
});

test("anthropic client maps text, tool use, and tool-result continuation", async (t) => {
  let turn = 0;
  const server = await startServer((_request, response) => {
    turn += 1;
    sendChunks(response, "text/event-stream", turn === 1 ? [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Shanghai\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":6,"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ] : [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sunny"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
  });
  t.after(server.close);
  const client = createProtocolClient({ profile: profile("anthropic-messages", server.url), secrets: { apiKey: "anthropic-key" } });
  const first = await client.streamTurn({ messages: [{ role: "user", content: "weather" }], tools: [weatherTool] });
  await client.streamTurn({
    messages: [{ role: "user", content: "weather" }, { ...first.message, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-a", content: "25 C" }],
    tools: [weatherTool],
  });
  assert.deepEqual(first.toolCalls[0], { id: "call-a", name: "weather", arguments: { city: "Shanghai" } });
  assert.equal(server.requests[0].headers["x-api-key"], "anthropic-key");
  assert.equal(server.requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(server.requests[1].body.messages.at(-1).content[0].type, "tool_result");
});

test("gemini client maps SSE candidates and function responses", async (t) => {
  let turn = 0;
  const server = await startServer((_request, response) => {
    turn += 1;
    sendChunks(response, "text/event-stream", turn === 1 ? [
      'data: {"candidates":[{"content":{"parts":[{"text":"Checking"},{"functionCall":{"name":"weather","args":{"city":"Shanghai"},"id":"call-g"}}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    ] : ['data: {"candidates":[{"content":{"parts":[{"text":"Sunny"}]}}]}\n\n']);
  });
  t.after(server.close);
  const client = createProtocolClient({ profile: profile("gemini", server.url), secrets: { apiKey: "gemini-key" } });
  const first = await client.streamTurn({ messages: [{ role: "user", content: "weather" }], tools: [weatherTool] });
  await client.streamTurn({
    messages: [{ role: "user", content: "weather" }, { ...first.message, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-g", name: "weather", content: "25 C" }],
    tools: [weatherTool],
  });
  assert.deepEqual(first.toolCalls[0], { id: "call-g", name: "weather", arguments: { city: "Shanghai" } });
  assert.match(server.requests[0].url, /^\/models\/synthetic-model:streamGenerateContent\?alt=sse$/);
  assert.equal(server.requests[0].headers["x-goog-api-key"], "gemini-key");
  assert.equal(server.requests[1].body.contents.at(-1).parts[0].functionResponse.name, "weather");
});

test("ollama client maps newline-delimited JSON text and tool calls", async (t) => {
  const server = await startServer((_request, response) => {
    sendChunks(response, "application/x-ndjson", [
      '{"message":{"role":"assistant","content":"Checking"},"done":false}\n',
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"weather","arguments":{"city":"Shanghai"}}}]},"done":false}\n',
      '{"done":true,"prompt_eval_count":3,"eval_count":2}\n',
    ]);
  });
  t.after(server.close);
  const client = createProtocolClient({ profile: profile("ollama", server.url), secrets: {} });
  const result = await client.streamTurn({ messages: [{ role: "user", content: "weather" }], tools: [weatherTool] });
  assert.equal(result.message.content[0].text, "Checking");
  assert.deepEqual(result.toolCalls[0].name, "weather");
  assert.deepEqual(result.toolCalls[0].arguments, { city: "Shanghai" });
  assert.match(result.toolCalls[0].id, /^ollama-call-/);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
  assert.equal(server.requests[0].url, "/api/chat");
});

test("every built-in protocol materializes saved image attachments only at request time", async (t) => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/chat") {
      sendChunks(response, "application/x-ndjson", ['{"message":{"content":"ok"},"done":true}\n']);
    } else if (request.url === "/v1/messages") {
      sendChunks(response, "text/event-stream", ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n']);
    } else if (request.url.includes(":streamGenerateContent")) {
      sendChunks(response, "text/event-stream", ['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']);
    } else if (request.url === "/responses") {
      sendChunks(response, "text/event-stream", [
        'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
        'event: response.completed\ndata: {"response":{"usage":{}}}\n\n',
      ]);
    } else {
      sendChunks(response, "text/event-stream", ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n']);
    }
  });
  t.after(server.close);
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-protocol-image-"));
  const imagePath = path.join(imageDir, "pixel.png");
  const imageBytes = Buffer.from("synthetic-image-bytes");
  fs.writeFileSync(imagePath, imageBytes);
  const attachment = { filePath: imagePath, contentType: "image/png", isImage: true };

  for (const protocolId of ["openai-chat", "openai-responses", "anthropic-messages", "gemini", "ollama"]) {
    const client = createProtocolClient({ profile: profile(protocolId, server.url), secrets: {} });
    await client.streamTurn({ messages: [{ role: "user", content: "describe", attachments: [attachment] }] });
  }

  const base64 = imageBytes.toString("base64");
  assert.equal(server.requests[0].body.messages[0].content[1].image_url.url, `data:image/png;base64,${base64}`);
  assert.equal(server.requests[1].body.input[0].content[1].image_url, `data:image/png;base64,${base64}`);
  assert.deepEqual(server.requests[2].body.messages[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: base64 },
  });
  assert.deepEqual(server.requests[3].body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: base64 } });
  assert.deepEqual(server.requests[4].body.messages[0].images, [base64]);
  assert.equal(JSON.stringify([{ role: "user", content: "describe", attachments: [attachment] }]).includes(base64), false);
});

test("listModels uses each provider's live endpoint and normalized model shape", async (t) => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/api/tags"
      ? { models: [{ name: "llama3.2", details: { families: ["llama"] } }] }
      : { data: [{ id: "synthetic-model", name: "Synthetic", input_modalities: ["text"] }] }));
  });
  t.after(server.close);
  const openAi = createProtocolClient({ profile: profile("openai-chat", server.url), secrets: {} });
  const ollama = createProtocolClient({ profile: profile("ollama", server.url), secrets: {} });
  assert.deepEqual((await openAi.listModels({}))[0], {
    id: "synthetic-model", name: "Synthetic", providerId: "openrouter", inputModalities: ["text"], contextWindow: null,
  });
  assert.equal((await ollama.listModels({}))[0].id, "llama3.2");
});

test("HTTP and transport failures receive strict non-secret error codes", async (t) => {
  const cases = [
    [401, "denied", "INVALID_CREDENTIALS"],
    [403, "denied", "INVALID_CREDENTIALS"],
    [404, "missing", "MODEL_UNAVAILABLE"],
    [429, "slow down", "RATE_LIMITED"],
    [429, "insufficient quota or credits", "QUOTA_EXHAUSTED"],
    [503, "unavailable", "MODEL_SERVICE_UNAVAILABLE"],
  ];
  for (const [status, body, code] of cases) {
    await t.test(`${status}-${code}`, async (subtest) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `${body} test-key` } }));
      });
      subtest.after(server.close);
      const client = createProtocolClient({ profile: profile("openai-chat", server.url), secrets: { apiKey: "test-key" } });
      await assert.rejects(
        client.streamTurn({ messages: [{ role: "user", content: "ping" }], tools: [] }),
        (error) => error.code === code && !error.message.includes("test-key"),
      );
    });
  }
});

test("malformed streams, caller cancellation, overall timeout, and chunk timeout are distinct", async (t) => {
  const malformed = await startServer((_request, response) => sendChunks(response, "text/event-stream", ["data: not-json\n\n"]));
  t.after(malformed.close);
  await assert.rejects(
    createProtocolClient({ profile: profile("openai-chat", malformed.url), secrets: {} }).streamTurn({ messages: [{ role: "user", content: "ping" }] }),
    (error) => error.code === "INCOMPATIBLE_PROTOCOL",
  );

  const wrongContentType = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [] }));
  });
  t.after(wrongContentType.close);
  await assert.rejects(
    createProtocolClient({ profile: profile("openai-chat", wrongContentType.url), secrets: {} }).streamTurn({ messages: [{ role: "user", content: "ping" }] }),
    (error) => error.code === "INCOMPATIBLE_PROTOCOL",
  );

  const delayed = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    setTimeout(() => response.end('data: {"choices":[]}\n\n'), 250);
  });
  t.after(delayed.close);
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 10);
  await assert.rejects(
    createProtocolClient({ profile: profile("openai-chat", delayed.url), secrets: {} }).streamTurn({ messages: [{ role: "user", content: "ping" }], signal: abortController.signal }),
    (error) => error.code === "CANCELLED",
  );
  await assert.rejects(
    createProtocolClient({ profile: profile("openai-chat", delayed.url, { options: { overallTimeoutMs: 25, chunkTimeoutMs: 500 } }), secrets: {} }).streamTurn({ messages: [{ role: "user", content: "ping" }] }),
    (error) => error.code === "MODEL_SERVICE_TIMEOUT",
  );
  await assert.rejects(
    createProtocolClient({ profile: profile("openai-chat", delayed.url, { options: { overallTimeoutMs: 500, chunkTimeoutMs: 25 } }), secrets: {} }).streamTurn({ messages: [{ role: "user", content: "ping" }] }),
    (error) => error.code === "MODEL_SERVICE_TIMEOUT",
  );
});

test("unsupported protocols fail explicitly and never fall back to Codex", () => {
  assert.throws(
    () => createProtocolClient({ profile: profile("codex", "http://127.0.0.1:1"), secrets: {} }),
    (error) => error.code === "UNSUPPORTED_PROTOCOL",
  );
});

test("rejected asynchronous diagnostic capture never fails a successful provider request", async (t) => {
  const server = await startServer((_request, response) => {
    sendChunks(response, "text/event-stream", [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  });
  t.after(server.close);

  for (const captureKind of ["function", "object"]) {
    await t.test(captureKind, async () => {
      let handledRejections = 0;
      const rejectCapture = () => {
        const rejected = Promise.reject(new Error("synthetic capture failure"));
        const originalThen = rejected.then.bind(rejected);
        rejected.then = (onFulfilled, onRejected) => {
          if (typeof onRejected === "function") handledRejections += 1;
          return originalThen(onFulfilled, onRejected);
        };
        return rejected;
      };
      const capture = captureKind === "function" ? rejectCapture : { record: rejectCapture };
      const client = createProtocolClient({
        profile: profile("openai-chat", server.url),
        secrets: {},
        capture,
      });

      const result = await client.streamTurn({ messages: [{ role: "user", content: "ping" }] });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(result.message.content[0].text, "ok");
      assert.equal(handledRejections, 2);
    });
  }
});
