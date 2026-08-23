# 指尖时光 MCP 可靠调用设计

## 背景与根因

CyberBoss 已通过 `CYBERBOSS_MCP_SERVERS_FILE` 将指尖时光 STDIO MCP 注入 Codex app-server。诊断确认了三件事：

- 指尖时光 MCP 能正常初始化并列出 9 个工具。
- 当前微信绑定线程可以通过 app-server 调用 `zhijiantime.list_schedules` 并读取真实日程。
- 出问题的对话中没有发生任何 MCP 工具调用；模型在未探测工具的情况下自行断言“当前会话没有暴露指尖时光 MCP”。

因此主要故障是模型使用策略缺失，而不是 MCP 注册或 bridge/session 传递失败。现有外部 MCP 配置还缺少必需启动、超时和细粒度自动批准能力，导致失败时可能继续运行，并且只读查询会产生不必要的审批摩擦。

## 目标

1. 用户询问指尖时光计划、待办、概览或统计时，模型先调用对应 MCP 只读工具，再根据结果回答。
2. 模型不得在未进行真实工具调用的情况下声称指尖时光不可用、未挂载或未暴露。
3. 四个只读工具可自动执行：
   - `list_schedules`
   - `list_todos`
   - `get_daily_overview`
   - `get_period_stats`
4. 写工具继续经过现有微信审批链路：
   - `create_schedule`
   - `create_todo`
   - `update_schedule`
   - `update_todo`
   - `complete_item`
5. 指尖时光被配置为必需服务器时，初始化失败必须显式阻止线程启动或恢复，不允许静默降级。
6. 现有未配置外部 MCP 的部署保持原行为。

## 非目标

- 不把指尖时光工具重新代理或复制到 `cyberboss_tools`。
- 不改变指尖时光 MCP 服务本身及其认证存储。
- 不自动批准任何写操作。
- 不为所有第三方 MCP 自动推断读写权限；自动批准必须由本地配置显式列出。

## 设计

### 外部 MCP 配置模型

扩展 `CYBERBOSS_MCP_SERVERS_FILE` 中每个服务器的可选字段：

```json
{
  "name": "zhijiantime",
  "command": "D:\\Node_js\\node.exe",
  "args": ["D:\\指尖时光MCP\\指尖时光MCP\\dist\\src\\index.js"],
  "required": true,
  "startupTimeoutSec": 20,
  "toolTimeoutSec": 60,
  "autoApproveTools": [
    "list_schedules",
    "list_todos",
    "get_daily_overview",
    "get_period_stats"
  ]
}
```

`resolveAdditionalMcpServerConfigs` 负责校验并保留这些字段。布尔值必须是布尔类型，超时必须是正整数，工具名必须是非空字符串。无效配置在 app-server 启动前报出包含服务器名和字段名的错误。

`buildCodexMcpConfigArgs` 将其映射为 Codex 配置覆盖：

- `mcp_servers.<name>.required`
- `mcp_servers.<name>.startup_timeout_sec`
- `mcp_servers.<name>.tool_timeout_sec`
- `mcp_servers.<name>.tools.<tool>.approval_mode="auto"`

未声明的可选字段不生成覆盖值。`cyberboss_tools` 继续自动批准自己的项目内工具，保持现有行为。

### 微信线程工具使用策略

在 `templates/weixin-operations.md` 加入以下稳定行为规则：

- 当用户询问已连接应用中的数据，或询问模型能否访问该应用时，先使用相关只读工具验证。
- 对指尖时光计划、日程、待办、每日概览和统计，优先调用对应 `zhijiantime` 工具。
- 只有工具真实返回失败后，才能向用户说明不可用；说明应基于实际错误，不得猜测 bridge、session 或工具暴露状态。
- 查询成功时直接给出结果，不向用户描述 MCP、工具名或内部调用步骤。

规则进入新线程的 opening instructions，也能通过现有 instruction refresh 流程应用到已绑定线程。

### 启动与线程数据流

1. CyberBoss 桌面控制器读取 `.env` 和外部 MCP JSON。
2. `RuntimeSupervisor` 将服务器命令、必需状态、超时和逐工具审批策略转换成 Codex `-c` 参数。
3. app-server 初始化 `zhijiantime`。若 `required=true` 且初始化失败，线程启动或恢复返回明确错误。
4. 微信消息进入已绑定 Codex 线程。
5. 模型依据线程操作指令选择只读工具。
6. 四个只读工具自动执行；写工具仍产生 `mcpServer/elicitation/request`，由现有微信审批处理。
7. 模型基于结构化结果给出简短微信回复。

### 错误处理与可观测性

- JSON 不可读、字段非法或服务器名重复时，在启动阶段失败，不创建部分配置。
- 必需 MCP 启动失败时保留 Codex 返回的服务器启动错误，并由现有桌面运行状态显示为错误。
- 只读工具调用失败时，模型可以告知用户本次查询失败及可执行的下一步，但不能把一次调用失败泛化为“该会话没有 MCP”。
- 不在日志或用户回复中输出认证令牌、完整环境变量或敏感请求参数。

## 测试

### 单元测试

- 外部 MCP 配置正确保留并规范化 `required`、两个超时和 `autoApproveTools`。
- 无效布尔值、非正超时和空工具名被拒绝。
- 生成的 Codex 参数仅自动批准显式列出的四个只读工具。
- 五个写工具不出现 `approval_mode="auto"`。
- 未提供新字段的旧配置生成结果与当前行为一致。
- 微信操作指令包含“先调用再判断”和“不得猜测不可用”的规则。

### 集成验证

- 直接连接指尖时光 MCP，确认 9 个预期工具可列出。
- 通过 CyberBoss app-server 和当前绑定线程调用 `list_schedules`，确认返回结构化数据。
- 创建不绑定微信的临时 Codex 线程，询问当天指尖时光计划，确认出现 `zhijiantime` 只读工具调用且得到基于真实数据的回答。
- 验证一个写工具仍触发审批请求，不实际提交写操作。
- 临时使用不可启动的必需 MCP 配置，确认线程启动明确失败；测试结束后恢复真实配置。

## 发布步骤

1. 更新代码、模板、示例和测试。
2. 更新本地 `.mcp-servers.local.json`，仅自动批准四个只读工具并设置 `required=true`。
3. 运行相关单元测试与完整测试集。
4. 通过桌面控制器安全重启 CyberBoss，使 app-server 重新加载命令行 MCP 配置。
5. 刷新当前微信绑定线程的 instructions。
6. 执行只读端到端查询并确认微信侧回答来自真实指尖时光数据。

## 验收标准

- 在微信中问“我今天指尖时光上有什么计划”时，CyberBoss 无需审批即可读取并回答真实数据。
- 在微信中问“你能读取指尖时光吗”时，CyberBoss 会先做只读验证，不再无依据地回答“不能”或“没暴露”。
- 创建、修改、完成指尖时光项目仍必须获得用户批准。
- 指尖时光 MCP 不可启动时，系统给出明确故障，不以缺少工具的降级线程继续工作。
