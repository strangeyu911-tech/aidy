const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");

test("codex rpc client uses turn/interrupt for stop requests", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.cancelTurn({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
});

test("codex rpc client sends image attachments as local images", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "what is this image?",
    attachments: [{
      absolutePath: path.join("/tmp", "cyberboss image.jpg"),
      contentType: "image/jpeg",
    }],
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "what is this image?" },
    {
      type: "localImage",
      path: path.join("/tmp", "cyberboss image.jpg"),
    },
  ]);
});

test("codex verification turns use a read-only sandbox with no approval escalation", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765", extraWritableRoots: ["/must-not-be-writable"] });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-verify" } } };
  };
  await client.sendUserMessage({
    threadId: "thread-verify",
    text: "verify",
    workspaceRoot: "/isolated",
    accessMode: "verification-read-only",
  });
  assert.equal(calls[0].params.approvalPolicy, "never");
  assert.deepEqual(calls[0].params.sandboxPolicy, { type: "readOnly" });
});
