const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DiagnosticCapture } = require("../src/security/diagnostic-capture");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-capture-test-"));
}

function makeProtector() {
  return {
    async protectText(text) {
      return Buffer.from(`encrypted:${text}`, "utf8").toString("base64");
    },
    async unprotectText(ciphertext) {
      const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
      if (!decoded.startsWith("encrypted:")) throw new Error("bad ciphertext");
      return decoded.slice("encrypted:".length);
    },
  };
}

function makeClock(start = Date.parse("2026-08-25T01:00:00.000Z")) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test("diagnostic capture is encrypted, reopenable, and capped at fifteen minutes", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "diagnostic-capture.json");
  const protector = makeProtector();
  const clock = makeClock();
  const capture = new DiagnosticCapture({ stateDir, protector, now: clock.now });
  const enabled = await capture.enable({ scope: "connection-test:p1", durationMs: 60 * 60_000 });
  assert.equal(Date.parse(enabled.expiresAt) - Date.parse(enabled.startedAt), 15 * 60_000);
  assert.equal(await capture.record({ kind: "request", prompt: "private prompt" }), true);

  assert.equal(fs.existsSync(filePath), true);
  const persisted = fs.readFileSync(filePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
  assert.equal(persisted.includes("private prompt"), false);

  const reopened = new DiagnosticCapture({ stateDir, protector, now: clock.now });
  assert.deepEqual(await reopened.read(), [{ kind: "request", prompt: "private prompt" }]);
});

test("diagnostic vision capture omits image bytes and base64 payloads", async () => {
  const stateDir = makeStateDir();
  const capture = new DiagnosticCapture({ stateDir, protector: makeProtector() });
  const bytes = Buffer.from("secret-image");
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  await capture.record({
    kind: "vision",
    mimeType: "image/png",
    width: 640,
    height: 480,
    bytes,
    base64: bytes.toString("base64"),
    nested: { previewUrl: dataUrl },
    responseText: "a desk",
  });
  const records = await capture.read();
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes("secret-image"), false);
  assert.equal(serialized.includes(bytes.toString("base64")), false);
  assert.equal(serialized.includes(dataUrl), false);
  assert.equal(records[0].responseText, "a desk");
  assert.deepEqual(records[0].image, {
    mimeType: "image/png",
    byteLength: bytes.length,
    width: 640,
    height: 480,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
});

test("capture never records credentials or authorization values", async () => {
  const capture = new DiagnosticCapture({ stateDir: makeStateDir(), protector: makeProtector() });
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  await capture.record({
    apiKey: "top-secret-key",
    servicePassword: "top-secret-password",
    ciphertext: "top-secret-ciphertext",
    headers: { Authorization: "Bearer top-secret-auth", "X-Trace": "safe" },
    customHeaders: { "X-Tenant": "top-secret-custom-header" },
    requestBody: "private request body",
    responseBody: "private response body",
    responseText: "diagnostic summary",
  });
  const serialized = JSON.stringify(await capture.read());
  for (const secret of ["top-secret-key", "top-secret-password", "top-secret-ciphertext", "top-secret-auth", "top-secret-custom-header"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes("diagnostic summary"), true);
});

test("capture stops at expiry, enforces the plaintext limit, and deletes after 24 hours", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "diagnostic-capture.json");
  const clock = makeClock();
  const capture = new DiagnosticCapture({
    stateDir,
    protector: makeProtector(),
    now: clock.now,
    maxPlaintextBytes: 160,
  });
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  assert.equal(await capture.record({ kind: "small", value: "ok" }), true);
  assert.equal(await capture.record({ kind: "large", value: "x".repeat(500) }), false);
  assert.equal((await capture.read()).length, 1);

  clock.advance(60_001);
  assert.equal(await capture.record({ kind: "late" }), false);
  assert.equal(fs.existsSync(filePath), true);

  clock.advance(24 * 60 * 60_000);
  assert.equal(await capture.cleanupExpired(), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.deepEqual(await capture.read(), []);
});

test("disable ends recording but retains encrypted capture until cleanup", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "diagnostic-capture.json");
  const capture = new DiagnosticCapture({ stateDir, protector: makeProtector() });
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  await capture.record({ kind: "before" });
  assert.equal(await capture.disable(), true);
  assert.equal(await capture.record({ kind: "after" }), false);
  assert.deepEqual(await capture.read(), [{ kind: "before" }]);
  assert.equal(fs.readFileSync(filePath, "utf8").includes("before"), false);
});

test("structurally corrupt capture metadata fails closed", async () => {
  const stateDir = makeStateDir();
  fs.writeFileSync(path.join(stateDir, "diagnostic-capture.json"), JSON.stringify({
    schemaVersion: 1,
    capture: { scope: "connection-test", ciphertext: "missing-expiry-fields" },
  }), "utf8");
  const capture = new DiagnosticCapture({ stateDir, protector: makeProtector() });
  await assert.rejects(capture.read(), (error) => error.code === "DIAGNOSTIC_CAPTURE_CORRUPT");
});

test("capture schedules automatic stop and 24-hour deletion", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "diagnostic-capture.json");
  const clock = makeClock();
  let scheduled = null;
  const capture = new DiagnosticCapture({
    stateDir,
    protector: makeProtector(),
    now: clock.now,
    setTimer(callback, delay) {
      scheduled = { callback, delay };
      return { unref() {} };
    },
    clearTimer() {},
  });
  await capture.enable({ scope: "connection-test", durationMs: 60_000 });
  assert.equal(scheduled.delay, 60_000);
  clock.advance(60_000);
  await scheduled.callback();
  assert.equal(scheduled.delay, 24 * 60 * 60_000 - 60_000);
  clock.advance(24 * 60 * 60_000 - 60_000);
  await scheduled.callback();
  assert.equal(fs.existsSync(filePath), false);
});
