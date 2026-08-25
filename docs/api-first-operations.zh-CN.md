# API-first 运维手册

## 首次启动

全新的状态目录没有活动引擎。用户必须在**控制中心 → 模型与 API**中完成 profile 实时测试与激活；在此之前 CyberBoss 保持“停止”，“运行”和“静默”不可用。

1. 选择 Built-in API、OpenCode、Codex 或 Claude Code。
2. 选择 provider，填写端点和凭据，刷新目录或手动输入 model ID。
3. 执行连接测试。激活要求认证、模型访问、流式输出、工具调用、工具结果续接与取消能力全部通过；图片输入是可选能力。
4. 激活已验证 profile。所有联系人、workspace、计划任务、报表、MCP 与工具触发 turn 共用一个全局 runtime/provider/model。

Built-in API 支持 OpenAI、OpenRouter、Anthropic、Gemini、Ollama、DeepSeek、Kimi、GLM、MiniMax、腾讯混元、小米 MiMo、Qwen 和自定义 OpenAI-compatible 端点。OpenRouter 提供可搜索的实时模型目录。

## OpenCode 与兼容运行时

- **Managed local OpenCode**：启动 CyberBoss 自有服务，并使用隔离的 config/data 目录；provider 凭据可以从 CyberBoss 保险库注入。
- **External OpenCode**：只使用外部服务已有的 provider 凭据。CyberBoss 仅保存端点和可选 Basic Auth 密码，只接受回环 HTTP 或 HTTPS，并在每次激活时强制实时刷新 provider/model。
- **Codex / Claude Code**：仅为显式兼容选项，永远不会被选作默认引擎；本地对应运行时必须可用。

`/model` 是只读命令：它只显示当前全局 profile，切换必须回到控制中心。

## 凭据与诊断安全

API key、OpenCode 服务密码和敏感自定义 header 保存在 `credential-vault.json`，由当前 Windows 用户的 DPAPI 加密。把 vault 移到另一 Windows 账户或机器后无法解密，应重新录入并验证凭据。

普通日志与 renderer snapshot 不包含凭据、Authorization/敏感 header、URL 凭据、原始 request body、原始 response body、provider 响应正文或 vault ciphertext。

诊断 capture 需要显式开启，使用 DPAPI 加密，最长 15 分钟、最大 1 MiB，并在 24 小时后删除；也可立即停用或删除。开启 capture 不会放宽凭据脱敏，也不会保留原始图片字节。

## 备份、恢复与故障处理

设置备份只包含净化后的 `provider-profiles.json` 结构，明确排除 `credential-vault.json`、`diagnostic-capture.json`、OpenCode 认证/配置秘密、API key、Authorization/敏感 header、原始请求/响应和 ciphertext。

恢复时，所有 profile 都会变成未激活 draft；验证指纹、能力、凭据引用与凭据代次都会清空。用户需要重新录入凭据、执行实时测试并激活。归档不会覆盖目标状态目录里已有的凭据文件。

常见恢复动作：

- 凭据无效或 DPAPI 解密失败：重新录入并验证。
- Base URL 无法访问/格式错误：修正端点；URL 中的用户名、密码、query 与 fragment 都会被拒绝。
- 模型不可用：刷新实时目录，或填写当前账户可访问的 model ID。
- 限流/额度不足：等待或修复 provider 账户；系统不会因此静默切到别的 runtime。
- OpenCode 缺失/不健康：修复选定的 executable/endpoint，或显式激活另一个已验证 profile。
- 运行时切换失败：CyberBoss 会先恢复并探测旧运行时，成功后才恢复派发；回滚也失败时使用 Retry。

## 发布验证

依次运行 `npm run check`、`npm run test:models`、`npm test`、`npm run desktop:package` 和 `npm run verify:artifacts`。最后一条会真实创建并重开 profile、vault、备份、打包状态、解包 executable 和 portable 产物，同时审计归档与 packaged resources 中不存在敏感条目。

夜间关怀不属于本次 API-first 版本，仍由后续独立计划实施。
