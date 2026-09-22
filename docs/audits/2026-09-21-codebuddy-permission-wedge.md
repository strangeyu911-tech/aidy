# 2026-09-21 — 微信「对方正在输入」但收不到消息：CodeBuddy 权限吊死根因

> 状态：**源码已修 + 真链路单轮验证通过 + 全量测试通过**。打包产物与微信端到端收发仍待验收。

## 1. 报告的症状

- Aidy 前端显示「微信已连接 / 连接不稳定 · 微信回复和监管安排已启用。」
- 微信里能看到「对方正在输入」
- 但**收不到任何回复**

与 2026-09-20 那次（`docs/audits/` 前序记录、`rpcCode -14` 登录过期 + 前端谎报已连接）**症状相同、根因完全不同**。上一次修的是登录态与心跳层，这一次坏在**运行时权限层**。

## 2. 证据链（全部来自本机真实落盘数据）

### 2.1 桥接侧：8 轮 0 成功

`~/.cyberboss/logs/bridge.jsonl`（2026-09-21）：

- `runtime.turn.started` = 8，`runtime.turn.succeeded` = **0**，`runtime.turn.failed` = 7
- 7 次失败中 6 次是 `CODEBUDDY_START_TIMEOUT`，`timeoutKind=overall_turn`，`timeoutStage=streaming_nonterminal`，`latencyMs≈120000`，`errorCode=CODEBUDDY_START_TIMEOUT`
- 每次失败后紧跟 `reply.skipped`（`reason: runtime_failed`）→ **微信侧永远不会收到回复**

关键细节（`runtime.acp.request.aborted`）：

```
sseEventCount: 1
lastEventMethod: "session/update"
lastSessionUpdate: "session_info_update"
terminalEventSeen: false
lastEventMatchesRequest: false
abortSource: "client_timeout"
```

即：**HTTP 200、只回 1 个 `session_info_update` 事件，然后 120 秒空转**。

### 2.2 网关侧：run 被钉死在 `waiting_for_permission`

`~/.codebuddy/logs/2026-09-21/resources__*.log`（pid 19504，Aidy 自己拉起的托管网关）：

```
17:07:44.370  sessionId=014944d1-... permissionMode=default
17:08:03.597  [ToolPermission-Default] Read inTrustedDirectories=false
              filePath=C:\Users\23159\.cyberboss\Strange-profile.md
17:08:03.598  [tool-permission] ASK tool=Read mode=default "Approval required for Read"
17:08:03.610  [SessionRunStateMachine] WAITING_FOR_PERMISSION
              from=model_done -> to=waiting_for_permission
17:08:03.808  [HandleInterruptions] Approval dialog shown ... waiting for user response...
17:37:15.835  [AcpView][PromptIterator] route=deferUntilIdle:parkInQueue
              runState=waiting_for_permission queueLen=1
17:39:24.715  ... queueLen=2
17:42:02.515  ... queueLen=3
17:46:30.599  ... queueLen=4
17:54:40.647  ... queueLen=5
17:56:41.176  ... queueLen=6
17:58:42.397  ... queueLen=7
```

**没有人回答那个批准对话框。** 此后每条消息都被 `parkInQueue` 排队，队列 1→7 单调增长，永不执行。

### 2.3 交叉定位：拒绝响应发出后 13 毫秒，传输层被拆掉

叠加 `bridge.jsonl` 与网关日志：

```
17:08:03.619  bridge: runtime.approval.response.started   phase=automatic_denial
17:08:03.627  gateway: starting POST /api/v1/acp          ← Aidy 发的 session/respond_permission
17:08:03.629  gateway: ending POST /api/v1/acp [2ms]      ← 无 handlePost 映射行
17:08:03.632  bridge: runtime.transport.lifecycle         lifecycle=connection_lost
17:08:03.632  bridge: runtime.acp.response.error          method=session/respond_perm  CODEBUDDY_CONNECTION_LOST
17:08:03.633  bridge: runtime.approval.response.failed    phase=automatic_denial
17:08:03.636  bridge: runtime.acp.response.error          method=session/prompt       CODEBUDDY_CONNECTION_LOST
17:08:04.009  bridge: runtime.transport.lifecycle         lifecycle=connected（新 generation）
```

网关那条 POST 没有任何 `handlePost: messages=<method>` 映射行 —— 说明它**没有走到 StreamManager**。

## 3. 根因（三层叠加）

1. **托管网关以 `permission-mode=default` 启动**（`process-host.js` 从不传 `--permission-mode`），所以 workspace 之外的文件读取会走交互式批准。
2. **Aidy 的客户端把「单个请求被服务器拒绝」当成「传输死亡」**：`client.js` 里 HTTP 非 2xx 与真正的 fetch 失败都用同一个 `CODEBUDDY_CONNECTION_LOST` 码，catch 里一律调用 `markDisconnected()`；而 `markDisconnected()` 会 **abort 所有在途请求** —— 包括那条正在发送的 `session/respond_permission`。拒绝因此永远送不到，run 永久停在 `waiting_for_permission`。
3. **现有恢复动作无效**：`resetOrdinarySessionAfterTimeout()` 只做 `session/new`，而吊死的是 CLI **内部按 workspace 归属的会话**（`014944d1-...`），`session/new` 清不掉它。这就是 6 次连续超时、每次后面都跟一次 `session/new`、却全部继续超时的原因。

同时运行时的失败被上报为通用超时，前端最终渲染成「连接不稳定」——那是轮询被 120 秒阻塞的**副作用**，不是独立故障。

## 4. 修复（`--permission-mode` 由 CLI 内部裁决）

从 CLI 自身 bundle 确认的语义：

> `dontAsk` — "Never shows permission prompts; runs pre-approved and safe actions, **denies anything that would require approval**"

这正是 Aidy 能力模式**本来就是**想做的事（`automatic_denial`），只是改由 CLI 内部完成，**整条易碎的回边被消除**。

改动：

| 文件 | 改动 |
| --- | --- |
| `src/adapters/runtime/codebuddy/process-host.js` | `start()` 新增 `permissionMode`；非 `default` 时追加 `--permission-mode <mode>`；非法取值报 `CODEBUDDY_API_INCOMPATIBLE` |
| `src/adapters/runtime/codebuddy/runtime-adapter.js` | supervisor 模式传 `dontAsk`（developer 模式仍传 `default`，因为那是**故意**要让控制中心应答的）；权限拒绝响应改为 `respondToPermissionResilient()`，失败重试一次并显式记录，不再 `.catch(() => {})` 静默吞掉；连续 2 次非终态超时升级为**重启托管网关** |
| `src/adapters/runtime/codebuddy/client.js` | HTTP 非 2xx 单列为 `httpStatusFailure()`（携带 `httpStatus`），**不再** `markDisconnected()`；只有真正的 fetch 级故障才拆传输 |

## 5. 验证

### 5.1 真链路单轮验证（不打包，直接用改后源码驱动真实网关）

`D:\tmp\probe-permission-mode.js`，真实 WorkBuddy CLI（2.137.1）+ 真实模型 `hy3` + 真实 ACP 传输，故意要求读取 workspace 之外的文件：

| | 线上（default，事故现场） | 探针（dontAsk） |
| --- | --- | --- |
| 客户端收到 `session/request_permission` | 1 次 | **0 次** |
| 客户端发 `session/respond_permission` | 1 次（未送达） | 不需要 |
| 结果 | 钉死 `waiting_for_permission`，连续 6×120s 超时 | **`TURN_COMPLETED`，19.0s，`stop_reason=end_turn`** |
| SSE 事件数 | 1 | 96 |
| 回复 | 无 | 有（35 字符，模型自行降级读取成功） |

> 探针必须先从环境里清掉 50 个 `CODEBUDDY_*` 变量。**本 shell 由 WorkBuddy 托管，会注入 `CODEBUDDY_GATEWAY_PASSWORD`**，被子进程继承后会盖掉 overlay 文件里的密码，导致 401（`CODEBUDDY_AUTH_FAILED`）。Aidy 从资源管理器启动没有这个问题。

### 5.2 单元测试

- 全量：**711 tests / 710 pass / 0 fail / 1 skip**（改动前基线 708/707）
- 新增 3 条：非默认权限模式透传 `--permission-mode`、拒绝响应重试、HTTP 拒绝不拆传输
- **改写 2 条既有用例**（诚实记录）：`codebuddy-acp-smoke.test.js` 与 `codebuddy-lifecycle.test.js` 原先用 `HTTP 503` 断言「整个传输被拆掉、在途请求被 abort」——那正是本次事故的成因，属于把缺陷写成了断言。现改为：HTTP 拒绝保持传输，真 fetch 级故障才拆传输。

## 6. 遗留与未覆盖

1. **能力姿态的一处语义差异**：`dontAsk` 会**放行「安全的只读动作」**（探针里模型就据此读到了文件），而旧的 `automatic_denial` 是**一律拒绝**。若要求更严的隔离，可再加 `--tools ""`（禁用全部内置工具，只保留 `--allowedTools` 白名单里的 MCP 工具），但该参数尚未验证，未纳入本次改动。
2. **微信端到端收发未验收**：本轮证据止于「运行时能正常出回复」。真实微信收发需要重新打包后由用户实机验证。
3. `session/respond_permission` 被网关拒绝的确切原因未完全定位（网关只回了非 2xx，且未走 StreamManager）。本次通过消除该回边绕开了它，未修其本体。
4. 打包产物、三条发布闸门、开始菜单指向见下一节跟进。

## 7. 复现本诊断的最短路径

```text
1) tail ~/.cyberboss/logs/bridge.jsonl | 找 runtime.turn.failed
   → CODEBUDDY_START_TIMEOUT + terminalEventSeen:false + sseEventCount:1 = 非终态空转
2) 打开 ~/.codebuddy/logs/<日期>/resources__*.log（Aidy 的托管网关日志）
   → grep waiting_for_permission / parkInQueue
   → queueLen 单调增长 = run 被吊死，且在按 workspace 归属的内部会话上
3) 叠加两侧时间戳，看 connection_lost 是否紧跟在 approval.response.started 之后
   → 是 = 权限回边被传输拆卸打断
4) 判定「连接不稳定」是轮询被 120s 阻塞的副作用，不是独立故障
```
