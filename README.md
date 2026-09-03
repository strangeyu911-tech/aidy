# Aidy（艾迪）

**Aidy 是一个会主动来找你的 AI 监督陪伴 Agent，尤其适合 ADHD、执行功能困难、容易拖延或分心的场景。** 它会通过主动提醒、随机查岗和 checkpoint 跟进任务；不用一直记得打开另一个 AI App，Aidy 可以在微信里找到你。

微信是 Aidy 主动触达你的入口，而不是产品本身；WorkBuddy 等 runtime 则提供 Agent / 模型能力，而不是 Aidy 的定位。

> Aidy 不是医疗工具，不提供诊断、治疗或疗效承诺。它面向的是「知道要做什么，却很难开始、容易跑偏或忘记回来」这类日常执行支持场景。

## 为什么做 Aidy

大多数 AI 都是被动的：你得记得打开它、想好问题、再输入 prompt。对 ADHD、执行功能困难或常常拖延、分心的人来说，连「记得打开效率工具」都可能已经是任务的一部分。

Aidy 想把 AI 从一个等待提问的窗口，变成会在合适的时候主动出现的监督陪伴者。它可以提醒你开始、在不固定的时间问你正在做什么、在约定的 checkpoint 追问进展；你随手划掉一条提醒后，它也不会假装任务已经完成。

这些主动跟进会送到你本来就会看到的微信里。重点不是「把聊天机器人接进微信」，而是让 Aidy 能在你走神、拖延或忘记任务时主动找到你。

## Aidy 最核心的体验

### 主动提醒

不必等你先发消息。你可以约定一个时间点，让 Aidy 到时回来提醒或问一句进展。

### 随机查岗

Aidy 可以在设定的时间范围内随机发起 check-in，问问你此刻在做什么、有没有偏离原来的目标。随机性避免了「知道什么时候会响，所以只在那一刻应付」的机械感。

### Checkpoint 跟进

对有明确时间点的计划，Aidy 会在 checkpoint 到来时主动跟进。它也会处理静默时段、过期任务、合并与队列边界，尽量避免把已经失去时效的提醒重新当作「现在该做」的任务。

### 微信主动触达

你不需要持续盯着 Aidy。微信只是触达渠道：Aidy 用它把提醒、查岗和跟进送到你日常会看到的地方，同时也支持普通的微信对话。

### WorkBuddy 提供模型能力

默认推荐 WorkBuddy 作为 Aidy 的 Agent / 模型 runtime。它负责模型账号与模型服务；Aidy 不读取或复制其登录凭据。也可以按需要接入其他兼容 runtime 或自定义 API，但这些选择不改变 Aidy「主动监督」的核心体验。

## Aidy 如何工作

1. 在 Windows 桌面控制中心连接并验证 WorkBuddy 或其他兼容 runtime。
2. 登录微信；这是 Aidy 主动找到你的入口。
3. 设定提醒、check-in 区间或任务 checkpoint；正常对话也可以在微信中继续。
4. Aidy 在设定的边界内主动提醒、随机查岗或跟进进度。

Windows 控制中心把模型连接、微信登录、服务状态和配置集中到同一条使用路径中，不必先理解命令行或底层协议。

## 相比上游，Aidy 重点改进了什么

1. **更容易真正用起来的 Windows 控制中心**：把配置、验证、启动和状态放进桌面界面。
2. **WorkBuddy runtime 接入与验证**：优先支持更适合本地使用的 Agent / 模型能力来源。
3. **微信真实消息链路**：让 Aidy 能通过日常入口触达和回应用户。
4. **主动监督边界**：围绕 reminder、随机 check-in、checkpoint、过期处理、静默时段和 flood 防护持续维护。
5. **安装与发布体验**：面向普通 Windows 用户提供安装、启动和诊断路径。
6. **可观测性与隐私边界**：对连接、队列与发送链路保留脱敏诊断能力。

## 核心体验与高级兼容能力

首页重点维护和介绍的是主动监督、微信主动触达与 WorkBuddy runtime。仓库底层仍保留一些上游能力，例如 workspace / thread、diary / timeline、MCP，以及文件或媒体相关机制；它们属于高级或兼容能力，不应被理解为 Aidy 已经验证的核心用户体验。

如果你需要这些能力，请先在自己的环境中验证适配情况；不要仅因源码中存在某个入口，就假定它已经适合长期日常使用。

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

微信中的高级控制命令包括 `/bind`、`/status`、`/new`、`/stop` 和 `/checkin <最小分钟>-<最大分钟>`；用 `/help` 查看当前完整帮助。

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

## 使用与隐私边界

- Aidy 的主动监督会经过本地队列与 checkpoint 状态机；相同任务可合并，静默时段内的随机提醒会被抑制，时间敏感的计划任务过期后会按策略归档或丢弃。目标是降低重复与陈旧提醒风险，不承诺严格 exactly-once 或“永不丢消息”。
- 普通微信消息会经过消息类型、发送者和重复消息过滤；runtime 失败时不会把内部错误当作用户回复发送。
- Windows 上的本地凭据由 DPAPI-backed credential vault 保护；诊断记录会使用脱敏标识。不要提交本地配置、token、真实微信用户 ID 或服务凭据。
- WorkBuddy、微信和所选模型服务仍会处理完成任务所需的数据；“本地保存状态”不等于消息不会离开本机。

## 当前状态

Aidy 目前聚焦于个人真实的 Windows + 微信 + WorkBuddy 使用场景，并持续维护主动监督、兼容性与发布验收。它不以“production ready”作为未经证明的承诺。

## 文档

- [简明中文 README](./README.zh-CN.md)
- [English README](./README.en.md)
- [安装说明](./INSTALL.md)
- [Aidy 品牌与兼容迁移说明](./docs/aidy-rebrand-migration.md)
- [API-first 操作说明](./docs/api-first-operations.zh-CN.md)
- [首次外部测试验收清单](./docs/release/FIRST-EXTERNAL-TESTER-CHECKLIST.md)

## Upstream & Credits

Aidy 是 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 的 derivative work。感谢上游提供核心架构、微信 Agent bridge 与主动监督设计基础。

## License

本项目沿用仓库中的 [AGPLv3 License](./LICENSE)。使用、修改或再发布时请保留许可证与 upstream attribution。
