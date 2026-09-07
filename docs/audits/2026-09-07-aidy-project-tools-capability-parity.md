# Aidy Project Tools / autonomous capability parity audit

日期：2026-09-07（Asia/Shanghai）  
范围：Aidy 相比 `WenXiaoWendy/cyberboss` 的 Project Tools / autonomous capability parity，以及“日记不自动写、报表不自动生成”的证据审计。  
结论状态：**AUDIT COMPLETE — NO PRODUCTION CHANGE**。本轮没有修改 production runtime、没有重启当前实例、没有更新安装包、没有发送微信、没有写入真实 diary 或触发 outbound。

### 2026-09-07 evidence refresh

本次复核发现本审计目录此前已存在且仍是未跟踪用户文件；按要求沿用并更新，没有覆盖或删除其他用户修改。新增的只读证据：

- `git status --short --branch`：`main...origin/main [ahead 3]`，另有既存未跟踪 `docs/audits/`；HEAD 仍为 `75dc0d9d0681508a054e56be5afd115d499c0f73`。
- 直接读取上游公开 `main` 的 ProjectToolHost、system-checkin-poller、DiaryService、timeline integration 和 operations template；本轮不再把本地 `upstream/main` ref 当作“远端最新 commit”证明。
- 在隔离临时 state dir 中通过实际 `tool-mcp-server` stdio 发出 `initialize` + `tools/list`：返回 23 个工具，包含 `cyberboss_diary_append` 和全部 timeline/whereabouts 工具；没有调用任何有副作用工具。
- 在隔离 fake adapter harness 中显式传入含 `cyberboss_diary_append` 的 `projectToolHost`，但 `CodeBuddyProcessHost.start` 收到 `mcpServers: {}` 和 `allowedTools: ["mcp__cyberboss_supervisor__disabled"]`。
- 当前运行实例自 `2026-09-07T07:50:36Z` 启动后，desktop 日志有 3 次 supervision dispatch，bridge 日志有 6 次 CodeBuddy runtime turn completed；同一日志目录中精确搜索 Project Tools / MCP tool-call 标记仍为 0 次。
- Start Menu shortcut、实际 Aidy executable 和 `app.asar` 已重新核对；`app.asar` SHA-256 为 `EB0D3E8DCD1E1A0B968AB90282FBBC3659B92CB474C799004AA52A921B020A8B`，关键源码文件在包内逐文件 SHA-256 与当前 source 相等。
- 当前 overlay 的 `mcp.json` / `settings.json` 读取被其保护 ACL 拒绝；因此仍不把 overlay 文件当作直接读取证据。

## 1. 执行边界与预检

- 分支：`main`
- HEAD：`75dc0d9d0681508a054e56be5afd115d499c0f73`（`Fix CodeBuddy SSE response bound diagnostics`）
- working tree：除既存未跟踪用户文件 `docs/audits/` 外，无其他未提交改动；本轮只沿用并更新该目录中的审计文件
- 相对 `origin/main`：ahead 3 / behind 0
- 相对本地已抓取的 `upstream/main`：ahead 84 / behind 0；本地 upstream ref 为 `373ab17`（`Update timeline-for-agent dependency`）
- `git ls-remote` 因当前环境无法连接 GitHub 失败；本地已抓取的 `upstream/main` 仅用于代码对照，相关机制另以公开仓库 `main` 的 raw 文件交叉核对。不能把本次审计写成“已验证远端最新 commit”。
- 项目 acceptance skill 自检：`npm run verify:acceptance-skill` 通过。
- 相关专项检查：`npm run check` 通过；本轮专项测试共 **78 passed / 0 failed**。

已读取：`AGENTS.md`、`docs/skills/cyberboss-debug-release-acceptance/SKILL.md`、runtime/tool/timeline/diary/report 源码、测试、操作规则及上游对应源码。

## 2. 上游真实机制

上游的自动日记不是 cron 直接写文件，而是以下链路（Aidy desktop 另有自己的 `SupervisionDispatcher` 调度实现）：

1. 上游 `src/app/system-checkin-poller.js` 在随机区间醒来，把内部 check-in trigger 放进 system-message queue；当前 Aidy desktop 的实际 dispatch 证据来自 `src/desktop/supervision-dispatcher.js`，不是该 standalone CLI poller。
2. `src/core/system-message-dispatcher.js` 将 system trigger 变成 runtime turn，并明确要求本轮做 timeline/diary/reminder/whereabouts 工作。
3. `templates/weixin-operations.md` 要求模型在有意义的对话后主动写 diary、增量更新 timeline，并做 nightly diary/timeline pass。
4. `ProjectToolHost` 提供 `cyberboss_diary_append`、timeline 工具、reminder、file send 及 whereabouts 工具。
5. `src/tools/mcp-stdio-server.js` 通过 `tools/list` / `tools/call` 暴露 ProjectToolHost。
6. 上游 Codex 通过 `cyberboss_tools` MCP server 接入；Claude Code 通过 workspace `.mcp.json` 接入。
7. 模型自主决定是否调用 `cyberboss_diary_append` / `cyberboss_timeline_write`；DiaryService 才会最终追加到 `~/.cyberboss/diary/YYYY-MM-DD.md`。

上游没有 `src/desktop/report-scheduler.js`、`src/desktop/main.js` 或 Aidy 的 desktop report state。上游 timeline 是 model/tool-driven 的 `timeline-for-agent` 集成；Aidy 的 00:30 build + screenshot 是后续自行增加的 ReportScheduler，不能反向归因给上游。

## 3. Capability parity matrix（当前 Aidy WorkBuddy/CodeBuddy 路径）

“源码存在”与“当前 runtime 可用”分开记录。当前 CodeBuddy supervisor 的 source wiring 没有把 `cyberboss_tools` MCP server 传给 managed process；独立启动 Aidy 的 `tool-mcp-server` 已实际通过 stdio `tools/list` 返回 23 个工具，但这不是 WorkBuddy wire discovery 证据。

| Capability | Upstream implementation | Aidy source exists? | Registered to upstream runtime? | Registered to WorkBuddy runtime? | Allowed by supervision/tool policy? | Packaged artifact contains it? | Runtime actually callable? | Status |
|---|---|---:|---:|---:|---|---:|---|---|
| diary append | ProjectToolHost → DiaryService → local md | Yes | Yes（Codex/Claude MCP） | No | No；默认 disabled placeholder | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| diary read | 未发现专用上游 diary-read tool | No dedicated tool | No | No | No | N/A | No | NOT_PORTED |
| timeline read/categories/proposals | ProjectToolHost → TimelineService | Yes | Yes | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| timeline write | ProjectToolHost → timeline-for-agent write | Yes | Yes | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| timeline build | Aidy ProjectToolHost；非上游 report scheduler | Yes | Tool path exists in upstream host | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| timeline screenshot | ProjectToolHost → build/screenshot + channel file send | Yes | Yes（ProjectToolHost path） | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| reminder / future reminder | `cyberboss_reminder_create`，支持 `delayMinutes` / `dueAt` | Yes | Yes | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| file send | `cyberboss_channel_send_file` | Yes | Yes | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| image input / attachments | channel/tool side path；CodeBuddy adapter 明确拒绝 attachments | Partial | Not equivalent | No | Blocked by adapter capability | Yes（相关代码） | No | BLOCKED_BY_POLICY |
| whereabouts / activity context | `whereabouts-mcp` extra tool host | Yes | Yes（ProjectToolHost） | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |
| system send / sticker tools | Aidy ProjectToolHost extensions | Yes | Not part of upstream baseline parity | No | No | Yes | No（未暴露） | PRESENT_BUT_UNEXPOSED |

当前 ProjectToolHost 实际列出的 23 个工具名已由隔离 state 下真实 `tool-mcp-server` 的 `initialize` + `tools/list` 返回；没有把这些名字误记为 WorkBuddy 已可用。安全的依赖注入 probe 结果如下：上层传入的 `projectToolHost` 可包含 `cyberboss_diary_append`，但 CodeBuddy `host.start` 收到的是：

完整 discovery 名单：`cyberboss_diary_append`, `cyberboss_reminder_create`, `cyberboss_system_send`, `cyberboss_channel_send_file`, `cyberboss_sticker_tags`, `cyberboss_sticker_pick`, `cyberboss_sticker_send`, `cyberboss_sticker_delete`, `cyberboss_sticker_save`, `cyberboss_sticker_update`, `cyberboss_timeline_read`, `cyberboss_timeline_categories`, `cyberboss_timeline_proposals`, `cyberboss_timeline_write`, `cyberboss_timeline_build`, `cyberboss_timeline_serve`, `cyberboss_timeline_dev`, `cyberboss_timeline_screenshot`, `whereabouts_snapshot`, `whereabouts_current_stay`, `whereabouts_recent_stays`, `whereabouts_recent_moves`, `whereabouts_summary`。

```json
{
  "mcpServers": {},
  "allowedTools": ["mcp__cyberboss_supervisor__disabled"]
}
```

这不是 ACP contract probe，也没有连接真实 WorkBuddy 或发送任何内容。

## 4. Diary root-cause evidence

### Confirmed facts

- Aidy `src/core/app.js` 创建了 ProjectToolHost，并把它传给 runtime factory。
- `src/adapters/runtime/factory.js` 继续把 `projectToolHost` 放进 adapter factory options。
- `createCodeBuddyRuntimeAdapter` 的参数没有接收 `projectToolHost`；其 initialize 路径只从 `config.codebuddyMcpServers` 取 MCP servers，而项目中没有生产配置来源给它赋值。
- `src/core/config.js` 没有 `codebuddyMcpServers`、`codebuddyAllowedTools` 或 `codebuddyCapabilityMode` 的生产配置映射；因此当前 source path 没有把 Project Tools registration/allowlist 填入 CodeBuddy。
- CodeBuddy supervisor 默认通过 `normalizeSupervisorAllowedTools()` 生成 `mcp__cyberboss_supervisor__disabled`；没有显式 `codebuddyAllowedTools` 就不会允许任何 project-native MCP tool。
- CodeBuddy process host 已有 strict MCP overlay 能力，但当前 adapter 给它的是空 `mcpServers`；这证明缺的是 CodeBuddy wiring/policy，不是 DiaryService 或 MCP stdio server 本身。
- `session/new` / `session/resume` 当前发送 `{ cwd, mcpServers: [] }`。本轮没有发现 `Invalid params` 证据，也没有修改该 contract。
- 当前实际运行的 Aidy 实例于 `2026-09-07T07:50:37Z` 从 `D:\CyberBoss\dist\win-unpacked\Aidy.exe` 启动；日志显示 runtime 在 `07:50:53Z` ready。
- 当前 bridge 日志中没有 `cyberboss_diary_append`、`cyberboss_timeline_write`、`tools/list` 或 MCP tool-call 记录。由于当前 observability 没有专门的 tool-discovery event，这只能说明“未观察到”，不能单独证明模型曾尝试调用。
- 当前实例启动 cutoff 之后可见 3 次 `supervision.dispatched` 和 6 次 `runtime.turn.completed`；这排除了“本轮完全没有 check-in/turn”的解释，但仍没有证明模型曾尝试调用某个工具。
- `C:\Users\23159\.cyberboss\diary` 存在，但最近文件为 `2026-08-25.md`；之后没有 diary 文件写入。

### Strongest hypothesis

**HIGH-CONFIDENCE：当前 WorkBuddy/CodeBuddy runtime 没有看到 Aidy project-native tools，因此模型即使收到“主动写 diary / timeline”的规则，也没有可调用的 `cyberboss_diary_append` / timeline tool。**

### Unproven historical cause

没有证据证明某一次历史 turn 已经看到工具后调用失败；也没有证据证明模型具体产生过一个未被执行的 diary tool call。当前结论是对 runtime wiring 的高置信度诊断，不是历史首个失败瞬间的逐事件证明。

## 5. Report root-cause evidence

### A. Timeline data source

只读调用当前 `timeline-for-agent read` 得到：

- `2026-09-07`: `status=missing`, `exists=false`, `eventCount=0`
- `2026-08-22`: `status=draft`, `exists=true`, `eventCount=2`
- timeline state/facts/taxonomy 文件最后写入均在 `2026-08-22`；site 产物最后写入为 `2026-08-23`

因此当前 timeline 长期没有新数据是事实。由于 CodeBuddy 没有 timeline_write 暴露，能力缺失是强解释；但没有历史 tool-call 记录，不能声称已证明某一轮写入失败。

### B. Scheduler

当前实际 state：

```json
{
  "desiredState": "running",
  "reportEnabled": false,
  "reportTime": "00:30",
  "backfillPaused": false,
  "lastStableState": "running"
}
```

`ReportScheduler.tick()` 的第一个 gate 是 `!settings.reportEnabled` 或 desired state stopped，命中后直接返回；即使 enabled，仍需 runtime healthy 延迟 gate，之后只处理 `pending` job。

当前 report queue 的只读状态（最后更新 `2026-08-23`）：

- `2026-08-16`: `running`, attempt 1，未生成文件，长期未完成
- `2026-08-17` 至 `2026-08-21`: `pending`
- `2026-08-22`: `pending`, kind `daily`

desktop 日志中没有任何 `reports.*` event，且没有 `reports.jsonl`；因此“最近一次 scheduler attempt”无法证明。当前最确定的 skip reason 是 `reportEnabled=false`。持久化的 `running` job 也不会被当前 `pending` 查询重新选中，这是一个独立的 scheduler 状态风险，但本轮没有证据证明它曾因 launcher 失败而进入该状态。

### C. Packaged runtime / launch surface

- 开始菜单 shortcut：`C:\Users\23159\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Aidy.lnk`
- shortcut target：`D:\CyberBoss\dist\win-unpacked\Aidy.exe`
- 当前运行进程/owned bridge path：`D:\CyberBoss\dist\win-unpacked\Aidy.exe`
- 当前 package：`D:\CyberBoss\dist\win-unpacked\resources\app.asar`
- `app.asar` 与 source 中本轮相关文件逐文件 SHA-256 相等：CodeBuddy adapter/process host、ProjectToolHost、ReportScheduler、timeline integration、check-in poller、operations template 均 `equal=true`。
- 当前 `Aidy.exe` SHA-256：`31088AE6FF44D55935CAFC88E9E8C2259E69F0A233429BD725AA7D2B231E9338`；当前 `app.asar` SHA-256：`EB0D3E8DCD1E1A0B968AB90282FBBC3659B92CB474C799004AA52A921B020A8B`。
- package 包含 ReportScheduler、timeline integration、system-checkin-poller、ProjectToolHost、CodeBuddy adapter 和 operations template；不是 packaging missing，也没有发现 source/package drift。

### D. Timeline launcher

开发 Node 环境下 `createTimelineIntegration().describe()` 使用 `D:\Node_js\node.exe`，并且现有 integration tests 验证了直接以 Node 启动 timeline bin。

源码的 packaged 风险点是：`src/integrations/timeline/index.js` 的 child command 直接取 `process.execPath`，没有设置 `ELECTRON_RUN_AS_NODE=1`。但是当前真实状态中 `reportEnabled=false`，没有实际 build/screenshot attempt，也没有 launcher error log。因此：

- launcher：**UNKNOWN**，不是已证实 root cause
- `process.execPath` 是 packaged launcher 的审计风险点，不得写成唯一根因
- package drift：未观察到
- scheduler 当前 gate：**BLOCKED_BY_POLICY**（用户状态文件关闭了 report）

## 6. Answer to the required questions

1. 上游自动 diary 是随机 system check-in 唤醒 + operations rules + model 自主调用 ProjectToolHost diary tool + DiaryService 落盘，不是单独 cron 写入。
2. 上游 timeline 是同一套 model/tool-driven ProjectToolHost + `timeline-for-agent`；Aidy 的 00:30 build/screenshot ReportScheduler 是独立新增机制。
3. Aidy 当前 WorkBuddy 缺失的是 CodeBuddy 的 Project Tools MCP registration 和对应 explicit allowlist；源码、MCP server、DiaryService、TimelineService 本身都存在。
4. diary root cause：**HIGH-CONFIDENCE**（当前 CodeBuddy capability exposure 缺失）；历史具体 tool-call 失败瞬间：未证明。
5. report root cause：timeline data 长期无新数据为事实；scheduler 当前被 `reportEnabled=false` gate 阻断；launcher 未触发、未证实；package drift 未观察到。
6. 当前真实运行 package 是 Start Menu 指向的 `D:\CyberBoss\dist\win-unpacked\Aidy.exe` 及其 `resources\app.asar`；它包含本轮相关实现，但 CodeBuddy 运行配置仍按当前 source 生成空 MCP / disabled allowlist。
7. 下一轮最小修复层：优先是 **CodeBuddy MCP bridge wiring + explicit supervision allowlist**；不是 ACP session 参数、DiaryService、timeline-for-agent 或 packaged launcher。ReportScheduler 的 `reportEnabled`/stale queue 是另一个独立问题，必须单独处理和验收。

## 7. Locked decisions / ruled-out hypotheses / open uncertainties

### Locked decisions

- 保持 `cwd` ACP contract；不引入 `workingDirectory` variant/fallback。
- 不在没有 `Invalid params` 证据时改变 `session/new` / `session/resume`。
- 本轮不停止 Aidy、WorkBuddy、bridge、poller，不清理 cursor/queue/session，不更新 package。
- 不发送微信、不写真实 diary、不触发 proactive outbound、不发送真实 report。

### Ruled-out or downgraded hypotheses

- “WorkBuddy 版本号导致 ACP contract 不兼容”：没有证据；当前重点问题发生在 MCP wiring 层。
- “源码缺 DiaryService/ProjectToolHost/timeline”：已由源码和 app.asar 内容排除。
- “安装包缺本轮实现”：已由 app.asar 文件清单和 hash 排除。
- “`process.execPath` 一定是 launcher 唯一根因”：由于当前 scheduler 没有真实 attempt，降级为 UNKNOWN 风险。
- “outbound/runtime turn 成功就等于 diary tool invocation 成功”：日志没有 tool invocation 证据，排除该推断。

### Open uncertainties

- 当前受保护的 CodeBuddy runtime overlay 目录无法在不改变权限的情况下读取；因此没有把 overlay `mcp.json` 当作直接运行时内容证据。
- 没有真实 WorkBuddy/CodeBuddy wire-level `tools/list` probe；当前结论依靠独立 ProjectTool MCP stdio discovery、source/package parity、依赖注入 host.start probe 和日志中的未观察事实。
- `reportEnabled=false` 是谁在何时关闭的，本轮只确认当前状态及更新时间，没有追溯设置操作来源。
- stale `running` report job 是否源于旧进程中断、timeline build 失败或其他原因，现有日志不足以区分。

## 8. Narrow Round 2 implementation proposal

**Recommended surface / model / reasoning: Codex / gpt-5.6-terra / medium.** 这是一个边界明确的实现与测试任务，主要是 runtime wiring；只有在 allowlist 的安全范围需要产品取舍时才回到 Chat 决策。

### 必改文件/层

1. `src/adapters/runtime/codebuddy/runtime-adapter.js`：接入 Project Tools MCP server 配置，并把明确的 `mcp__cyberboss_tools__...` 工具 allowlist 传给已有 `CodeBuddyProcessHost`。
2. 如需保持各 runtime 配置构造职责清晰，可新增 `src/adapters/runtime/codebuddy/project-settings.js`，生成 `process.execPath + bin/cyberboss.js tool-mcp-server --runtime-id codebuddy --workspace-root ...` 的 stdio server 配置；不得把 MCP wiring 写进 ACP `session/new` 参数。
3. 只新增覆盖 CodeBuddy registration/allowlist 的测试；复用现有 `src/tools/mcp-stdio-server.js`，不重复实现 DiaryService 或 TimelineService。

### 不该动的文件

- `src/adapters/runtime/codebuddy/protocol-adapter.js` 的 `cwd` contract，除非之后出现明确的运行时 `Invalid params` JSON-RPC 证据。
- `src/services/diary-service.js`、`src/services/timeline-service.js`、`src/tools/tool-host.js`：本轮证据没有显示它们缺实现。
- `src/integrations/timeline/index.js`：在 report scheduler 真正产生 packaged build/screenshot failure 之前不改 launcher。
- 当前用户 state 中的 `reportEnabled`：不要静默替用户开启；先作为独立配置/状态问题处理。

### 测试与真实验收范围

- 单测：CodeBuddy `host.start` 必须收到 `cyberboss_tools` stdio server；supervisor allowlist 必须是显式、可审计的 MCP tool 名；无 project tool 时继续保留拒绝行为。
- MCP bridge probe：仅做 `tools/list` 和无副作用的 read-only tool discovery；不调用 diary append、timeline write、file send、sticker send 或微信 API。
- `npm run check` + CodeBuddy/ProjectToolHost/MCP focused tests。
- 构建并检查最新 `app.asar`，确认 Start Menu target、启动 executable、package 内容三者一致后，才能进入 packaged runtime acceptance。
- Report 独立验收：先确认用户明确启用 `reportEnabled`，并为 stale `running` job 定义安全恢复语义；再观察 scheduler attempt、timeline build、screenshot 及 error/skip reason。没有这些证据前不修或宣称 launcher。
- ACP contract 保持不变：MCP registration 发生在 managed CodeBuddy process overlay/launch args 层，不扩大 `session/new` 或 `session/resume` 参数。

## 9. Evidence index

### Source / tests

- `AGENTS.md`
- `docs/skills/cyberboss-debug-release-acceptance/SKILL.md`
- `src/core/app.js`
- `src/app/system-checkin-poller.js`
- `src/core/system-message-dispatcher.js`
- `templates/weixin-operations.md`
- `src/tools/tool-host.js`
- `src/tools/create-project-tooling.js`
- `src/tools/mcp-stdio-server.js`
- `src/adapters/runtime/factory.js`
- `src/adapters/runtime/codebuddy/runtime-adapter.js`
- `src/adapters/runtime/codebuddy/process-host.js`
- `src/adapters/runtime/codebuddy/protocol-adapter.js`
- `src/adapters/runtime/codex/mcp-config.js`
- `src/adapters/runtime/claudecode/project-settings.js`
- `src/desktop/report-scheduler.js`
- `src/core/desktop-state-store.js`
- `src/core/report-queue-store.js`
- `src/integrations/timeline/index.js`
- `test/codebuddy-runtime.test.js`
- `test/codebuddy-managed-serve.test.js`
- `test/codebuddy-acp-smoke.test.js`
- `test/tool-host.test.js`
- `test/codex-mcp-config.test.js`
- `test/claudecode-project-settings.test.js`
- `test/report-scheduler.test.js`
- `test/timeline-integration.test.js`
- `test/timeline-service.test.js`

### Actual runtime / package evidence

- Start Menu: `C:\Users\23159\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Aidy.lnk`
- Executable: `D:\CyberBoss\dist\win-unpacked\Aidy.exe`
- Package: `D:\CyberBoss\dist\win-unpacked\resources\app.asar`
- State: `C:\Users\23159\.cyberboss\desktop-state.json`, `reports\index.json`, `diary\`, `timeline\`
- Logs: `C:\Users\23159\.cyberboss\logs\desktop.jsonl`, `bridge.jsonl`, `integrations.jsonl`
- Current context/process snapshot: `C:\Users\23159\.cyberboss\project-tool-runtime-context.json`, `owned-processes.json`

## 10. Round 2 implementation evidence（2026-09-08）

### Source change boundary

- 修改 `src/adapters/runtime/codebuddy/runtime-adapter.js`：正式接收 `projectToolHost`，在 managed process 启动层注册 Project Tools MCP，并在 supervisor mode 使用显式安全 allowlist。
- 新增 `src/adapters/runtime/codebuddy/project-settings.js`：生成绝对 `bin/cyberboss.js` stdio 配置，传入 `CYBERBOSS_STATE_DIR`；Electron packaged path 使用 `ELECTRON_RUN_AS_NODE=1`，不依赖 shell cwd。
- 修改测试：`test/codebuddy-runtime.test.js`、`test/codebuddy-managed-serve.test.js`；新增 `test/codebuddy-project-settings.test.js`。
- 未修改 `protocol-adapter.js`、`session/new`、`session/resume`、DiaryService、TimelineService、timeline launcher、report rendering、微信 dispatcher/sender 或 stochastic check-in。

### Managed config and policy

CodeBuddy managed overlay 现在接收 merge 后的配置：既有 `config.codebuddyMcpServers` 原样保留，再加入保留名 `cyberboss_tools`；同名冲突显式报 `CODEBUDDY_MCP_SERVER_CONFLICT`，不会覆盖用户 server。Project Tools server 使用绝对 command/args：`<process.execPath> <absolute>/bin/cyberboss.js tool-mcp-server --runtime-id codebuddy --workspace-root <absolute workspace>`，并将 state dir 作为 server env 传入。

supervisor 默认 allowlist（12 项）为：

`cyberboss_diary_append`, `cyberboss_reminder_create`, `cyberboss_timeline_read`, `cyberboss_timeline_categories`, `cyberboss_timeline_proposals`, `cyberboss_timeline_write`, `cyberboss_timeline_build`, `whereabouts_snapshot`, `whereabouts_current_stay`, `whereabouts_recent_stays`, `whereabouts_recent_moves`, `whereabouts_summary`。

明确禁止自动放行：`cyberboss_channel_send_file`、`cyberboss_timeline_screenshot`、所有 sticker 工具、`cyberboss_system_send`、外部 MCP 工具及 coding tools。developer mode 的既有 approval 行为未扩大。

### Discovery evidence boundary

- 单元/集成 seam 已证明：`host.start` 的 `mcpServers` 不再为空；overlay 文件包含 `user_tools` 与 `cyberboss_tools`；allowlist 为上述 12 项；server command/args/env 可重建且稳定。
- 独立 Project Tools MCP stdio `tools/list` 仍返回 23 个工具。
- 真实 WorkBuddy managed wire probe 已尝试，但在启动前读取当前用户 CodeBuddy 凭据时失败（`CREDENTIAL_DECRYPT_FAILED`）；没有启动新的 managed child，没有写入临时或真实 diary。因此真实 WorkBuddy `tools/list`/tool call 仍为 **NOT YET VERIFIED**，不得写成 managed runtime acceptance。

### Report configuration provenance and handling

- `DEFAULT_DESKTOP_STATE.reportEnabled` 的源码默认值是 `true`；仓库中未发现 migration、启动覆盖或其他默认值为 `false` 的路径。
- UI 的 `desktop:update-settings` 只将用户提交的 `reportEnabled` 通过 `stateStore.patch()` 持久化；当前用户文件仍明确保存 `reportEnabled: false`，更新时间为 `2026-09-07T07:50:53.143Z`。因此可坐实为当前用户持久化 state 覆盖默认值；具体是用户点击、旧 UI 保存还是旧版本遗留，现有证据无法区分。
- 按本轮目标尝试仅将当前用户 state 改为 `true`，但环境安全审核拒绝了该持久化动作；未改默认值、未改 migration、未改 UI。当前用户 Aidy 因此仍保持 `reportEnabled=false`。
- ReportScheduler、timeline launcher 与 stale queue 没有被本轮源码修复；报表真实生成仍需用户 state enabled 后单独观察。

### Verification result and release boundary

- `node --test ./test/codebuddy-project-settings.test.js ./test/codebuddy-runtime.test.js ./test/codebuddy-managed-serve.test.js`：**20 passed / 0 failed**。
- `npm test`：**556 passed / 1 skipped / 0 failed**（skip 为既有 opt-in real Windows DPAPI test）。
- `npm run check`：通过。
- `npm run verify:acceptance-skill`：通过。
- 本轮未构建或更新 `dist/win-unpacked/Aidy.exe` / `app.asar`，未重启当前 Aidy；因此结论严格为：**source fixed only / packaged build pending / current user runtime not fixed**。
