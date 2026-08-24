# 通用 Codex CLI / App Server 认证修复工作流设计

## 背景

CyberBoss 已经有一套经过真实 Windows 故障验证的 Codex 认证修复工作流，但第一版公开入口仍然读取 `CYBERBOSS_*` 环境变量，使用 CyberBoss 的 PID、日志和 MCP 配置，因此只能被称为 CyberBoss preset，不能直接宣称适用于其他应用。

OpenAI 官方将 Codex App Server 定位为把 Codex 深度嵌入自有产品的协议接口，而不是某个特定应用的私有能力。认证缓存也可能存储在 `CODEX_HOME/auth.json` 或系统凭据存储中。因此，通用化不能只替换名称；必须抽离应用配置、凭据存储、transport、进程所有权和用户交互。

本设计继承 [CyberBoss 专用版本设计](./2026-08-25-codex-auth-repair-workflow-design.md) 中已经验证的安全原则，并把 CyberBoss 降级为一个内置应用 preset。

## 目标

- 第一版可靠支持所有显式配置的 Windows 应用。
- 核心接口不依赖 Windows，允许未来增加 macOS 和 Linux 平台适配器。
- 支持本地 stdio、本地 WebSocket 和远程 WebSocket/WSS 三类 App Server 连接。
- 支持 `file`、`keyring` 和 `auto` 三种 Codex 凭据存储策略。
- 识别 ChatGPT、API key、Codex access token、workload identity 和自定义 provider。
- 只对 ChatGPT 登录自动发起设备码流程。
- 只管理工作流拥有或明确声明为独立 Codex App Server 的进程。
- 对宿主应用拥有或远程进程只验证并给出人工操作说明。
- 在交互式 Windows 环境中，用终端说明和系统对话框解释被安全策略阻止的动作。
- 保持 CyberBoss 旧命令兼容。
- 生成可发布到 GitHub、足以让较弱模型执行的通用文档和示例 profile。

## 非目标

- 第一版不实现 macOS 或 Linux 进程适配器。
- 不自动扫描所有进程、端口、`.env` 或用户目录来猜测应用配置。
- 不自动停止或重启宿主应用。
- 不接受任意 stop/start shell hook。
- 不管理远程 App Server 进程。
- 不在 profile 中保存 API key、access token、Cookie 或 WebSocket bearer token。
- 不自动配置系统代理、防火墙、VPN、证书或企业身份策略。
- 不把实验性的 WebSocket transport 描述为生产级远程服务管理方案。

## 发布形态

通用核心保留在 CyberBoss 仓库中。CyberBoss 是第一个内置 preset，其他应用通过 JSON profile 使用同一 CLI。核心边界稳定后可以原样拆成独立 package，但本次不拆仓库。

公开入口：

```powershell
# 任意应用
npm run codex:auth-repair -- --profile .\my-app.codex.json

# 白名单临时覆盖
npm run codex:auth-repair -- --profile .\my-app.codex.json --port 9000

# 明确使用 CyberBoss preset
npm run codex:auth-repair -- --preset cyberboss

# 旧用法，暂时映射到 CyberBoss preset
npm run codex:auth-repair
```

无参数旧用法的结果中必须显示：

```text
profileSource=cyberboss-default
```

## 架构

### 通用核心

通用核心只能接收标准化 profile，不得读取或引用 `CYBERBOSS_*`：

- profile schema、加载、路径解析和白名单覆盖；
- Codex 命令与 `CODEX_HOME` 解析；
- 凭据存储和认证方式诊断；
- ChatGPT 设备码登录；
- stdio、WebSocket 和 WSS transport；
- Windows 独立 App Server 进程适配器；
- `account/read`、模型列表和真实回合探针；
- 通用状态机、事件、结果代码和退出码；
- 人类输出、JSON 输出和 Windows 对话框渲染。

### 应用 preset

preset 负责把应用现有配置转换为标准 profile。CyberBoss preset 可以读取当前 `.env`、MCP 参数、状态目录、PID 文件和日志路径，但转换完成后通用核心只看到标准字段。

任何新应用只需要新增 profile 或 preset，不得复制状态机。

### 平台适配器

核心通过平台接口执行：

- 解析命令路径；
- 查找监听 PID；
- 读取进程路径和命令行；
- 安全停止已验证进程；
- 显示用户对话框。

第一版只有 Windows 实现。其他平台返回 `PLATFORM_OPERATION_UNSUPPORTED`，但不影响远程 verify-only 工作流和未来扩展接口。

## JSON profile

### 示例

```json
{
  "version": 1,
  "name": "my-application",
  "codex": {
    "command": "C:\\Tools\\codex.exe",
    "home": "C:\\Profiles\\my-application-codex",
    "credentialStore": "auto",
    "expectedAuthMode": "chatgpt"
  },
  "appServer": {
    "transport": "websocket",
    "endpoint": "ws://127.0.0.1:8765",
    "ownership": "independent",
    "args": [],
    "pidFile": "C:\\State\\my-application\\app-server.pid",
    "logFile": "C:\\State\\my-application\\app-server.log"
  },
  "probe": {
    "cwd": "C:\\Work\\my-project"
  }
}
```

### 字段

`version` 必须为整数 `1`。`name` 是稳定、非空的应用标识。

`codex`：

- `command`：Codex 可执行文件绝对路径或可由 Windows `Get-Command` 唯一解析的命令名；
- `home`：本应用实际使用的 `CODEX_HOME`；
- `credentialStore`：`file`、`keyring` 或 `auto`；
- `expectedAuthMode`：`chatgpt`、`apikey`、`access-token`、`workload-identity`、`custom-provider` 或 `any`。

`appServer`：

- `transport`：`stdio`、`websocket` 或 `wss`；
- `endpoint`：WebSocket/WSS 必填；stdio 禁止填写；
- `ownership`：`workflow`、`independent`、`host` 或 `external`；
- `args`：传给独立 Codex App Server 的非敏感参数数组；
- `pidFile`、`logFile`：仅本地独立进程可用；
- `wsAuthTokenEnv`：可选，只保存 bearer token 的环境变量名称；
- `sshForwarded`：非 localhost `ws://` 仅在显式为 `true` 时允许连接。

`probe.cwd` 是测试线程工作目录。

### 路径和环境变量

- profile 必须真实存在、非空、能重新打开并解析；
- 相对路径一律相对于 profile 所在目录；
- profile 只允许 `${VARIABLE_NAME}` 形式的非敏感路径变量展开；
- `wsAuthTokenEnv` 只读取指定环境变量的值用于握手，值不得进入结果、日志或异常文本；
- schema 拒绝未知的 secret、token、password、cookie、apiKey 和 accessToken 字段；
- profile 中出现明确敏感字段时返回 `SECRET_IN_PROFILE`。

### 配置优先级

```text
白名单 CLI 覆盖
  > JSON profile
  > 应用 preset
  > Codex 安全默认值
```

允许覆盖：

- `--codex-command`
- `--codex-home`
- `--credential-store`
- `--expected-auth-mode`
- `--transport`
- `--endpoint`
- `--port`
- `--workspace`
- `--diagnose-only`
- `--json`
- `--no-restart`
- `--no-dialog`

ownership、PID 文件、日志路径和任意启动/停止命令不能通过临时 CLI 覆盖，避免弱化 profile 的安全边界。

## 认证诊断

### 凭据存储

`file`：

- 要求 `CODEX_HOME/auth.json` 存在、非空、能重新打开并解析；
- 只报告存在性、字节数和解析状态；
- 不返回任何字段值。

`keyring`：

- 不要求 `auth.json`；
- 以相同环境下的 `codex login status` 和 App Server `account/read` 为证据。

`auto`：

- 文件存在与否只能作为证据，不能决定认证结果；
- 仍以 CLI 和 App Server 的认证状态为准。

### 认证方式

工作流把 CLI 和 `account/read` 的版本相关原始状态归一化为：

- `chatgpt`
- `apikey`
- `access-token`
- `workload-identity`
- `custom-provider`
- `none`
- `unknown`

实际模式必须符合 `expectedAuthMode`。`any` 接受除 `none` 和 `unknown` 外的任一有效模式。

只有期望模式为 `chatgpt` 且当前未登录时，默认修复模式才能执行：

```text
codex login --device-auth
```

设备码登录结束后必须重新运行完整凭据诊断。退出文本不能代替状态验证。

其他模式只给出非敏感结果：

- `API_KEY_REQUIRED`
- `ACCESS_TOKEN_REQUIRED`
- `WORKLOAD_IDENTITY_UNAVAILABLE`
- `CUSTOM_PROVIDER_AUTH_REQUIRED`
- `AUTH_MODE_MISMATCH`

工作流不得提示用户把密钥作为 CLI 参数传入，也不得读取、复制或打印密钥。

## Transport

### stdio

`ownership=workflow`：

- 使用 profile 的命令、`CODEX_HOME` 和非敏感参数启动临时 App Server；
- 通过 stdin/stdout 完成完整 JSON-RPC 探针；
- 在 `finally` 中关闭临时进程；
- 不需要端口或 PID 文件。

`ownership=host`：

- 不尝试接管宿主应用的私有 stdio；
- 启动一个配置相同的临时 App Server 验证凭据和 Codex 配置；
- 临时探针成功只证明独立配置有效，不能证明宿主进程已刷新；
- 返回 `HOST_APPLICATION_RESTART_REQUIRED` 和用户操作说明，不结束宿主应用。

stdio 不允许 `independent` 或 `external` ownership。

### 本地 WebSocket

`workflow` 或 `independent` ownership 可管理独立 App Server，但重启前必须同时验证：

1. 目标 endpoint 只有一个真实监听 PID；
2. 可执行路径与解析后的 Codex 命令一致；
3. 命令行包含 `app-server`；
4. 命令行包含完整监听 endpoint；
5. ownership 允许管理。

PID 文件只能标记 `match`、`stale`、`missing` 或 `unknown`，不能单独证明身份。多个监听者、路径不符、参数不符或查询权限不足时禁止停止进程。

`host` ownership 可以连接并探针，但 401 时只能返回 `HOST_APPLICATION_RESTART_REQUIRED`。

### 远程 WebSocket/WSS

- ownership 必须为 `external`；
- 只允许连接、`account/read`、模型列表和真实回合验证；
- 不执行任何进程查询、启动或重启；
- 非 localhost 的 `ws://` 默认返回 `REMOTE_TLS_REQUIRED`；
- 只有 `sshForwarded=true` 才允许非 localhost 明文 WebSocket；
- WSS bearer token 通过 `wsAuthTokenEnv` 注入 `Authorization` header，不进入报告。

OpenAI 官方目前仍将 WebSocket transport 标记为实验性和不受支持。通用文档必须保留此限制，并推荐远程连接使用 WSS 和 transport authentication。

## App Server 真实探针

默认修复模式的完整探针顺序：

1. 建立 transport；
2. `initialize`；
3. `initialized`；
4. `account/read`；
5. `model/list`；
6. `thread/start`；
7. `turn/start`，要求只回复 `CODEX_AUTH_REPAIR_OK`；
8. 等待并检查 `turn/completed.turn.status`；
9. 读取最终 `item/completed` 的 `agentMessage`；
10. 尽力归档测试线程；
11. stdio 临时进程在 `finally` 中关闭。

成功必须同时满足：

```text
account/read 与 expectedAuthMode 一致
modelCount > 0
turn.status == completed
reply == CODEX_AUTH_REPAIR_OK
```

`/readyz` 仅用于本地 WebSocket 进程启动等待，不能代替认证探针。

## 通用状态机

```text
加载并重新打开 profile
  -> 合并白名单覆盖
  -> 解析 Codex 命令和 CODEX_HOME
  -> 检查 credentialStore
  -> codex login status
  -> 归一化并核对 expectedAuthMode
  -> ChatGPT 未登录时执行 device-auth
  -> 重新验证认证状态
  -> 按 transport 建立 App Server 连接
  -> account/read + model/list + 真实回合
  -> 成功则结束
  -> 401 或缓存认证失败时判断 ownership
  -> host/external：阻止进程动作并要求用户处理
  -> workflow/independent：严格验证进程身份
  -> 身份完全匹配时重启一次
  -> 再执行一次完整探针
  -> 输出成功、失败或用户操作结果
```

修复后仍失败时停止，不循环登录或重启。

`--diagnose-only` 只做 profile、命令、`CODEX_HOME`、凭据状态、endpoint 和本地进程身份检查；不登录、不重启、不创建模型回合。

## 用户交互和对话框

安全策略阻止自动进程操作时，状态机继续生成完整说明。结果至少包含：

```json
{
  "userActionRequired": true,
  "blockedAction": "restart_app_server",
  "reason": "host_owned_process",
  "recommendedActions": [
    "Save your work, restart MyEditor, then rerun the probe."
  ]
}
```

以下条件全部满足时显示 Windows 系统对话框：

- 当前为 Windows；
- stdin 和 stdout 都是交互终端；
- 未设置 `--json`；
- 未设置 `--no-dialog`；
- 未检测到 CI 环境；
- 结果要求用户操作。

对话框标题固定为“Codex 修复需要人工处理”，内容说明被阻止的动作、原因和下一步。对话框不得提供强制结束进程选项，不得包含 token、密钥、Cookie 或完整环境变量。

对话框显示失败只产生警告，不覆盖原始结果或退出码。终端始终输出相同结果对象生成的详细说明。

## 结果协议

JSON 顶层结构：

```json
{
  "schemaVersion": 1,
  "profileName": "my-application",
  "profileSource": "file",
  "result": "REPAIR_SUCCEEDED",
  "userActionRequired": false,
  "blockedAction": null,
  "reason": null,
  "stages": [],
  "evidence": {},
  "recommendedActions": []
}
```

事件级别：

- `PASS`
- `FAIL`
- `ACTION`
- `BLOCKED`
- `STALE`
- `INFO`

`BLOCKED` 表示诊断已继续完成，但危险动作被安全策略阻止。

### 稳定结果代码

配置：

- `DIAGNOSIS_COMPLETE`
- `PROFILE_NOT_FOUND`
- `PROFILE_INVALID`
- `SECRET_IN_PROFILE`
- `CLI_NOT_FOUND`
- `CODEX_HOME_UNAVAILABLE`
- `PLATFORM_OPERATION_UNSUPPORTED`

认证：

- `AUTH_MISSING`
- `AUTH_MODE_MISMATCH`
- `DEVICE_AUTH_FAILED`
- `AUTH_NETWORK_FAILED`
- `API_KEY_REQUIRED`
- `ACCESS_TOKEN_REQUIRED`
- `WORKLOAD_IDENTITY_UNAVAILABLE`
- `CUSTOM_PROVIDER_AUTH_REQUIRED`

transport：

- `TRANSPORT_UNREACHABLE`
- `REMOTE_TLS_REQUIRED`
- `WS_AUTH_REQUIRED`
- `APP_SERVER_START_FAILED`

进程：

- `PROCESS_IDENTITY_UNVERIFIED`
- `MULTIPLE_LISTENERS`
- `HOST_APPLICATION_RESTART_REQUIRED`
- `EXTERNAL_PROCESS_ACTION_REQUIRED`

探针：

- `ACCOUNT_READ_FAILED`
- `MODEL_LIST_FAILED`
- `TURN_FAILED`
- `REPLY_MISMATCH`
- `REPAIR_SUCCEEDED`

### 退出码

- `0`：完整修复成功或只读诊断成功；
- `1`：确定失败；
- `2`：需要用户操作；
- `3`：配置或命令调用错误。

人类输出、对话框和 JSON 必须由同一个结果对象渲染。

## CyberBoss 兼容层

CyberBoss preset 转换：

- `CYBERBOSS_CODEX_COMMAND` -> `codex.command`
- `CODEX_HOME` -> `codex.home`
- `CYBERBOSS_SHARED_PORT` -> 本地 WebSocket endpoint
- CyberBoss 状态目录 -> PID 和日志路径
- CyberBoss MCP 配置 -> `appServer.args`
- CyberBoss 工作区 -> `probe.cwd`
- ownership -> `independent`

无参数旧入口仍输出当前兼容结果代码。通用内部代码可以使用新名称，但 preset 必须维护旧代码映射，避免已有脚本突然失效。

工作流不得诊断、启动或重启微信桥接。

## 测试策略

### 单元测试

- profile 缺失、空文件、损坏、版本错误和敏感字段；
- 相对路径、环境变量和白名单 CLI 覆盖；
- `file`、`keyring`、`auto`；
- 所有 expected auth modes；
- 只有 ChatGPT 进入设备码登录；
- stdio 临时进程启动、探针、超时和关闭；
- 本地 WebSocket 401、单次重启和再次探针；
- host ownership 只产生人工操作结果；
- 多监听者、路径不符、参数不符和权限不足时零进程终止；
- 远程 WSS verify-only；
- 非本地明文 WebSocket 默认拒绝；
- WebSocket token 仅从环境变量读取且从所有输出中脱敏；
- `--json`、CI、非 TTY 和 `--no-dialog` 不显示对话框；
- 对话框内容不包含敏感字段；
- 人类输出、JSON 和对话框由同一结果对象生成；
- CyberBoss 旧入口和结果代码兼容。

### Windows 集成测试

使用假 Codex CLI、假 keyring 状态、假 stdio App Server、假 WebSocket App Server和临时目录，不触碰真实账号：

- ChatGPT 未登录 -> 设备码成功 -> account/read -> 模型探针成功；
- keyring 模式没有 auth.json 但登录有效；
- 旧独立 App Server 401 -> 身份验证 -> 重启 -> 成功；
- host App Server 401 -> 弹窗适配器被调用 -> 退出码 2 -> 无进程终止；
- 多监听者 -> BLOCKED -> 无进程终止；
- stdio host 验证成功 -> 要求重启宿主；
- 远程 WSS bearer header 正确注入但报告中没有 token。

### 真实验收

发布前在 Windows 上执行：

```powershell
npm run codex:auth-repair -- --preset cyberboss --diagnose-only
npm run codex:auth-repair -- --preset cyberboss --json
npm run codex:auth-repair -- --profile .\templates\codex-auth-profiles\stdio.example.json
npm run codex:auth-repair -- --profile .\templates\codex-auth-profiles\websocket.example.json
```

最终确认：

- profile 和生成的文档真实存在、能重新打开；
- CyberBoss 旧入口仍幂等；
- 通用 profile 不含本机凭据；
- stdio 和本地 WebSocket 真实探针通过；
- PID 文件与真实监听 PID 一致；
- 不触碰微信桥接；
- JSON 可重新解析；
- 对话框在交互模式出现，在 JSON/CI 中不出现。

## 文档和示例

- 把 `docs/codex-auth-repair.zh-CN.md` 改写为通用《Codex CLI / App Server 认证修复手册》；
- CyberBoss 移入“内置 preset 示例”；
- 增加完整 profile 字段参考；
- 增加 stdio、本地 WebSocket 和远程 WSS 示例；
- 增加各种认证方式的安全边界；
- 增加 Windows 对话框行为说明；
- 增加适合较弱模型执行的固定提示；
- 创建 `templates/codex-auth-profiles/`；
- README 保留通用入口和 Windows 第一版限制；
- 明确 WebSocket transport 当前是实验性能力。

## Git 和 GitHub 发布语义

- `git commit` 只称为“本地提交”；
- 只有 `git push` 成功并重新读取远程 commit 后，才能称为“已发布到 GitHub”；
- 当前本地 `main` 相对 `origin/main` 包含多项未推送提交，因此通用化实现不自动 push；
- 发布前必须单独确认要推送的分支和提交范围；
- 不得把用户未跟踪文件加入提交。

## 官方参考

- [OpenAI Codex Authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 成功标准

- 任意 Windows 应用可通过显式 JSON profile 使用同一修复 CLI；
- 通用核心不读取 `CYBERBOSS_*`；
- CyberBoss 仅作为 preset，并保持旧入口兼容；
- file/keyring/auto 和所有约定认证方式均有明确行为；
- stdio、本地 WebSocket 和远程 WSS 均遵守各自 ownership 边界；
- 自动重启只发生在身份完全验证的独立 App Server；
- 被阻止的动作会通过终端、结构化结果和适用时的 Windows 对话框解释；
- 不存在强制结束未知进程的旁路；
- 成功必须经过 `account/read`、模型列表、回合状态和固定回复验证；
- 自动化测试覆盖原始故障、通用 profile、keyring、stdio、host ownership、远程 WSS 和弹窗抑制；
- 文档足以让较弱模型按固定顺序完成修复；
- 本地提交与 GitHub 发布状态不会再混淆。
