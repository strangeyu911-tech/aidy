const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { runAppServerProbe, EXPECTED_REPLY } = require("../src/diagnostics/codex-auth/app-server-probe");
const { RESULT_CODES } = require("../src/diagnostics/codex-auth/result-codes");

class FakeClient {
  constructor({ status = "completed", reply = EXPECTED_REPLY, errorMessage = "" } = {}) {
    this.emitter = new EventEmitter();
    this.status = status;
    this.reply = reply;
    this.errorMessage = errorMessage;
    this.archived = false;
  }
  async connect() {}
  async initialize() {}
  async listModels() { return { result: { data: [{ id: "model" }] } }; }
  async startThread() { return { result: { thread: { id: "thread-1" } } }; }
  onMessage(listener) { this.emitter.on("message", listener); return () => this.emitter.off("message", listener); }
  async sendUserMessage() {
    queueMicrotask(() => {
      if (this.reply) {
        this.emitter.emit("message", {
          method: "item/completed",
          params: { threadId: "thread-1", item: { type: "agentMessage", text: this.reply } },
        });
      }
      this.emitter.emit("message", {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { status: this.status, error: this.errorMessage ? { message: this.errorMessage } : null },
        },
      });
    });
    return { result: { turn: { id: "turn-1" } } };
  }
  async sendRequest(method) { if (method === "thread/archive") this.archived = true; }
  async close() {}
}

test("Real App Server probe requires models, completed status and exact reply", async () => {
  const fake = new FakeClient();
  const result = await runAppServerProbe({ endpoint: "ws://127.0.0.1:8765", cwd: "C:\\work" }, {
    clientFactory: () => fake,
  });
  assert.equal(result.ok, true);
  assert.equal(result.modelCount, 1);
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.replyMatched, true);
  assert.equal(fake.archived, true);
});

test("Probe does not mistake a failed turn/completed event for success", async () => {
  const fake = new FakeClient({ status: "failed", reply: "", errorMessage: "401 Unauthorized" });
  const result = await runAppServerProbe({ endpoint: "ws://127.0.0.1:8765", cwd: "C:\\work" }, {
    clientFactory: () => fake,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, RESULT_CODES.APP_SERVER_UNAUTHORIZED);
  assert.equal(result.turnStatus, "failed");
});

test("Probe rejects a completed turn with an inexact reply", async () => {
  const result = await runAppServerProbe({ endpoint: "ws://127.0.0.1:8765", cwd: "C:\\work" }, {
    clientFactory: () => new FakeClient({ reply: `${EXPECTED_REPLY}.` }),
  });
  assert.equal(result.code, RESULT_CODES.APP_SERVER_REPLY_MISMATCH);
  assert.equal(result.replyMatched, false);
});

test("Probe never assumes completed when turn/completed omits status", async () => {
  const fake = new FakeClient({ status: undefined, reply: EXPECTED_REPLY });
  fake.sendUserMessage = async function sendUserMessage() {
    queueMicrotask(() => {
      this.emitter.emit("message", {
        method: "item/completed",
        params: { threadId: "thread-1", item: { type: "agentMessage", text: this.reply } },
      });
      this.emitter.emit("message", {
        method: "turn/completed",
        params: { threadId: "thread-1", turn: {} },
      });
    });
  };
  const result = await runAppServerProbe({ endpoint: "ws://127.0.0.1:8765", cwd: "C:\\work" }, {
    clientFactory: () => fake,
  });
  assert.equal(result.code, RESULT_CODES.APP_SERVER_TURN_FAILED);
  assert.equal(result.turnStatus, "unknown");
});
