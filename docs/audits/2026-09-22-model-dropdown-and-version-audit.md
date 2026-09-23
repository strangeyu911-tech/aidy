# 2026-09-22 审计：模型下拉为空 + “WorkBuddy 版本 2.137.1” 标签错误

只读审计（未改任何产品代码）。用户截图：模型设置页显示「已检测到 WorkBuddy 版本 2.137.1」，
模型下拉只有一条「Hy4 preview（当前配置，目录未返回）」，搜索框输入了 `hy` 并点过「刷新模型」。

## 结论（TL;DR）

| 现象 | 根因 | 性质 |
| --- | --- | --- |
| 版本显示 2.137.1，实际 WorkBuddy 已是 5.5.6 | Aidy 显示的是 **bundled CLI**（`codebuddy --version` → `2.137.1`）的版本，不是桌面 App 版本（`resources/install-manifest.json` 的 `appVersion` = `5.5.6`） | 标签语义错误（误导，非缓存） |
| 模型下拉为空 | 「刷新模型」会**新起一个托管网关**（`codebuddy --serve`），当前 CLI **不再认 `--settings` overlay 里注入的 `gateway.password`**，健康探测 401 → `CODEBUDDY_AUTH_FAILED` → 目录拉取失败 → 渲染层 `loadedModels=[]`，picker 回退到「当前配置，目录未返回」 | **P0 运行时兼容性回归**（见下） |
| 选中项是 “Hy4 preview” | 草稿 profile `c8da68bf`（“我的 WorkBuddy”，2026-08-27 建）把**显示名**存成了 modelId；真实 ID 是 **`hy4-preview`** | 数据/交互问题 |

## 证据

### 1. 版本号来源
- `src/desktop/main.js:572-576`：`checkCodeBuddyEnvironment()` 显示 `distribution.version`。
- `src/adapters/runtime/codebuddy/distribution-locator.js:57`：version = `codebuddy --version` 输出里的第一个 semver。
- 实测：`node <WorkBuddy>/resources/app.asar.unpacked/cli/bin/codebuddy --version` → `2.137.1`；
  而 `<WorkBuddy>/resources/install-manifest.json` → `"appVersion": "5.5.6"`。

### 2. 模型目录链路与回退文案
- `renderer.js:1010-1045`：`refreshModels` → `loadedModels`；`renderCodeBuddyModelSelect()` 用
  `buildCodeBuddyModelOptions(loadedModels, current)`。
- `model-settings-model-picker.js:28-32`：目录为空时只回退 `[Auto, "<current>（当前配置，目录未返回）"]`；
  搜索框 `hy` 会把 `Auto` 也过滤掉 → 下拉只剩那一条（与截图完全一致）。
- 目录来源：`runtime-adapter.js:636 listModels()` → `client.listModels()` → ACP `session/new` 的
  `models.availableModels`（`client.js:107`）。

### 3. 网关鉴权回归（核心，P0）
用 Aidy 同款代码路径（`CodeBuddyProcessHost` + overlay + vault 密码）做了 7 组探测（脚本在
`D:/tmp/aidy-model-audit/`，含密钥的产物已删除）：

- overlay 写入 `{"gateway":{"auth":"password","password":X}}` 启动后，`GET /api/v1/health`：
  - `Bearer X`（overlay/vault 密码）→ **401 AUTH_REQUIRED**
  - `Bearer <CLI 启动横幅打印的 43 位密码>` → **200**
- 存活中的 Aidy 网关（PID 24996，今天 17:45 由 Aidy 拉起，`--model hy3`）相反：
  vault 密码（GSpNVV…，32 hex）→ **200**；CLI 打印的密码 → **401**。
- 官方文档（CLI 自带 `dist/web-ui/docs/cn/cli/http-api.md`）：`--serve` **首次启动会生成随机密码并持久化**，
  打印在 stdout 横幅；认证模式优先级里 env > CLI 参数 > `gateway.auth` 配置。
- **已验证的修复开关**：spawn 时加环境变量 **`CODEBUDDY_GATEWAY_PASSWORD=<服务密码>`** →
  网关只认该密码（200），生成的密码被拒（401）。一行即可修复。

时间线（收敛后）：overlay 密码被认并不是「CLI 2.137.1 一装上就失效」——9-10 装的 5.5.6 之后，
9-21 14:55 仍有成功对话转录（`71b17216-….jsonl`），今天 17:45 Aidy 拉起的存活网关也认 vault 密码，
17:48:35 的连接测试（`c-Users-…-codebuddy-verification-cMwfqT/98415fe6-….jsonl` 8.7KB）也通过。
**翻转点在 17:48:35–18:04 之间：CLI 首次把生成的机器级网关密码（43 位，562uO3…）持久化**，
此后一切新拉网关只认它。这个窗口内只有本次审计的 CLI 启动动作 ⇒ 最可能的触发是审计探测的
首批 `--serve`（按官方文档「首次启动会生成随机密码并持久化」的行为；生成密码的存储位置未定位到，
疑 DPAPI 加密，故无法用 mtime 做实锤归因）。overlay 目录历史（`~/.cyberboss/codebuddy/runtime-overlays/`）
证明 8-27 至今 Aidy 一直用同一对 vault 密码（wmLyHQ…/GSpNVV…），即「以前能用」的机制从未变过。

### 4. 真实模型目录（用 CLI 打印的密码拉到的一次性快照）
`session/new` 返回 `models.availableModels`（节选）：`fast-model`（快速）、`balanced-model`（均衡）、
`deep-model`（极致）、**`hy4-preview`（Hy4 preview）**、`hy3`（Hy3）、`hy3-x`、`deepseek-v4.1-flash`、
`glm-5.3`…每项含 `name`/`description`(积分倍率)/`_meta.maxInputTokens`。
另外 `codebuddy --help` 的 `--model` 行静态列出全部受支持 ID，可作为目录拉取失败时的兜底来源。

## 影响

- **现在**：Aidy 正在跑的网关（17:45 拉起）仍认 vault 密码，LLM 会话正常；
  但「刷新模型」「保存并测试连接」对**所有** profile 都会报 `CODEBUDDY_AUTH_FAILED`
  （raw 文案 “CodeBuddy rejected the managed gateway credentials.”，UI 未映射成人话）。
- **下次 Aidy 重启运行时后**：supervisor 新拉的网关同样 401 → **LLM 回合全挂**（微信通道本身不受影响）。
  ⚠️ 在修复落地前，重启 Aidy = 大脑下线。

## 建议修复（未实施）

1. **P0** `process-host.js:start()`：spawn env 增加 `CODEBUDDY_GATEWAY_PASSWORD: password`
   （已实测有效）；可同时兜底解析 stdout 横幅的 `Password <x>` 作为凭据。补一条针对 2.137.1 的兼容性测试。
2. **P1** `main.js:576`：版本文案改为读 `install-manifest.json` 的 `appVersion`（显示 5.5.6），
   或改写成「WorkBuddy（CLI 2.137.1）」，不再把 CLI 版本叫 App 版本。
3. **P1** `friendlyUiError()`：为 `CODEBUDDY_AUTH_FAILED` 增加人话文案。
4. **P2** 目录拉取失败时兜底解析 `--help` 的 `--model` 静态列表，保证下拉永远有内容。
5. **用户侧**：修好后把「我的 WorkBuddy」草稿的模型改成 **hy4-preview**（现在存的 “Hy4 preview” 是显示名，
   即使目录正常也过不了连接测试的模型校验）。

## 审计遗留

- 生成密码的持久化位置未定位到（明文扫描 `~/.workbuddy`、`~/.codebuddy`、AppData 均无命中，
  疑似 DPAPI 加密或 app 托管存储）；对修复无影响。
- 探测脚本保留在 `D:/tmp/aidy-model-audit/`（`probe-auth-contract.js`、`probe-password-matrix.js`、
  `probe-cwd-hypothesis.js` 可用于修复后的回归验证）；含密钥产物已删除，无残留进程。
