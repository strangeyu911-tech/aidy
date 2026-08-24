# Codex 认证自动修复工作流实施计划

## 目标

根据已批准的设计，实现一个可发布到 GitHub 的 Windows 第一版 Codex 认证修复命令：

```text
npm run codex:auth-repair
```

该命令必须使用 CyberBoss 实际配置的 `CODEX_HOME` 和 Codex 可执行文件，必要时引导设备码登录，只重启身份经过验证的 App Server，并以真实模型回复作为最终验收。

## 实施原则

- 跨平台状态机和 Windows 进程操作分离。
- 所有外部操作通过依赖注入封装，单元测试不触碰真实账号或进程。
- 不输出凭据内容。
- 不修改或启动微信桥接。
- 不永久删除测试线程。
- 不把 `/readyz` 当作认证成功。
- 不直接信任 PID 文件。

## 任务 1：建立结果代码和参数解析

### 文件

- 新增 `src/diagnostics/codex-auth/result-codes.js`
- 新增 `src/diagnostics/codex-auth/cli-options.js`
- 新增 `test/codex-auth-cli-options.test.js`

### 实现

- 导出设计中定义的稳定结果代码。
- 解析 `--diagnose-only`、`--json`、`--no-restart` 和 `--port`。
- 拒绝未知参数、无效端口和非 Windows 自动修复。
- 将人类输出和 JSON 输出需要的字段统一为一个结果对象。

### 验证

```text
node --test test/codex-auth-cli-options.test.js
```

## 任务 2：实现配置和凭据诊断

### 文件

- 新增 `src/diagnostics/codex-auth/diagnostics.js`
- 新增 `test/codex-auth-diagnostics.test.js`

### 实现

- 接收已经由现有 `dotenv` 加载的环境，解析：
  - `CYBERBOSS_CODEX_COMMAND`
  - `CODEX_HOME`
  - `CYBERBOSS_RUNTIME`
  - `CYBERBOSS_SHARED_PORT`
- 规范化默认 Codex 目录和 CyberBoss 专用目录。
- 只读取 `auth.json` 的存在性、长度和 JSON 可解析性，不返回字段值。
- 使用相同 `CODEX_HOME` 调用 `codex login status`。
- 对专用 `codex-login.log` 做有限、非敏感分类：callback 未到达、callback 有效、token exchange 失败、设备码开始。
- 返回结构化证据和稳定结果代码。

### 验证

```text
node --test test/codex-auth-diagnostics.test.js
```

## 任务 3：实现设备码登录

### 文件

- 新增 `src/diagnostics/codex-auth/device-login.js`
- 新增 `test/codex-auth-device-login.test.js`

### 实现

- 使用配置中的 Codex 可执行文件启动 `login --device-auth`。
- 子进程继承终端输入输出，以便用户查看链接和输入设备码。
- 子进程环境强制使用专用 `CODEX_HOME`。
- 登录结束后不相信退出文本，重新运行凭据文件和 `login status` 验证。
- 超时、拒绝、非零退出码和验证失败映射为 `DEVICE_AUTH_FAILED`。

### 验证

```text
node --test test/codex-auth-device-login.test.js
```

## 任务 4：实现 Windows App Server 身份识别和安全重启

### 文件

- 新增 `src/diagnostics/codex-auth/platform.js`
- 新增 `src/diagnostics/codex-auth/windows-app-server.js`
- 新增 `test/codex-auth-windows-app-server.test.js`

### 实现

- 跨平台控制器只依赖平台接口：
  - 查找监听 PID；
  - 读取进程信息；
  - 验证身份；
  - 停止已验证进程；
  - 启动 App Server。
- Windows 适配器使用 PowerShell/CIM 获取：
  - 目标端口监听 PID；
  - 可执行路径；
  - 启动命令行。
- 身份验证同时要求：
  - 监听 PID 唯一；
  - 路径与 `CYBERBOSS_CODEX_COMMAND` 一致；
  - 参数包含 `app-server`；
  - 参数包含目标端口。
- PID 文件与监听 PID 不一致时输出 `STALE`，但不停止 PID 文件指向的进程。
- 没有监听进程时直接启动新 App Server。
- 启动后等待 `/readyz`，并将真实监听 PID 写回 PID 文件。
- `--no-restart` 时只报告需要的动作。

### 验证

```text
node --test test/codex-auth-windows-app-server.test.js
```

## 任务 5：实现真实 App Server 探针

### 文件

- 新增 `src/diagnostics/codex-auth/app-server-probe.js`
- 新增 `test/codex-auth-app-server-probe.test.js`

### 实现

- 复用现有 `CodexRpcClient`。
- 完成初始化并调用 `model/list`。
- 创建独立测试线程，发送固定认证探针提示。
- 收集 `item/completed` 中的最终 `agentMessage`。
- 读取 `turn/completed.turn.status`，不能仅凭事件出现判定成功。
- 将 401 映射为 `APP_SERVER_UNAUTHORIZED`。
- 将其他失败回合映射为 `APP_SERVER_TURN_FAILED`。
- 回复不匹配映射为 `APP_SERVER_REPLY_MISMATCH`。
- 在 `finally` 中尽力调用 `thread/archive`，不永久删除测试线程；清理失败只返回警告和线程 ID。

### 验证

```text
node --test test/codex-auth-app-server-probe.test.js
```

## 任务 6：实现跨平台修复状态机

### 文件

- 新增 `src/diagnostics/codex-auth/workflow.js`
- 新增 `test/codex-auth-workflow.test.js`

### 实现

- 严格实现设计文档中的状态机。
- `--diagnose-only` 只做本地配置、凭据、进程身份和 `/readyz` 检查，不登录、不重启、不发送模型请求。
- 默认模式：
  1. 诊断；
  2. 必要时设备码登录；
  3. 真实探针；
  4. 401 时验证并重启 App Server；
  5. 再次真实探针；
  6. 输出 `REPAIR_SUCCEEDED` 或稳定失败代码。
- 每个阶段记录 `PASS`、`FAIL`、`ACTION` 或 `STALE` 事件。
- 修复后仍然 401 时停止，不循环重试。

### 验证

```text
node --test test/codex-auth-workflow.test.js
```

## 任务 7：增加公开 CLI 和 package 命令

### 文件

- 新增 `scripts/codex-auth-repair.js`
- 修改 `package.json`
- 修改 `docs/commands.md`

### 实现

- CLI 加载仓库 `.env` 和用户 CyberBoss `.env`，保持与共享脚本一致。
- 调用参数解析和工作流。
- 人类模式输出逐阶段结果，最后输出 `RESULT=<code>`。
- JSON 模式只在 stdout 输出 JSON；诊断日志写入 stderr 或收集进结果对象。
- 按结果设置退出码：成功为 0，需要用户处理或修复失败为非零。
- 增加：

```json
"test": "node --test",
"codex:auth-repair": "node ./scripts/codex-auth-repair.js"
```

- `test` 使用 Node 自带测试发现机制，避免依赖 PowerShell 对通配符的展开行为。

### 验证

```text
npm run codex:auth-repair -- --diagnose-only
npm run codex:auth-repair -- --diagnose-only --json
```

## 任务 8：修复共享 App Server PID 身份误判

### 文件

- 修改 `scripts/shared-common.js`
- 修改 `scripts/shared-status.js`
- 新增或扩展相关测试

### 实现

- `ensureSharedAppServer` 在 `/readyz` 正常时不再仅凭 PID 文件中的存活 PID报告 `already_running`。
- Windows 上对真实监听 PID做身份核验；无法核实时返回明确的 unknown 状态，不停止任何进程。
- 真实监听 PID 与 PID 文件不同时，安全更新 PID 文件为已经验证的监听 PID。
- `shared:status` 同时展示 PID 文件 PID、监听 PID 和是否一致，避免再次误导。

### 验证

```text
node --test test/windows-process-host.test.js test/codex-auth-windows-app-server.test.js
npm run shared:status
```

## 任务 9：编写发布文档

### 文件

- 新增 `docs/codex-auth-repair.zh-CN.md`
- 修改 `README.zh-CN.md`
- 修改 `README.md`

### 内容

- 一条命令入口；
- Windows 第一版限制；
- 五层排查方向；
- 固定错误代码；
- 本次踩坑和禁止推断；
- 安全边界；
- JSON 输出示例；
- 较弱模型可以直接复制的执行提示；
- 指向 OpenAI 官方认证和 App Server 文档的链接。

### 验证

- 检查所有相对链接真实存在；
- 重新打开中文手册和 README；
- 确认没有令牌、设备码或本机账号信息。

## 任务 10：完整验证

### 自动化测试

```text
npm test
npm run check
```

### 真实 Windows 验收

```text
npm run codex:auth-repair -- --diagnose-only
npm run codex:auth-repair -- --json
npm run codex:auth-repair
npm run codex:auth-repair
```

依次确认：

- 诊断模式不登录、不重启、不发送模型请求；
- JSON 输出可解析且不含敏感信息；
- 默认模式通过真实模型探针；
- 第二次默认运行保持幂等，不重复登录或重启；
- `auth.json` 真实存在且能重新打开；
- 相同 `CODEX_HOME` 的 `codex login status` 返回 ChatGPT 已登录；
- PID 文件等于经过验证的真实监听 PID；
- App Server 探针返回正确文本；
- 未启动或重启微信桥接。

## 提交顺序

1. 结果代码、参数解析和诊断模块；
2. Windows 适配器和真实探针；
3. 状态机、CLI 和 package 命令；
4. PID 身份修复；
5. 文档和完整测试。
