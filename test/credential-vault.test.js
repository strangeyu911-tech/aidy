const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");

const { CredentialVault } = require("../src/security/credential-vault");
const { createWindowsDpapi } = require("../src/security/windows-dpapi");

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-vault-test-"));
}

function makeProtector() {
  return {
    async protectText(text) {
      return Buffer.from(`protected:${text}`, "utf8").toString("base64");
    },
    async unprotectText(ciphertext) {
      const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
      if (!decoded.startsWith("protected:")) {
        throw new Error("tampered ciphertext");
      }
      return decoded.slice("protected:".length);
    },
  };
}

test("every vault write increments generation even for the same value", async () => {
  const stateDir = makeStateDir();
  const vault = new CredentialVault({ stateDir, protector: makeProtector() });
  assert.deepEqual(await vault.write("p1", { apiKey: "same" }), { generation: 1 });
  assert.deepEqual(await vault.write("p1", { apiKey: "same" }), { generation: 2 });
  assert.deepEqual(await vault.read("p1"), { apiKey: "same" });
  assert.equal(vault.getGeneration("p1"), 2);
});

test("vault creates a real encrypted file that a fresh instance can reopen", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "credential-vault.json");
  const protector = makeProtector();
  const vault = new CredentialVault({ stateDir, protector });
  const secret = "synthetic-key-never-plaintext";
  await vault.write("profile-reopen", { apiKey: secret, sensitiveHeaders: { "X-Tenant": "private" } });

  assert.equal(fs.existsSync(filePath), true);
  const persisted = fs.readFileSync(filePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
  assert.equal(persisted.includes(secret), false);
  assert.deepEqual(fs.readdirSync(stateDir).filter((name) => name.endsWith(".tmp")), []);

  const reopened = new CredentialVault({ stateDir, protector });
  assert.deepEqual(await reopened.read("profile-reopen"), {
    apiKey: secret,
    sensitiveHeaders: { "X-Tenant": "private" },
  });
});

test("deletion writes a generation-incrementing tombstone", async () => {
  const stateDir = makeStateDir();
  const protector = makeProtector();
  const vault = new CredentialVault({ stateDir, protector });
  await vault.write("p1", { apiKey: "first" });
  assert.deepEqual(await vault.delete("p1"), { generation: 2 });
  assert.equal(await vault.read("p1"), null);
  assert.equal(vault.getGeneration("p1"), 2);
  assert.deepEqual(await vault.write("p1", { apiKey: "first" }), { generation: 3 });

  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "credential-vault.json"), "utf8"));
  assert.equal(persisted.entries.find((entry) => entry.profileId === "p1").generation, 3);
});

test("tampered ciphertext fails closed instead of becoming an empty credential", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "credential-vault.json");
  const protector = makeProtector();
  const vault = new CredentialVault({ stateDir, protector });
  await vault.write("p1", { apiKey: "secret" });
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  persisted.entries[0].ciphertext = "dGFtcGVyZWQ=";
  fs.writeFileSync(filePath, JSON.stringify(persisted), "utf8");

  await assert.rejects(vault.read("p1"), (error) => error.code === "CREDENTIAL_DECRYPT_FAILED");
});

test("one transient decrypt failure is retried from fresh vault metadata without logging secrets", async () => {
  const stateDir = makeStateDir();
  const records = [];
  let attempts = 0;
  let failNextRead = false;
  const protector = {
    ...makeProtector(),
    async unprotectText(ciphertext) {
      attempts += 1;
      if (failNextRead) {
        failNextRead = false;
        throw Object.assign(new Error("transient DPAPI failure synthetic-secret"), { code: "DPAPI_OPERATION_FAILED" });
      }
      return makeProtector().unprotectText(ciphertext);
    },
  };
  const vault = new CredentialVault({
    stateDir,
    protector,
    logger: { warn(event, data) { records.push({ event, data }); } },
    readRetryDelayMs: 0,
  });
  await vault.write("retry-profile", { apiKey: "synthetic-secret" });
  attempts = 0;
  failNextRead = true;
  assert.deepEqual(await vault.read("retry-profile"), { apiKey: "synthetic-secret" });
  assert.equal(attempts, 2);
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(records).includes("synthetic-secret"), false);
  assert.match(records[0].data.ciphertextSha256, /^[a-f0-9]{64}$/);
  assert.equal(records[0].data.maxAttempts, 2);
});

test("corrupt vault JSON blocks writes so generations cannot silently reset", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "credential-vault.json");
  fs.writeFileSync(filePath, "not json", "utf8");
  const vault = new CredentialVault({ stateDir, protector: makeProtector() });
  assert.throws(() => vault.getGeneration("p1"), (error) => error.code === "CREDENTIAL_VAULT_CORRUPT");
  await assert.rejects(vault.write("p1", { apiKey: "new" }), (error) => error.code === "CREDENTIAL_VAULT_CORRUPT");
  assert.equal(fs.readFileSync(filePath, "utf8"), "not json");
});

test("structurally corrupt vault entries fail closed instead of disappearing", async () => {
  const stateDir = makeStateDir();
  const filePath = path.join(stateDir, "credential-vault.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    entries: [{ profileId: "p1", generation: 7, deleted: false, ciphertext: "" }],
  }), "utf8");
  const vault = new CredentialVault({ stateDir, protector: makeProtector() });
  await assert.rejects(vault.read("p1"), (error) => error.code === "CREDENTIAL_VAULT_CORRUPT");
  assert.throws(() => vault.getGeneration("p1"), (error) => error.code === "CREDENTIAL_VAULT_CORRUPT");
});

test("non-Windows DPAPI fails safely before starting a process", async () => {
  let spawned = false;
  const dpapi = createWindowsDpapi({
    platform: "linux",
    spawn() {
      spawned = true;
    },
  });
  await assert.rejects(dpapi.protectText("secret"), (error) => error.code === "DPAPI_UNAVAILABLE");
  assert.equal(spawned, false);
});

test("Windows DPAPI adapter passes secret material only through stdin", async () => {
  const secret = "stdin-only-secret";
  let argumentsSeen;
  let stdinSeen = "";
  const dpapi = createWindowsDpapi({
    platform: "win32",
    spawn(_command, args) {
      argumentsSeen = args;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin = new Writable({
        write(chunk, _encoding, callback) {
          stdinSeen += chunk.toString("utf8");
          callback();
        },
        final(callback) {
          child.stdout.end("synthetic-ciphertext");
          callback();
          process.nextTick(() => child.emit("close", 0));
        },
      });
      return child;
    },
  });
  assert.equal(await dpapi.protectText(secret), "synthetic-ciphertext");
  assert.equal(argumentsSeen.join(" ").includes(secret), false);
  assert.equal(stdinSeen, secret);
});

const realDpapiSkipReason = process.platform !== "win32"
  ? "requires a Windows user profile with DPAPI"
  : process.env.CYBERBOSS_TEST_REAL_DPAPI !== "1"
    ? "opt-in integration test; set CYBERBOSS_TEST_REAL_DPAPI=1"
    : false;

test("real Windows DPAPI vault can be generated and reopened by the same user", {
  skip: realDpapiSkipReason,
}, async () => {
  const stateDir = makeStateDir();
  const secret = "synthetic-real-dpapi-key";
  const vault = new CredentialVault({ stateDir });
  await vault.write("real-dpapi", { apiKey: secret });
  const filePath = path.join(stateDir, "credential-vault.json");
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.readFileSync(filePath, "utf8").includes(secret), false);
  const reopened = new CredentialVault({ stateDir });
  assert.deepEqual(await reopened.read("real-dpapi"), { apiKey: secret });
});
