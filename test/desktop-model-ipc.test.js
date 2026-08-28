"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const {
  MODEL_IPC_CHANNELS,
  registerModelSettingsIpc,
} = require("../src/desktop/model-settings-service");

test("model IPC registers only the explicit channel whitelist", () => {
  const registered = new Map();
  registerModelSettingsIpc({
    ipcMain: { handle(channel, handler) { registered.set(channel, handler); } },
    service: fakeService(),
    getMainWindow: () => mainWindow,
    rendererUrl,
  });
  assert.deepEqual([...registered.keys()].sort(), [...MODEL_IPC_CHANNELS].sort());
});

test("model IPC rejects wrong sender, child frames, and wrong origins", async () => {
  const registered = registerHandlers();
  const handler = registered.get("desktop:list-profiles");
  await assert.rejects(handler(event({ sender: {} })), hasCode("IPC_SENDER_REJECTED"));
  await assert.rejects(handler(event({ url: "file:///elsewhere/index.html" })), hasCode("IPC_ORIGIN_REJECTED"));
  await assert.rejects(handler(event({ top: {} })), hasCode("IPC_FRAME_REJECTED"));
});

test("secret writes are size bounded and never echo submitted secrets", async () => {
  const registered = registerHandlers();
  const handler = registered.get("desktop:write-profile-secrets");
  await assert.rejects(handler(event(), "p1", { apiKey: "x".repeat(40_000) }), hasCode("IPC_PAYLOAD_TOO_LARGE"));
  const result = await handler(event(), "p1", { apiKey: "sk-renderer-secret" });
  assert.equal(JSON.stringify(result).includes("sk-renderer-secret"), false);
  assert.deepEqual(result, { ok: true, flags: { hasApiKey: true } });
});

test("preload exposes the model whitelist and UI contains first-run gates", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "preload.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "renderer.js"), "utf8");
  for (const channel of MODEL_IPC_CHANNELS) assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /id="first-run-setup"/);
  assert.match(html, /id="onboarding-progress"/);
  assert.match(html, /id="onboarding-primary-action"/);
  assert.match(html, /id="profile-connection-step"/);
  assert.match(html, /id="advanced-settings"/);
  assert.match(html, /id="codebuddy-environment"/);
  assert.match(html, /id="model-profile-list"/);
  assert.match(html, /id="profile-codebuddy-model-select"/);
  assert.match(html, /id="profile-codebuddy-custom-model"/);
  assert.match(html, /id="profile-editor-status"/);
  assert.match(html, /id="profile-editor-title"/);
  assert.match(html, /id="profile-editor-state"/);
  assert.match(html, /id="profile-api-key"[^>]*type="password"[^>]*autocomplete="off"/);
  assert.match(html, /id="profile-service-password-label"/);
  assert.match(html, /外部 OpenCode[^<]*provider 凭据[^<]*外部实例/);
  assert.match(renderer, /configurationRequired/);
  assert.match(renderer, /finally\s*{[^}]*\.value\s*=\s*""/s);
  assert.match(renderer, /profileTestResults = new Map/);
  assert.match(renderer, /正在编辑：\$\{state\.name\}/);
  assert.match(renderer, /profileEditorState\.formatProfileTestFailure/);
  assert.match(renderer, /profileEditorState\.resolveProfileCardState/);
  assert.match(renderer, /\$\{cardState\.label\}/);
  assert.match(renderer, /cardState\.disabled \? "disabled" : ""/);
  assert.match(renderer, /if \(modelProfiles\.length\) \{[\s\S]*renderModelProfiles\(\);[\s\S]*renderProfileEditorStatus\(\);/);
});

test("renderer maps CodeBuddy to the existing compatibility profile form", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /\["codex", "claudecode", "codebuddy"\]/);
  assert.match(renderer, /runtimeId === "codebuddy"/);
  assert.match(renderer, /profile-service-password-label/);
  assert.match(renderer, /codebuddy: "CodeBuddy"/);
  assert.doesNotMatch(renderer, /\["codex", "claudecode"\]\.includes\(runtimeId\)/);
});

const rendererUrl = pathToFileURL(path.join(__dirname, "..", "src", "desktop", "renderer", "index.html")).href;
const webContents = {};
const mainWindow = { webContents };

function registerHandlers() {
  const registered = new Map();
  registerModelSettingsIpc({
    ipcMain: { handle(channel, handler) { registered.set(channel, handler); } },
    service: fakeService(),
    getMainWindow: () => mainWindow,
    rendererUrl,
  });
  return registered;
}

function event(overrides = {}) {
  const top = {};
  const senderFrame = { url: rendererUrl, top, ...overrides };
  if (!Object.hasOwn(overrides, "top")) senderFrame.top = senderFrame;
  return { sender: webContents, senderFrame, ...overrides };
}

function fakeService() {
  return {
    listRuntimeOptions: async () => ({}), listProfiles: async () => [], saveProfile: async () => ({}),
    writeProfileSecrets: async () => ({ ok: true, flags: { hasApiKey: true } }), refreshModels: async () => ({}),
    testProfile: async () => ({}), activateProfile: async () => ({}), deleteProfile: async () => ({}),
    setDiagnosticCapture: async () => ({}),
  };
}

function hasCode(code) { return (error) => error?.code === code; }
