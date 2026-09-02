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
  assert.match(html, /id="model-config-guide"[^>]*class="model-config-guide hidden"/);
  assert.match(html, /id="start-model-profile-from-guide"/);
  assert.match(html, /src="\.\/model-settings-view-state\.js"/);
  assert.match(html, /id="model-settings-coach"[^>]*class="model-settings-coach hidden"/);
  assert.match(html, /id="skip-model-coach"/);
  assert.match(html, /id="next-model-coach"/);
  assert.match(html, /src="\.\/model-settings-coach-state\.js"/);
  assert.match(html, /src="\.\/connection-status-view\.js"/);
  assert.equal([...html.matchAll(/class="guide-step-index"/g)].length, 6);
  assert.equal([...html.matchAll(/class="guide-screenshot-slot hidden"/g)].length, 5);
  assert.match(html, /id="profile-api-key"[^>]*type="password"[^>]*autocomplete="off"/);
  assert.match(html, /id="profile-service-password-label"/);
  assert.match(html, /外部 OpenCode[^<]*provider 凭据[^<]*外部实例/);
  assert.match(renderer, /configurationRequired/);
  assert.match(renderer, /finally\s*{[^}]*\.value\s*=\s*""/s);
  assert.match(renderer, /profileTestResults = new Map/);
  assert.match(renderer, /正在编辑：\$\{state\.name\}/);
  assert.match(renderer, /profileEditorState\.formatProfileTestFailure/);
  assert.match(renderer, /profileEditorState\.resolveProfileCardState/);
  assert.match(renderer, /reopen-model-guide"\)\.addEventListener\("click", toggleModelGuide\)/);
  assert.match(renderer, /function openModelGuide\(\)\s*{[\s\S]*type: "open-guide"[\s\S]*renderModelSettingsView\(\);[\s\S]*}/);
  assert.doesNotMatch(renderer.match(/function openModelGuide\(\)[\s\S]*?\n}/)?.[0] || "", /openProfileEditor|saveProfile|persistEditor/);
  assert.match(renderer, /function startModelProfileFromGuide\(\)[\s\S]*openProfileEditor\(\)/);
  assert.match(renderer, /skip-model-coach"\)\.addEventListener\("click", skipModelCoachMarks\)/);
  assert.match(renderer, /next-model-coach"\)\.addEventListener\("click", advanceModelCoachMarks\)/);
  assert.doesNotMatch(renderer.match(/function maybeStartModelCoachMarks\(\)[\s\S]*?\n}/)?.[0] || "", /openProfileEditor|saveProfile|persistEditor|activate/);
  assert.match(renderer, /function openModelSettings\(\)[\s\S]*!modelProfiles\.length && modelSettingsCoachState\.status === "idle"\) return;/);
  assert.match(renderer, /\$\{cardState\.label\}/);
  assert.match(renderer, /cardState\.disabled \? "disabled" : ""/);
  assert.match(renderer, /if \(modelProfiles\.length\) \{[\s\S]*renderModelProfiles\(\);[\s\S]*renderProfileEditorStatus\(\);/);
});

test("renderer maps CodeBuddy to the existing compatibility profile form", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "styles.css"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "desktop", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /\["codex", "claudecode", "codebuddy"\]/);
  assert.match(renderer, /runtimeId === "codebuddy"/);
  assert.match(renderer, /profile-service-password-label/);
  assert.match(renderer, /codebuddy: "WorkBuddy"/);
  assert.doesNotMatch(html, /WorkBuddy\s*\/\s*CodeBuddy/);
  assert.equal([...html.matchAll(/CodeBuddy/g)].length, 0);
  assert.doesNotMatch(renderer, /WorkBuddy\s*\/\s*CodeBuddy/);
  assert.match(html, /id="exit-app" class="danger-link"[^>]*>彻底退出 CyberBoss/);
  assert.match(styles, /\.danger-link\s*\{[^}]*border:\s*1px solid var\(--danger\)[^}]*border-radius:\s*10px[^}]*padding:\s*9px 14px/s);
  assert.match(styles, /\.danger-link:hover\s*\{/);
  assert.match(styles, /\.danger-link:focus-visible\s*\{/);
  assert.doesNotMatch(styles.match(/\.danger-link\s*\{[^}]*\}/)?.[0] || "", /position\s*:\s*absolute|\btop\s*:|\bleft\s*:/);
  assert.doesNotMatch(renderer, /\["codex", "claudecode"\]\.includes\(runtimeId\)/);
  assert.doesNotMatch(renderer, /请按下面的修复建议完成连接/);
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
