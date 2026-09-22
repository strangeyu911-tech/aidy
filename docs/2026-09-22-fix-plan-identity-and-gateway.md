# 修复计划：Aidy 身份三层重构（方案 A） + 网关鉴权/设置页修复

- 日期：2026-09-22 ｜ 状态：**计划定稿，未写代码**（用户已拍板方案 A）
- 依据：
  - `docs/audits/2026-09-22-identity-lifecycle-audit.md`（身份审计：bot_id 冒充身份主键、workspaceRoot=cwd 双劈裂轴、4 套分裂绑定实证）
  - `docs/audits/2026-09-22-model-dropdown-and-version-audit.md`（网关鉴权回归、版本文案错误、模型目录为空）
  - `docs/audits/2026-09-22-phantom-checkpoint-1745.md`（-14 自锁环；`242e7c9` 已落地 SUPERSEDED 分流 + retire）

## 0. 总览与顺序

| Phase | 内容 | 规模 | 何时做 |
|---|---|---|---|
| **P1** | W1 网关鉴权 + 设置页四项（§1） | 小 diff，互不耦合 | **立即**。修复打包前「重启 Aidy 运行时 = LLM 全挂」风险悬顶 |
| **P2** | W2 身份三层重构（§2） | 中等，含数据迁移 | W1 提交后紧接，同一批打包 |
| **P3** | 打包 + 三闸门 + 验收（§3） | 发布纪律全套 | W1+W2 都 commit 后**一次性**打包 |

顺序理由：W1 是一行 env 的一线修复且独立可测；W2 动 bindingKey 语义和数据迁移，
必须一次成型。两者都需要「重启运行时生效」→ 合并打包一次发布，避免用户经历两次切换。

---

## 1. Workstream 1：网关鉴权 + 设置页（对应傍晚审计）

### W1.1（P0）网关密码用 env 注入
- **文件**：`src/adapters/runtime/codebuddy/process-host.js` `start()`
- **改动**：spawn env 增加 `CODEBUDDY_GATEWAY_PASSWORD: <vault 管理密码>`。已实测：CLI 2.137.1
  持久化机器级密码后不再认 `--settings` overlay 的 `gateway.password`，但 env 优先级最高（官方
  文档认证模式 env > CLI 参数 > gateway.auth）。
- **兜底**（同 commit）：解析 stdout 横幅 `Password <43位>` 作为备用凭据缓存，env 失效时自动降级。
- **测试**：新增兼容性测试——模拟 2.137.1 行为（横幅打印生成密码、不认 overlay）断言 host 以
  env 注入且健康探测通过。回归脚本复用 `D:/tmp/aidy-model-audit/probe-password-matrix.js`。

### W1.2（P1）版本文案
- **文件**：`src/desktop/main.js:572-576`
- **改动**：`checkCodeBuddyEnvironment()` 文案改读 `resources/install-manifest.json` 的
  `appVersion`（5.5.6），CLI 版本另行展示为「（CLI 2.137.1）」或日志级信息，不再冒充 App 版本。

### W1.3（P1）`CODEBUDDY_AUTH_FAILED` 人话
- **文件**：`friendlyUiError()` 所在模块
- **改动**：映射为「模型服务登录凭据被网关拒绝（多见于 CLI 更新后），请刷新模型或重启艾迪；
  若仍失败查看日志 bridge.jsonl」。

### W1.4（P2）模型目录静态兜底
- **改动**：目录拉取失败时解析 `codebuddy --help` 的 `--model` 行静态列表填充下拉
  （含 `hy4-preview` 等），并标注「静态目录」。picker 空态回退逻辑不动。

### W1.5（用户侧数据修正，随验收执行）
- 「我的 WorkBuddy」草稿 profile（`c8da68bf`）的 modelId 从显示名 “Hy4 preview” 改为 **`hy4-preview`**
  （执行方式：W1 落地后在设置页改，或直接改 provider-profiles.json——验收时定）。

---

## 2. Workstream 2：身份三层重构（方案 A 定稿）

### 2.1 设计定稿

**三层各归其位：**

| 层 | 内容 | 主键 | 生命周期 |
|---|---|---|---|
| ① 连接 | token + bot_id | `accounts/<bot_id>.json` | 可换值，可重扫码 |
| ② 身份 | Aidy Identity | **openid**（`account.userId`，`o9cq…@im.wechat`） | 终身不变 |
| ③ 记忆 | thread 指针 + 转录 + 监督状态 | bindingKey 以 identityKey 为主键 | 永续 |

**bindingKey 定稿**：`<workspaceId>:<identityKey>:<senderId>`
- `buildBindingKey({ workspaceId, identityKey, senderId })`——第二段语义从「bot_id」改为
  「身份键」，三段结构不变（`::system` 变体的 `split(":")` 替换 `parts[1]` 逻辑保持兼容）。
- 单用户场景下 identityKey === senderId === openid，key 实际为 `default:<openid>:<openid>`。
- identityKey 缺失（历史账号文件无 userId）时 fallback bot_id 并打警告日志——绝不让 bridge 挂。

**workspaceRoot 双职责拆分**（本次审计新确认的关键点）：
- `config.workspaceRoot` 目前 = `process.cwd()`（打包版 = 安装目录），既是 thread 指针键、
  又是 ACP `session/new` 的 `workingDirectory`（`runtime-adapter.js:251/:288`）。
- 拆为：**执行目录**固定到 `~/.cyberboss/workspace`（随配置默认值改为该路径，env
  `CYBERBOSS_WORKSPACE_ROOT` 仍可覆盖）；**记忆键的 workspaceRoot 维度**随之统一为同一常量
  ——目录不再随安装位置漂移，轴 2 消灭。转录将稳定落在
  `~/.codebuddy/projects/c-Users-23159-.cyberboss-workspace/`（以 runtime 实际生成为准，见 M-3）。

### 2.2 改动清单（实施时逐项核对，先不写码）

| # | 文件 | 改动 |
|---|---|---|
| W2-1 | `src/core/config.js` | `workspaceRoot` 默认值：`process.cwd()` → `~/.cyberboss/workspace`（mkdir-on-use） |
| W2-2 | `src/core/app.js` | 所有 `buildBindingKey` 调用点（用户回合 ：751、system 回合 `buildSystemRuntimeBindingKey` :2265 附近、reminder :1645、deferred :726）的 `accountId` 实参换 `identityKey`；新增 `resolveIdentityKey(account)`（= userId 派生 + fallback）；`activeAccountId` 保留 bot_id 语义用于连接层日志/清理 |
| W2-3 | `src/core/system-message-dispatcher.js` | 构造参数 `accountId`（`app.js start()` :303 传入）同步换 identityKey——**实施时先审计该文件内 accountId 的全部读者**，防止漏改 |
| W2-4 | `session-store.js` | `inheritThreadBindingsFromPriorAccounts`（242e7c9）降级为**迁移专用**：身份主键换 openid 后同 identityKey 绑定天然跨扫码，inherit 每次启动变 no-op；保留代码 1–2 个版本后退役 |
| W2-5 | `weixin/login.js` | 无需大改：bot_id 仍作凭据文件名；确认 `resolveSelectedAccount` 单账号语义不变 |

### 2.3 一次性数据迁移（M 系列，写独立脚本 `scripts/migrate-identity-key.js`）

| 步骤 | 内容 | 安全措施 |
|---|---|---|
| M-1 | 备份 `~/.cyberboss/sessions.json` → `sessions.json.backup-identity-migration-<stamp>` | 迁移幂等、可整体回滚 |
| M-2 | 合并 4 套 binding → `default:<openid>[:<openid>]`。**冲突规则与 242e7c9 不同：取「最近活跃」thread 为主线**（理由：累积劈裂下「最旧=最长记忆」不成立，9-21 的 71b1 主线比 8 月源码期的 2992 更连续）；::system 变体同规则（5cac vs ec01 取 5cac）；落选 thread 写入 legacy 记录（转录仍在，永不删） | 迁移前打印 diff 供人工确认 |
| M-3 | **转录搬家**：先在新固定 workspaceRoot 让 runtime 建探针会话，确认 `~/.codebuddy/projects/` 下实际目录名（CLI 转义规则存在新旧差异：`d-cyberboss-…` vs `d-CyberBoss-…` 并存）；再把主线 thread 的 jsonl **复制**到新目录（threadId 不变，旧文件留作备份）。不做这步，指针虽对、新 cwd 下 resume 不到 jsonl = 白迁 | 只复制不移动 |
| M-4 | 排查 supervision-plan / dispatcher / queue 等是否残留 bot_id 键控字段（审计已知 `threadKey` 是死字段；逐个确认无读者后不动） | 只读排查，输出清单 |
| M-5 | 迁移自检：断言 `default:<openid>*` 绑定存在、主线 threadId 与迁移前一致、`::system` 独立 | 不过自检不写回 |

### 2.4 测试计划

- **binding 单元**：identityKey 主键构造；openid 稳定 → 换 bot_id 不换 key（新账号文件、旧 key 命中同 thread）；identityKey 缺失 fallback；`::system` 变体；
- **迁移脚本**：M-2 冲突取最近活跃；幂等（跑两遍结果一致）；备份存在才执行；
- **W1**：网关密码 env 注入（模拟 2.137.1）；版本文案读 appVersion；
- **全量回归**：`node --test "test/**/*.test.js"`（当前基线 744/743/0/1）。

### 2.5 明确不做（本计划范围外）

- 多微信号/多身份管理（单用户产品，identity 表留到有需求再建）；
- `242e7c9` 代码回滚（SUPERSEDED 分流与 retire 是独立正确的，保留）；
- `-14` 降级为可诊断事件、16:58:59 retry 未生效归因（P1 遗留，另立任务）。

---

## 3. 发布与验收（P3）

1. **打包纪律**（沿用 `PITFALLS.md` §2/§8）：产物冻结后不碰任何被打包路径；每个
   electron-builder 目标单独调用；`desktop:sync-start-menu` 补跑；不并发、不碰 `dist/`。
2. **三闸门**：`verify:release-names` / `verify:artifacts` / `verify:desktop-boot` 全过才交付。
3. **验收清单**（用户执行，逐条带证据）：
   - [ ] 重启 Aidy 运行时 → LLM 回合正常（W1.1 生效，对照「重启=大脑下线」旧风险）
   - [ ] 设置页版本显示 5.5.6（W1.2）
   - [ ] 「刷新模型」下拉出现 `hy4-preview`/`hy3` 等真目录（W1.1+W1.4）
   - [ ] 「我的 WorkBuddy」改 `hy4-preview` 后连接测试通过（W1.5）
   - [ ] **记忆连续性**：问「我们之前聊过什么」→ 能引用 9-21 及更早内容（W2 迁移生效）
   - [ ] **重扫码演练**：断开重连微信 → 记忆不空（身份主键换 openid 生效）
   - [ ] **换包演练**：换目录启动新包 → 记忆仍接续（workspaceRoot 固定生效）
4. **回滚**：还原 sessions.json 备份 + 上一版安装包即回到迁移前状态；转录只复制未移动，无损失。

## 4. 风险表

| 风险 | 缓解 |
|---|---|
| identityKey 链路漏改（dispatcher/reminder/deferred 等旁路） | W2-2/3 逐调用点清单核对 + M-4 只读排查 + 测试覆盖「换 bot_id 不换 key」 |
| CLI 转录目录名与预期不符导致 resume 失败 | M-3 探针会话先行确认实际目录名，再复制 |
| 迁移冲突选错主线 thread | 迁移前打印 diff 人工确认；备份可回滚 |
| 打包期新鲜度校验失败 | 产物冻结纪律；构建前 `mv` 旧目录 |
| 修复前用户重启 Aidy | P1 优先级最高；提醒用户在 W1 打包前**不要重启运行时** |
