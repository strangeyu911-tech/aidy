# Codex 认证自动修复工作流设计

## 背景

CyberBoss 在 Windows 上通过独立的 Codex App Server 运行。一次真实故障中，普通 CLI 登录流程在浏览器选择账号后持续转圈，而 CyberBoss App Server 仍然无法调用模型。

排查最终确认了三个相互独立的问题：

1. 普通 CLI 使用默认 `~/.codex`，CyberBoss 使用 `.env` 中配置的独立 `CODEX_HOME`，两个目录的凭据互不共享。
2. 设备码登录成功并生成专用凭据后，登录前已经启动的 App Server 仍然缓存未认证状态，真实模型请求继续返回 401。
3. App Server PID 文件已经陈旧并指向另一个存活进程，导致仅凭 PID 文件和 `/readyz` 的重启逻辑误认为旧 App Server 正常。

本设计把这次修复固化为一个确定性工作流，使能力较弱的模型也能依照明确证据完成诊断、安全修复和最终验收。

## 目标

- 提供一个公开命令完成 Codex 认证诊断与修复。
- 核心流程保持跨平台可扩展，第一版只交付可靠的 Windows/PowerShell 适配器。
- 明确区分默认 Codex 凭据目录与 CyberBoss 专用 `CODEX_HOME`。
- 浏览器回调异常时使用设备码登录，并等待用户本人完成账号确认。
- 只重启身份经过严格验证的 Codex App Server。
- 以真实 App Server 模型调用作为最终成功标准。
- 同时提供适合人类阅读和弱模型解析的输出。
- 形成可随 CyberBoss 发布到 GitHub 的排障手册、错误分类和安全说明。

## 非目标

- 不诊断、启动或重启微信桥接。
- 不修改系统代理、防火墙、VPN、证书或浏览器设置。
- 不删除凭据，不执行 `codex logout`。
- 不打印、复制或记录令牌值。
- 不提供跳过进程身份验证的危险选项。
- 第一版不实现 macOS 或 Linux 平台适配器。

## 公开入口

默认修复命令：

```text
npm run codex:auth-repair
```

支持参数：

```text
--diagnose-only     只读检查，不登录、不重启、不发送模型请求
--json              输出结构化结果
--no-restart        发现需要重启时只报告，不停止进程
--port <number>     覆盖默认 App Server 端口 8765
```

默认命令可以自动执行诊断、设备码登录、已验证 App Server 重启和真实模型验收。设备码必须由用户本人在 OpenAI 页面提交。

## 架构

### 跨平台流程控制器

`codex-auth-repair.js` 负责：

- 执行状态机；
- 汇总证据；
- 调用平台适配器；
- 选择继续、停止或修复；
- 输出人类可读结果和 JSON 结果；
- 设置稳定退出码。

控制器不直接枚举或停止 Windows 进程。

### 认证诊断器

`codex-auth-diagnostics.js` 负责只读诊断：

- 按 CyberBoss 的实际加载顺序读取 `.env`；
- 解析 `CYBERBOSS_CODEX_COMMAND`、`CODEX_HOME`、runtime 和共享端口；
- 对比默认 `~/.codex` 与 CyberBoss 专用目录；
- 检查 `auth.json` 是否存在、非空并且能重新解析；
- 使用相同 `CODEX_HOME` 执行 `codex login status`；
- 读取专用 `codex-login.log` 的非敏感状态；
- 将诊断结果映射为稳定错误代码。

诊断器不得返回令牌字段内容。

### Windows App Server 适配器

`windows-codex-app-server.js` 负责：

- 查找真实监听目标端口的 PID；
- 读取 PID 文件并与真实监听 PID 比较；
- 验证监听进程的可执行路径；
- 验证启动参数包含 `app-server` 和目标端口；
- 只停止三项身份检查全部通过的进程；
- 启动新的 App Server 并等待 `/readyz`；
- 将新进程的真实 PID 写回 PID 文件。

平台接口应允许未来增加 macOS 和 Linux 实现，而不改变主状态机。

### App Server 真实探针

`codex-app-server-probe.js` 负责通过 JSON-RPC 连接真实 App Server：

1. 完成 `initialize` / `initialized` 握手；
2. 调用 `model/list`；
3. 创建不绑定微信会话的测试线程；
4. 发送固定提示，要求只回复 `CYBERBOSS_AUTH_OK`；
5. 等待 `turn/completed`；
6. 验证 `turn.status`；
7. 从最终 `item/completed` 的 `agentMessage` 读取文本。
8. 在 `finally` 清理阶段尽力归档测试线程，不永久删除；清理失败只产生警告并保留线程 ID。

只有同时满足以下条件才算成功：

```text
modelCount > 0
turn.status == completed
reply == CYBERBOSS_AUTH_OK
```

`/readyz` 只作为进程就绪信号，不能作为认证成功信号。

## 状态机

```text
读取配置
  -> 验证 CyberBoss 专用 CODEX_HOME 与 Codex 命令
  -> 检查专用凭据文件
  -> 使用同一 CODEX_HOME 检查 CLI 登录状态
  -> 未登录时启动 device-auth 并等待用户确认
  -> 再次验证 auth.json 真实存在且可重新打开
  -> 再次检查 CLI 登录状态
  -> 连接 App Server 并执行真实模型探针
  -> 没有监听进程：启动 App Server，等待 readyz 后执行真实模型探针
  -> 探针成功：结束
  -> 探针返回 401：验证真实监听进程身份
  -> 身份完全匹配：只重启该 App Server
  -> 身份无法证明：停止并报告，不结束任何进程
  -> 重启后再次执行真实模型探针
  -> 输出成功报告或明确失败代码
```

`--diagnose-only` 只检查配置、凭据文件、CLI 状态、监听进程身份和 `/readyz`。它不发送真实模型请求，因此报告必须明确标记“App Server 认证未经业务探针验证”，不能输出 `REPAIR_SUCCEEDED`。

只读检查全部通过时输出信息性代码 `DIAGNOSIS_COMPLETE`。该代码只证明诊断完成，不证明模型认证成功。

设备码登录失败、企业策略限制登录方式或修复后仍返回 401 时，工作流停止并保留证据，不循环重试。

## 固定排查方向

### 1. 配置层

- 使用 CyberBoss 实际加载的环境，而不是当前终端的猜测值。
- 显示默认 Codex 目录和专用 `CODEX_HOME` 的规范化路径。
- 检查两处凭据状态，明确报告是否存在双凭据仓库。
- 普通 CLI 已登录不能推出 CyberBoss 已登录。

### 2. 浏览器回调层

从 `codex-login.log` 区分：

- 未收到 callback：排查 `localhost:1455`、远程环境或浏览器流程；
- 收到 callback 且 `state_valid=true`：浏览器授权已经完成；
- OAuth token exchange 失败：排查 CLI 到认证服务的网络和 TLS，不再重复折腾浏览器。

普通浏览器流程不可用时，工作流优先启动 `codex login --device-auth`。

### 3. 凭据层

登录成功必须经过四项验证：

1. `auth.json` 真实存在；
2. 文件非空；
3. 文件能重新打开并解析；
4. 相同 `CODEX_HOME` 下的 `codex login status` 明确返回 ChatGPT 已登录。

终端出现 `Successfully logged in` 不能代替文件和重开验证。

### 4. 进程层

下列任一信号都不能单独证明目标 App Server 身份：

- PID 文件存在；
- PID 仍然存活；
- 端口可以连接；
- `/readyz=ok`。

停止进程前必须同时验证：

- 真实监听目标端口的 PID；
- 进程路径与配置中的 Codex 可执行文件一致；
- 启动参数包含 `app-server` 和目标端口。

PID 文件与监听 PID 不一致时，PID 文件标记为陈旧。不得停止 PID 文件指向的未知进程。

### 5. 业务验收层

真实探针必须检查模型数量、回合状态和最终文本。出现 `turn/completed` 事件并不等于回合成功；`failed` 和 `interrupted` 也可能结束事件流。

## 机器可读结果

第一版使用以下稳定结果代码：

```text
DIAGNOSIS_COMPLETE
CONFIG_INVALID
PLATFORM_UNSUPPORTED
CLI_NOT_FOUND
CODEX_HOME_NOT_WRITABLE
AUTH_MISSING
AUTH_FILE_INVALID
CLI_STATUS_UNAUTHENTICATED
DEVICE_AUTH_FAILED
AUTH_NETWORK_FAILED
APP_SERVER_NOT_RUNNING
APP_SERVER_START_FAILED
APP_SERVER_IDENTITY_UNVERIFIED
APP_SERVER_UNAUTHORIZED
APP_SERVER_TURN_FAILED
APP_SERVER_REPLY_MISMATCH
REPAIR_SUCCEEDED
```

JSON 输出至少包含：

```json
{
  "result": "REPAIR_SUCCEEDED",
  "platform": "win32",
  "codexHome": "C:\\path\\to\\dedicated-codex-home",
  "credentialFileExists": true,
  "credentialFileReopened": true,
  "cliAuthMode": "chatgpt",
  "appServerPort": 8765,
  "pidFilePid": 20468,
  "listenerPid": 20468,
  "appServerIdentityVerified": true,
  "appServerRestarted": true,
  "modelCount": 6,
  "turnStatus": "completed",
  "replyMatched": true
}
```

不得在 JSON 中包含令牌、授权码、Cookie 或完整敏感日志。

## 人类可读输出

每一阶段输出稳定前缀：

```text
[PASS] CyberBoss CODEX_HOME resolved
[FAIL] Dedicated profile is not logged in
[ACTION] Device-code login required
[PASS] auth.json exists and reopens successfully
[STALE] PID file does not match the real listener
[PASS] App Server identity verified
[ACTION] Restarted verified App Server
[PASS] Real model probe returned CYBERBOSS_AUTH_OK
RESULT=REPAIR_SUCCEEDED
```

弱模型只需要按照最后一个结果代码和紧邻的失败证据决定下一步。

## 安全边界

### 自动执行

- 读取并验证配置；
- 检查专用凭据；
- 发起设备码登录并等待用户完成；
- 验证凭据文件；
- 探测 App Server；
- 没有监听进程时启动 App Server；
- 在身份完全匹配时重启 App Server；
- 发起真实模型请求并输出报告。

### 必须停止

- `CODEX_HOME` 或 Codex 路径不明确；
- 监听端口存在多个拥有者；
- 可执行路径与配置不一致；
- 启动参数无法证明进程是目标 App Server；
- 设备码登录被拒绝或超时；
- 企业策略强制不同登录方式；
- 修复后真实探针仍返回 401。

### 永远禁止

- 输出或记录令牌；
- 删除 `auth.json`；
- 自动执行 `codex logout`；
- 停止身份未验证的进程；
- 启动或重启微信桥接；
- 修改系统网络或安全设置；
- 将测试线程绑定到微信会话。

## 已知陷阱与禁止推断

- 默认 `.codex` 登录成功不等于 CyberBoss 专用目录已登录。
- 浏览器持续转圈不等于 localhost 回调一定失败。
- 沙箱内网络失败不等于 Windows 主机真实网络失败。
- `readyz=ok` 不等于 App Server 已认证。
- PID 存活不等于它仍是原来的 App Server。
- 内容已整理或命令输出成功不等于凭据文件已生成，必须重新打开验证。
- `turn/completed` 出现不等于回合成功，必须检查 `turn.status`。
- 没取到回复文本不等于登录成功，失败回合也会正常结束事件流。
- App Server 在登录前启动后可能缓存未认证状态，必须用真实探针判断是否需要重启。
- PID 文件可能因为进程退出和 PID 复用而指向无关进程，绝不能直接据此停止。

## 测试策略

### 单元测试

- 默认目录和专用 `CODEX_HOME` 的识别；
- `auth.json` 缺失、空文件、损坏和有效文件；
- callback 未到达、callback 有效但换令牌失败的日志分类；
- PID 文件与真实监听 PID 一致和不一致；
- 路径、参数或端口任一不匹配时拒绝停止；
- `turn.status` 为 `completed`、`failed` 和 `interrupted`；
- 回复为空或固定文本不匹配；
- JSON 输出不包含敏感字段。

### Windows 集成测试

使用假 Codex 可执行文件、假 App Server 和临时目录，不触碰真实账号：

- 未登录到设备码成功再到凭据生成；
- 旧 App Server 返回 401；
- 安全重启后真实探针成功；
- PID 被其他进程复用时拒绝停止；
- `/readyz=ok` 但模型请求 401 时不得误报成功；
- 网络检查在隔离环境失败时报告环境受限，而不是直接判定主机断网。

### 真实 Windows 手动验收

```text
npm run codex:auth-repair
npm run codex:auth-repair -- --diagnose-only
npm run codex:auth-repair -- --json
```

必须确认：

- 凭据文件真实存在并能重新打开；
- 相同专用 `CODEX_HOME` 返回已登录；
- PID 文件等于真实监听 PID；
- App Server 真实请求返回固定文本；
- 命令退出码为 0；
- 再次运行保持幂等，不重复登录或重启。

## GitHub 发布内容

- `npm run codex:auth-repair` 公开入口；
- 中文主手册 `docs/codex-auth-repair.zh-CN.md`；
- README 中的简短英文入口和平台限制；
- 决策树式故障分类；
- 本次踩坑与禁止推断清单；
- JSON 输出示例；
- 安全边界说明；
- Windows 第一版限制；
- 平台适配器接口说明。

## 成功标准

实现满足以下全部条件才算完成：

- 一条命令能在 Windows 上完成诊断、必要的设备码登录、安全 App Server 重启和真实验收；
- 所有停止进程操作都以端口、路径和启动参数三重验证为前置条件；
- 工作流不会触碰微信桥接；
- 登录结果经过凭据文件存在、重新解析和 CLI 状态三重验证；
- 最终成功必须由真实 App Server 模型回包证明；
- 失败均映射为稳定结果代码和非敏感证据；
- 自动化测试覆盖本次遇到的双凭据目录、旧进程缓存、PID 文件陈旧和 `readyz` 假阳性；
- 文档足以让能力较弱的模型按固定顺序执行，不依赖隐含背景知识。
