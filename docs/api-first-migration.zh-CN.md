# API-first 迁移指南

## 升级后的变化

艾迪不再把 Codex、OpenCode、Claude Code 或任何订阅视为默认引擎。旧 runtime 提示不能解锁“运行”或“静默”。升级后需要在**控制中心 → 模型与 API**中创建或检查 profile，完成实时能力测试，再明确激活。

旧的 workspace 模型设置只作为迁移提示；活动 runtime/provider/model 是全局的，workspace 不能覆盖它。`/model` 只显示当前 profile，不再直接修改模型。

## 会话迁移

- 旧 Codex 会话只能绑定到明确激活、且 provider/model 与旧元数据匹配的 Codex 兼容 profile。
- 旧 Claude Code 会话只能绑定到明确激活的 Claude Code 兼容 profile。
- 身份含糊或无法验证的历史标记为“旧版兼容会话（只读）”，后续交互使用新建 scoped session。
- 旧会话永远不会迁移到 Built-in API 或 OpenCode。
- 新会话 scope 包含 runtime、profile、model 与 credential generation。只有完全一致的 scope 才能续接已完成历史；未完成 turn、tool call 和 approval 不会迁移或重放。

## 凭据与备份

provider secret 不会从旧环境变量自动导入 DPAPI vault，需要通过控制中心录入。每次 vault 写入都会增加 credential generation 并使旧验证失效，即使再次输入相同 key 也一样。

备份只携带净化后的非敏感 profile 结构。恢复后的 profile 是未激活 draft，必须重新输入凭据并执行实时测试。vault ciphertext 和 diagnostic capture 不进入备份，因此跨机器迁移备份不会转移 API key。

已有桌面监管设置会保持原值。夜间关怀迁移明确延后到后续实现计划。
