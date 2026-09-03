# Aidy（艾迪）

Originally forked from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss).

Aidy（艾迪）保留上游“在微信里主动监督 Agent”的核心思路；这个 fork 经过较大幅度二次开发，以新的产品名继续维护，重点面向真实的 Windows + 微信 + WorkBuddy 使用场景。

> 本项目是 upstream 的 fork / derivative work，不是完全原创项目。

## 为什么做Aidy

大多数 AI 助手只有在你主动打开它、输入问题时才开始工作。但真正融入日常生活的 AI，不应该只是一个等待提问的聊天窗口。

Aidy 想做的是一个能够长期陪伴、理解上下文，并在合适的时候主动出现的个人 AI 助手。

它可以存在于你每天已经在使用的微信里，记住持续发生的事情，感知时间与任务状态，在你忘记、拖延或者需要推进某件事时主动提醒你，也可以通过本地工具帮助你真正完成事情，而不只是给出建议。

Aidy 支持接入多种 AI 能力来源。我们默认推荐使用 WorkBuddy：对于国内用户来说，接入 WorkBuddy 通常不需要翻墙、不需要订阅 ChatGPT，也不需要额外购买 API。WorkBuddy 提供的免费额度已经足够支持日常使用，让更多人可以低门槛体验一个真正能够持续运行、主动行动的个人 AI 助手。

如果你已经在使用 OpenAI Codex，也可以将 Aidy 接入 Codex；同时，Aidy 也支持配置其他兼容接口和自定义 API，方便有不同模型、账号或服务需求的用户自由选择。

同时，这种能力不应该要求用户先学习命令行、ACP 协议或者复杂的模型配置。

因此 Aidy 提供了一个 Windows 桌面控制中心，把 WorkBuddy、Codex 或自定义 API 的连接、微信登录、运行状态和主动监督整合到同一条使用路径中，让一个能够持续运行的个人 Agent 更接近普通软件，而不是一套需要开发者手动拼装的基础设施。

## 相比上游的主要改进

| 方向 | 本 fork 的改进 | 用户体验 |
| --- | --- | --- |
| WorkBuddy runtime | 将 WorkBuddy 作为实际可用的 CodeBuddy ACP runtime 接入；通过运行时能力、实际协议和连接测试确认兼容性，当前会话使用已验证的 `cwd` contract。 | 可以从艾迪内完成发现、检查和激活，不需要手工猜 ACP 参数。 |
| Windows 桌面化 | Electron 控制中心、首次启动引导、模型设置、微信连接入口、运行状态和错误反馈。 | 新用户不必先配置整套命令行；开始菜单或桌面即可启动。 |
| 模型配置 | WorkBuddy 模型动态发现/刷新，保留真实 model ID；`Auto` 显示为 `auto`，激活前要求完成真实连接测试。 | 减少手填信息，同时避免把显示名称误当成模型 ID。 |
| 微信链路 | 覆盖 inbound → dispatcher → ACP session → runtime → reply → sender；加入 inbound 去重、typing、超时/取消和 transport lifecycle 处理。 | 针对重复发送、连接中断和超时增加防护与可观测性。 |
| 主动监督 | system message queue、checkpoint、业务级 supervision key、同日任务合并，以及静默时段过期任务的归档/丢弃边界。 | 减少多个 overdue checkpoint 在一次回复后集中 flood；不把旧提醒当成新任务重复轰炸。 |
| 安装与发布 | NSIS Setup、portable、`win-unpacked` 和开始菜单快捷方式同步脚本。 | Windows 用户可以使用安装包或便携版；源码用户仍可保留开发模式。 |
| 可观测性 | inbound、dispatch、ACP 请求/SSE、runtime 结果、reply、sender enqueue/attempt/result 使用关联上下文串联；敏感值和消息正文不进入普通诊断。 | 出问题时能区分“没收到、没启动、没生成回复、没发出去”分别发生在哪一段。 |

## 功能概览

来自上游并继续保留的核心能力包括：

- 微信消息接入、回复、文件/媒体处理和本地账号状态；
- 按时间记录活动、维护个人 timeline、写入本地 diary；
- reminder、random check-in 和基于 checkpoint 的主动监督；
- 绑定项目 workspace，让 Agent 在持续上下文中工作；
- 项目原生工具与可选本地 MCP 服务；
- 多运行时架构：Built-in API、OpenCode、Codex、Claude Code，以及本 fork 重点维护的 CodeBuddy/WorkBuddy。

本 fork 的桌面控制中心只允许经过验证的 profile 成为全局 active runtime。模型、provider 和 runtime 不会因为一个环境变量或兼容性提示就被静默切换。

## Windows 快速开始

### 已拿到安装包

安装包使用说明见 [INSTALL.md](./INSTALL.md)。简要流程是：

1. 双击 `Aidy-Setup-v0.1.0.exe`，从开始菜单或桌面打开艾迪。
2. 在“AI 模型”中选择“WorkBuddy / CodeBuddy”，让艾迪检查可用状态、模型和账号登录，然后保存并激活。
3. 在“微信”中打开登录窗口，用手机微信扫码并确认。
4. 回到控制中心检查状态，点击“启动艾迪”，再发送一条普通微信消息进行确认。

WorkBuddy 负责其模型账号和模型服务。艾迪不复制或读取 WorkBuddy 的登录凭据；两者之间只使用本机控制链路。

本仓库不把“安装包可从 GitHub Releases 直接下载”作为前提。若你没有拿到构建产物，请按下面的源码方式构建；不要把 `dist/` 中的本地产物当成仓库内已发布的 Release。

### 从源码运行

需要 Windows 10/11 64 位和 Node.js `>=22`。如果使用 WorkBuddy，请先安装并登录它。

```bash
git clone https://github.com/strangeyu911-tech/aidy.git
cd aidy
npm install
npm run desktop
```

在桌面控制中心完成模型验证、激活和微信扫码。需要使用终端共享桥时，可以运行：

```bash
npm run login
npm run shared:start
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run desktop` | 启动 Electron 控制中心 |
| `npm run login` | 通过二维码登录微信并保存本地账号 |
| `npm run accounts` | 查看已保存的本地微信账号 |
| `npm run shared:start` | 启动共享 runtime bridge 和微信 bridge |
| `npm run shared:open` | 在终端打开当前绑定的共享线程 |
| `npm run shared:status` | 查看共享进程与 `readyz` 状态 |
| `npm run doctor` | 检查配置、channel/runtime 边界和线程状态 |
| `npm run help` | 查看稳定的命令入口 |

微信中常用的控制命令：

- `/bind <项目目录>`：绑定当前聊天使用的 workspace；
- `/status`：查看当前 workspace、线程、runtime 和模型；
- `/new`：创建新的线程草稿；
- `/stop`：停止当前 turn；
- `/checkin <最小分钟>-<最大分钟>`：调整随机主动检查区间；
- `/help`：查看完整的微信命令帮助。

### 构建 Windows 产物

```bash
npm install
npm run desktop:package
npm run desktop:package:portable
```

这些命令分别覆盖安装器/解包目录和 portable 构建路径；`desktop:package` 还会同步开始菜单快捷方式。构建后可运行：

```bash
npm run verify:artifacts
```

发布验收应同时检查源码测试、构建产物内容、实际启动的 executable 路径和真实用户链路；仅仅通过源码测试不等于安装包已经可用。

## WorkBuddy 配置说明

在控制中心的模型设置中：

- 选择 `WorkBuddy`（内部兼容 runtime ID 为 `codebuddy`）；
- 刷新模型列表，优先选择当前 runtime 返回的真实 model ID；
- 没有完整目录时可以使用 `Auto`，其实际 model ID 为 `auto`，或按界面提示填写可用 ID；
- 运行连接测试，确认账号身份、模型和 ACP/streaming turn 均可用；
- 只有验证通过后才能保存为 active profile。

WorkBuddy 的 ACP 参数不根据软件版本号推断。艾迪以运行时 capability、实际 protocol contract 和当前连接结果为准；`session/new` / `session/resume` 使用已验证的 `cwd` 工作目录形态。

## 微信与主动监督的边界

普通 inbound 消息会先经过消息类型、发送者和重复消息过滤，再进入绑定的 workspace/runtime。回复通过统一的 outbound boundary 发回微信；runtime 失败时不会把内部错误当作用户回复发送。

主动监督消息经过本地队列和 checkpoint 状态机。相同业务身份的任务可以合并，重试保留任务身份；静默时段内的随机提醒会被抑制，时间敏感的计划任务在过期后会按策略归档或丢弃。这里的目标是降低重复和过期消息风险，不承诺严格 exactly-once 或“永不丢消息”。

## 隐私与安全边界

- Windows 上的本地凭据由 DPAPI-backed credential vault 保护；profile 快照和备份不应携带明文 secret。
- ACP 连接、session、transport generation、请求和发送诊断使用脱敏标识；测试覆盖 token、密码、session ID 和消息正文不进入公开诊断记录。
- WorkBuddy、微信和所选模型服务仍会处理完成任务所需的数据；“本地保存状态”不等于消息不会离开本机。
- runtime/tool capability 和 approval 边界由艾迪控制；不要把本地配置文件、token、真实微信用户 ID 或服务凭据提交到仓库。

## 当前状态

这是一个面向个人真实 Windows + 微信 + WorkBuddy 场景的二次开发版本。主要二开阶段已完成，当前重点是兼容性维护、发布验收和小幅体验改进；它不以“production ready”作为未经证明的承诺。

## 文档

- [安装说明](./INSTALL.md)
- [Aidy 品牌与兼容迁移说明](./docs/aidy-rebrand-migration.md)
- [API-first 操作说明](./docs/api-first-operations.zh-CN.md)
- [API-first 迁移说明](./docs/api-first-migration.zh-CN.md)
- [首次外部测试验收清单](./docs/release/FIRST-EXTERNAL-TESTER-CHECKLIST.md)
- [英文 README](./README.en.md)

## Upstream & Credits

- Original project: [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss)
- 本项目是该项目的 fork / derivative work。
- 感谢原作者提供上游项目的核心架构、微信 Agent bridge 和主动监督设计基础。
- 本仓库保留原项目的 [LICENSE](./LICENSE)；请按许可证和 upstream attribution 使用、修改和再发布。

## License

本项目沿用仓库中的 [AGPLv3 License](./LICENSE)。
