# 指尖时光 MCP 可靠调用与主动监督实施计划

## 1. MCP 配置与权限边界

- 扩展 `src/adapters/runtime/codex/mcp-config.js`，校验并传递 `required`、`startupTimeoutSec`、`toolTimeoutSec`、`autoApproveTools`。
- 更新 `test/codex-mcp-config.test.js`，覆盖兼容性、非法字段、只读自动批准和写工具不自动批准。
- 更新 `templates/mcp-servers.example.json`、README 和本地 `.mcp-servers.local.json`。

## 2. 当天监督组件

- 新建 `src/integrations/zhijiantime/daily-supervisor.js`。
- 实现当天快照分类、当前日期状态存储、随机查岗上下文、无计划约时、同日唯一规划检查点、到点复查和读取失败保护。
- 在 `src/integrations/zhijiantime/index.js` 导出组件。
- 新建 `test/zhijiantime-daily-supervisor.test.js`，覆盖所有状态转换与优先级。

## 3. 微信与调度接入

- 在 `src/core/app.js` 构造当天监督组件。
- 系统随机查岗消息进入模型前刷新指尖时光；固定规划检查点进入模型前执行复查。
- 用户在等待承诺状态下回复明确时间时，建立或替换同日规划检查点。
- 关闭 bridge 时释放 MCP 客户端。
- 扩展随机 check-in 识别，兼容 legacy `checkin:*` 和桌面 `supervision:random:*`。

## 4. 模型行为指令

- 更新 `templates/weixin-operations.md`：已连接应用先查后答；指尖时光读取失败后才能声明不可用；随机查岗依据真实当天数据；无计划必须取得明确跟进时间。
- 增加指令加载测试。

## 5. 验证与发布

- 将新文件加入 `npm run check`。
- 运行针对性 Node 测试、完整测试和语法检查。
- 安全重启桌面控制器管理的 bridge/app-server，刷新当前线程 instructions。
- 通过 app-server 验证只读工具、写工具审批边界和真实计划读取。
- 验证随机查岗 prompt 含真实当天安排；在隔离测试数据中验证无计划约时闭环，不修改用户真实指尖时光数据。
