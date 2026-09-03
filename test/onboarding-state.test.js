"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveOnboardingStatus, resolveWeixinAccountStatus } = require("../src/desktop/onboarding-state");

test("onboarding keeps model, WeChat, and start as separate actionable steps", () => {
  const base = { engine: { configurationRequired: true }, runtime: { phase: "configuration_required" }, wechat: { configured: false } };
  assert.equal(resolveOnboardingStatus(base).step, "model");
  assert.equal(resolveOnboardingStatus({ engine: { configurationRequired: false, activeProfile: { id: "p1" } }, runtime: { phase: "stopped" }, wechat: { configured: false } }).step, "wechat");
  assert.equal(resolveOnboardingStatus({ engine: { configurationRequired: false, activeProfile: { id: "p1" } }, runtime: { phase: "stopped" }, wechat: { configured: true } }).step, "start");
  assert.equal(resolveOnboardingStatus({ engine: { configurationRequired: false, activeProfile: { id: "p1" } }, runtime: { phase: "stopped" }, wechat: { configured: true }, settings: { lastStableState: "running" } }).complete, true);
  assert.equal(resolveOnboardingStatus({ engine: { configurationRequired: false, activeProfile: { id: "p1" } }, runtime: { phase: "running" }, wechat: { configured: true } }).complete, true);
});

test("WeChat account status distinguishes missing, incomplete, and ready accounts", () => {
  const config = {};
  assert.equal(resolveWeixinAccountStatus({ config, listAccounts: () => [], loadAccount: () => null }).state, "not_configured");
  assert.equal(resolveWeixinAccountStatus({ config, listAccounts: () => [{ accountId: "a1" }], loadAccount: () => null }).state, "needs_login");
  assert.equal(resolveWeixinAccountStatus({ config, listAccounts: () => [{ accountId: "a1", token: "token" }], loadAccount: () => null }).state, "ready");
  assert.equal(resolveWeixinAccountStatus({ config, listAccounts: () => [{ accountId: "a1", token: "1" }, { accountId: "a2", token: "2" }], loadAccount: () => null }).state, "needs_selection");
});

test("WeChat account status reads the selected account when configured", () => {
  const result = resolveWeixinAccountStatus({
    config: { accountId: "selected" },
    listAccounts: () => { throw new Error("should not list accounts"); },
    loadAccount: (_config, accountId) => ({ accountId, token: "token" }),
  });

  assert.deepEqual(result, {
    state: "ready",
    configured: true,
    label: "已登录",
    detail: "启动艾迪后会连接微信。",
    accountId: "selected",
  });
});
