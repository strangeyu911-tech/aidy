# Codex 认证自动诊断与修复（Windows 第一版）

当 CyberBoss 无法通过 Codex CLI 或 App Server 调用模型，或者浏览器选完账号后一直转圈时，在仓库目录运行：

```powershell
npm run codex:auth-repair
```

这条命令会依次检查 CyberBoss 实际使用的 `CODEX_HOME`、重新打开凭据文件、用同一目录执行 CLI 登录状态检查、必要时发起设备码登录、识别真正监听端口的 App Server、在身份完全匹配时安全重启，最后用真实模型回复 `CYBERBOSS_AUTH_OK` 验收。

第一版只支持 Windows / PowerShell。它不诊断、不启动也不重启微信桥接。

## 常用命令

```powershell
# 完整自动修复；可能要求你在网页输入设备码
npm run codex:auth-repair

# 只读诊断；不登录、不重启、不发模型请求
npm run codex:auth-repair -- --diagnose-only

# 机器可读输出；--silent 避免 npm 自己的标题混入 stdout
npm run --silent codex:auth-repair -- --json

# 发现旧 App Server 缓存未认证状态时只报告，不重启
npm run codex:auth-repair -- --no-restart

# 覆盖默认端口 8765
npm run codex:auth-repair -- --port 9876
```

`--diagnose-only` 成功时返回 `DIAGNOSIS_COMPLETE`，只代表本地证据检查完成。因为它没有发送模型请求，所以绝不代表 App Server 认证已经通过。

## 固定排查方向

### 1. 配置层：确认到底在使用哪个账号目录

CyberBoss 使用 `.env` 里的 `CODEX_HOME`。普通终端里的 `codex login` 如果没有使用同一个环境变量，往往写入默认的 `~/.codex`。

必须同时确认：

- `CYBERBOSS_RUNTIME=codex`；
- `CYBERBOSS_CODEX_COMMAND` 指向实际 Codex 可执行文件；
- CyberBoss 专用 `CODEX_HOME` 路径明确且可读写；
- 默认目录和专用目录不能被混为一个账号仓库。

禁止推断：默认 `~/.codex` 已登录，不等于 CyberBoss 的专用目录已登录。

为了允许工作流安全自动重启，Windows 上建议把 `CYBERBOSS_CODEX_COMMAND` 配成实际 `.exe` 的绝对路径。只写命令别名或使用多层 wrapper 时，模型探针仍可运行，但进程路径无法严格对应时会锁住自动重启。

### 2. 浏览器回调层：转圈不等于 callback 一定失败

从专用目录的登录日志区分：

- 没有 callback 记录：再检查 localhost 回调、远程环境或浏览器流程；
- callback 已到达且 state 有效：浏览器授权已经完成；
- token exchange 失败：问题在 CLI 到认证服务的网络或 TLS，不要继续反复折腾浏览器；
- 普通浏览器流程不可靠：使用设备码登录。

设备码必须由用户本人在 OpenAI 页面提交。命令不会读取或记录设备码。

### 3. 凭据层：终端说成功还不够

登录成功必须满足：

1. 专用 `CODEX_HOME/auth.json` 真实存在；
2. 文件非空；
3. 文件能重新打开并解析；
4. 相同 `CODEX_HOME` 下的 `codex login status` 明确显示使用 ChatGPT 登录。

工作流只报告文件状态和大小，不输出凭据字段或令牌值。

### 4. 进程层：PID 文件和 readyz 都不能证明身份

停止进程前必须同时核对：

- 真实监听目标端口的 PID；
- 进程路径与配置中的 Codex 可执行文件一致；
- 命令行包含 `app-server` 和目标端口。

PID 文件与监听 PID 不一致时会显示 `[STALE]`。工作流不会停止 PID 文件指向的未知进程。Windows 查询权限不足时会返回 `APP_SERVER_IDENTITY_UNVERIFIED`，要求在普通本机 PowerShell 中重跑，而不是降低安全检查。

### 5. 业务验收层：必须真的让模型回复

`/readyz=ok` 只说明有服务响应，不说明它持有有效认证。最终验收必须同时满足：

```text
modelCount > 0
turn.status == completed
reply == CYBERBOSS_AUTH_OK
```

即使收到了 `turn/completed` 事件，也必须检查 `turn.status`；失败回合也会结束事件流。

## 为什么登录后还可能需要重启 App Server

登录前启动的 App Server 可能缓存“未认证”状态。新凭据已经写入磁盘后，旧进程仍可能返回 401。工作流只在真实模型探针返回 401、且监听 PID、路径、命令行三项身份都匹配时重启一次，然后再探针一次。第二次仍失败会停止，不做循环重试。

## 结果代码

| 代码 | 含义 / 下一步 |
| --- | --- |
| `DIAGNOSIS_COMPLETE` | 只读诊断完成；认证未经模型探针验证 |
| `CONFIG_INVALID` | runtime、端口或关键配置无效 |
| `PLATFORM_UNSUPPORTED` | 第一版不是在 Windows 上运行 |
| `CLI_NOT_FOUND` | 配置的 Codex 可执行文件不存在 |
| `CODEX_HOME_NOT_WRITABLE` | 专用目录不可读写 |
| `AUTH_MISSING` | 专用目录没有 `auth.json` |
| `AUTH_FILE_INVALID` | 凭据文件为空、损坏或不能重新打开 |
| `CLI_STATUS_UNAUTHENTICATED` | 同一 `CODEX_HOME` 的 CLI 状态不是 ChatGPT 已登录 |
| `DEVICE_AUTH_FAILED` | 设备码登录取消、超时或未生成可复用凭据 |
| `AUTH_NETWORK_FAILED` | OAuth 换令牌阶段出现网络或 TLS 失败 |
| `APP_SERVER_NOT_RUNNING` | 目标端口没有监听服务 |
| `APP_SERVER_START_FAILED` | App Server 启动或就绪失败 |
| `APP_SERVER_IDENTITY_UNVERIFIED` | 无法同时证明 PID、路径和启动参数；不会结束进程 |
| `APP_SERVER_UNAUTHORIZED` | 真实模型调用返回 401；可能需要安全重启 |
| `APP_SERVER_TURN_FAILED` | 模型列表、线程或回合失败 |
| `APP_SERVER_REPLY_MISMATCH` | 回合完成但回复不是固定验收文本 |
| `REPAIR_SUCCEEDED` | 真实 App Server 模型探针全部通过 |

成功退出码为 `0`；需要处理的失败结果为非零。JSON 不包含令牌、设备码、Cookie 或完整敏感日志。

## 本次真实踩坑

- 登录的是默认 `.codex`，CyberBoss 实际使用另一个专用 `CODEX_HOME`。
- 浏览器完成授权后仍然转圈，callback 可能已经成功，真正失败的是后续 token exchange。
- 沙箱里的网络或进程查询失败不能直接代表 Windows 主机也失败。
- 登录后凭据已经有效，登录前启动的 App Server 仍可能缓存未认证状态。
- PID 文件里的 PID 仍存活，但已经不是原来的 App Server，可能是 PID 复用。
- `/readyz` 正常并不代表模型调用已认证。
- “已整理步骤”或“命令输出成功”不等于文件已生成，必须检查文件真实存在并重新打开。
- `turn/completed` 不等于回合成功，必须检查状态和最终文本。

## 安全边界

工作流永远不会：

- 输出或记录令牌；
- 删除 `auth.json` 或执行 `codex logout`；
- 停止身份未验证的进程；
- 修改代理、防火墙、VPN、证书或浏览器设置；
- 启动或重启微信桥接；
- 把测试线程绑定到微信会话。

探针线程会尽力归档，不会永久删除。归档失败时保留线程 ID 供人工检查。

## 给较弱模型的固定执行提示

复制下面整段给模型，不要让它自行改变排查顺序：

```text
你正在 Windows PowerShell 的 CyberBoss 仓库中修复 Codex 登录。
先运行：npm run --silent codex:auth-repair -- --diagnose-only --json
只读取最后的 result 和 events，不读取或输出 auth.json 内容。

规则：
1. 必须使用报告里的专用 CODEX_HOME，不能用默认 ~/.codex 的登录状态代替。
2. AUTH_MISSING、AUTH_FILE_INVALID 或 CLI_STATUS_UNAUTHENTICATED 时，运行 npm run codex:auth-repair，让用户本人完成设备码。
3. 登录后必须重新验证 auth.json 存在、非空、能解析，并用同一 CODEX_HOME 检查 codex login status。
4. 不得因为 PID 文件存活或 readyz=ok 就停止进程。
5. 只有监听 PID、可执行路径、app-server 参数和端口全部匹配，才允许工作流自动重启。
6. 成功只认 RESULT=REPAIR_SUCCEEDED；DIAGNOSIS_COMPLETE 不是认证成功。
7. 不修改系统网络，不执行 logout，不删除凭据，不触碰微信桥接。
8. 如果返回 APP_SERVER_IDENTITY_UNVERIFIED，停止自动操作并报告证据，不要强杀进程。
```

## 官方参考

- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
