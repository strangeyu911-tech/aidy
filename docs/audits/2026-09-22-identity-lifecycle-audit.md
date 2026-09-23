# 身份与生命周期审计：微信登录 ≠ Aidy 身份 ≠ 长期记忆

- 日期：2026-09-22
- 性质：**只读审计**（本轮不改任何代码；commit `242e7c9` 的去留待裁决）
- 触发：用户质疑「我扫的一直都是同一个微信号，哪来的旧账号？」并给出三层模型建议
  （①连接状态 ②用户身份 ③长期记忆），要求先弄清生命周期再动代码。
- 姊妹篇：`2026-09-22-phantom-checkpoint-1745.md`（-14 与幽灵跟进审计，§9/§10）。

---

## 0. 一句话结论

**你的质疑成立。** 你扫的始终是同一个微信号，磁盘上却出现了 4 个「账号」——它们不是你的账号，
是 Aidy 自己制造的：**Aidy 把微信平台每次扫码发的 bot 实例 id（`ilink_bot_id`）当成了身份主键**，
而真正跨扫码稳定的是 `ilink_user_id`（微信 openid）。`242e7c9` 的「记忆搬家」修复是在
错误的身份主键上做迁移——能用，但治标。正确修法是把身份主键换成 openid（见 §11 裁决建议，
**待你拍板后才动代码**）。

---

## 1. 决定性证据（本机实测，2026-09-22 18:5x）

### 1.1 `~/.cyberboss/sessions.json`：同一个 openid，4 个 accountId

6 个 binding，`senderId` **全部相同**（`o9cq80y1A…@im.wechat`，即你的微信 openid），
但 accountId（= bot_id）有 4 个不同的值（下表只写前 6 位）：

| bindingKey（accountId 段） | 挂载的 thread | workspaceRoot | 含义 |
|---|---|---|---|
| `d810faa…-im.bot` | （空） | — | 某次启动，没产生过对话 |
| `97b10c7…-im.bot` | `29929783…`（用户）+ `ec01e9e1…`（::system） | `D:\CyberBoss` | 早期账号，源码目录运行期 |
| `082e9f8…-im.bot` | `71b17216…`（用户）+ `5cac11a4…`（::system） | `D:\CyberBoss\dist\win-unpacked\resources` | 中期账号，打包目录运行期 |
| `219e3e20…-im.bot` | `b4170132…`（用户，::system 尚无） | `D:\CyberBoss\dist\win-unpacked\resources` | 当前账号（今天 17:45 扫码） |

**这就是「旧账号」的全部来源**：同一个微信号 × 4 次扫码 = 4 个 bot_id = 4 套记忆指针。
没有任何一次是你换了微信号。

### 1.2 账号文件证实两个字段的分工（token 已脱敏）

```
accounts/219e3e20e886-im.bot.json
  accountId: "219e3e20e886-im.bot"        ← 来自 ilink_bot_id（bot 实例，每次扫码变）
  userId:    "o9cq80y1A…@im.wechat"       ← 来自 ilink_user_id（微信 openid，跨扫码稳定）
```

### 1.3 代码不自洽的铁证：代码自己「知道」 userId 才是稳定身份

`src/adapters/channel/weixin/login.js`：

```js
// cleanupStaleAccountsForUserId —— 用 userId 判定"同一个人"
const staleAccounts = listWeixinAccounts(config).filter((account) => (
  account.accountId !== activeAccount.accountId
  && account.userId.trim() === activeUserId     // ← 以 userId 认人
));
```

清理逻辑按 userId 认人，身份索引（bindingKey）却按 accountId 分家。
同一个文件里两套身份观，这就是病根。

### 1.4 长期记忆的物理位置：按 cwd（= 安装目录）分家

`~/.codebuddy/projects/` 下与 Aidy 相关的转录目录至少 5 个：

```
d-cyberboss-dist-win-unpacked-resources      ← 当前（打包版）
d-CyberBoss                                   ← 源码版运行期
d-CyberBoss-dist-rebuild-win-unpacked-resources
d-CyberBoss-dist-win-unpacked-new-win-unpacked-resources
d-CyberBoss-local-dist-win-unpacked-resources
```

原因：`config.workspaceRoot = CYBERBOSS_WORKSPACE_ROOT || process.cwd()`（`src/core/config.js:14`），
打包版 bridge 的 cwd = 安装目录（`runtime-supervisor.js:805` `resolvePackagedSpawnCwd`），
而 **安装目录名会随构建/安装位置漂移** → 转录按漂移的目录名劈开。
另有 10 个 `c-Users-23159-.cyberboss-codebuddy-verification-*` 临时目录（健康检查垃圾）。

---

## 2. 逐题回答

### Q1 Aidy 的用户身份到底由什么标识？

**目前：没有独立的 Aidy 用户身份。** 事实上由 `bindingKey = workspaceId:accountId:senderId`
里的 `accountId`（bot_id）承担身份职责——而 bot_id 每次扫码都换。
唯一的稳定标识 `userId`（openid）只被用来当 bindingKey 的第三段和清理判据，
不是身份主键。**身份层寄生在连接层上，这是设计错误。**

### Q2 长期记忆实际存在哪里？

| 内容 | 位置 | 键 |
|---|---|---|
| **对话转录（真记忆）** | `~/.codebuddy/projects/<workspaceRoot转义>/<threadId>.jsonl` | workspaceRoot + threadId |
| thread 指针 | `~/.cyberboss/sessions.json` → bindings | bindingKey（含 bot_id）→ workspaceRoot → threadId |
| 监督/跟进状态 | `~/.cyberboss/supervision-plan.json` | plan item |
| 登录凭据（非记忆） | `~/.cyberboss/accounts/<bot_id>.json` | bot_id |

转录明文在本地、可读可迁移；记忆本身**不会**因为扫码或更新被删除，
被弄丢的从来只是「指针」。

### Q3 微信扫码登录之后发生了什么？

`login.js` 流程（逐行核对）：
1. 扫码确认后平台返回 `bot_token` + `ilink_bot_id` + `ilink_user_id`；
2. `saveWeixinAccount(config, ilink_bot_id, …)` —— **以 bot_id 为文件名**落盘；
3. `cleanupStaleAccountsForUserId` —— 按 userId 把旧 bot_id 账号退役（`242e7c9` 前是删除）；
4. bridge 启动 → `resolveAccount()` 读账号文件 → `activeAccountId = bot_id`；
5. 每条消息按 `buildBindingKey({workspaceId:"default", accountId:bot_id, senderId:openid})`
   找 thread —— bot_id 变了，这里就找不到旧 thread。

### Q4 为什么重新扫码会导致记忆为空？

链条：**bot_id 变 → bindingKey 变 → 新 binding 下零 thread 指针 → `session/new` 开新 thread → 新的空 jsonl。**
旧 thread 及其转录原封不动躺在旧 binding 和旧目录里，只是再也没人指它。
（今天 `242e7c9` 加的 `inheritThreadBindingsFromPriorAccounts` 在启动时把旧指针搬过来——
有效，但等于每次扫码后做一次抢救性搬家，而不是让指针根本不换地址。）

### Q5 为什么更新安装新版后微信登录态丢失？

**登录态（凭据）从不丢失**——`~/.cyberboss/accounts/` 不随安装/更新被清理，
今天 17:45 的账号文件就是跨构建活着的证据。丢的是两样别的东西：

1. **连接**：扫码自锁环（姊妹篇 §4）——重扫吊销旧会话 → -14 被判致命 → 被迫再扫 → 循环。
2. **记忆的可达性**：workspaceRoot = cwd = 安装目录。换包 → 目录变
   （`dist-rebuild` / `win-unpacked-new` / `local-dist`…）→ 旧 binding 的 thread 挂在旧
   root 下 → 新 root 查不到 → 开新会话。**感知上等同「记忆清零」，机制上与扫码无关。**

### Q6 三者目前是什么关系？

当前实现：**连接层（token+bot_id）与身份层（bindingKey 的 accountId 段）物理耦合**，
记忆指针再挂在 (bot_id, workspaceRoot) 两个都会漂移的坐标上。
一个变量（bot_id）同时承担「凭证标识」和「身份主键」两个互相冲突的职责。

### Q7 哪些状态应该持久化？

| 状态 | 应持久化 | 现状 |
|---|---|---|
| Aidy 用户身份（openid → identity 映射） | ✅ 终身 | ❌ 不存在独立实体 |
| thread 指针（identity → threadId） | ✅ 终身 | ⚠️ 挂在易变坐标上 |
| 对话转录 jsonl | ✅ 终身 | ✅ 已持久（但按 cwd 分家） |
| 监督/跟进状态 | ✅ 终身 | ✅ 已持久（supervision-plan.json） |
| 凭据 token | ✅ 持久（可换值，不可丢人） | ✅ 已持久 |

### Q8 哪些状态允许清空？

| 状态 | 允许清空？ |
|---|---|
| context-tokens / sync-buffers | ✅ 运行态，丢了重新拉取 |
| token 本身 | ✅ 值可换（重新扫码），人不能换 |
| desktop-state / proactive-delivery-log | ✅ 运行态 |
| 验证临时目录（`*-verification-*`） | ✅ 垃圾，应清理 |
| 对话转录 / thread 指针 / 身份映射 / 监督状态 | ❌ **永不**因生命周期事件清空 |

### Q9 六个生命周期应该发生什么 vs 实际发生什么

| 生命周期 | 应该发生 | 实际发生 |
|---|---|---|
| 首次安装 | 无身份无记忆，等首扫 | ✅ 一致 |
| 首次扫码 | 创建 Aidy 身份（绑定 openid），从此不变 | ❌ 只存了 bot_id 凭据，没有「身份创建」这个动作 |
| 正常启动 | 凭据在 → 恢复连接 → 按 identity 恢复 thread → 继续监督 | ⚠️ 连接可恢复；thread 靠 bot_id+cwd 找，坐标系变了就找不回 |
| 重新扫码 | **换连接不换身份**：新 token 落盘，identity/thread 不动 | ❌ bot_id 变 → 指针全体失联 → 记忆空（242e7c9 后会搬回来，但根子上指针不该动） |
| 软件更新 | 凭据/身份/记忆全在原位，起来接着用 | ❌ 连接层：自锁环；记忆层：cwd 变劈开指针 |
| 微信退出登录 | 仅连接层退役（token 失效），身份与记忆冻结待回归 | ⚠️ 现状没有「退出登录」概念，只有「账号文件被换掉」 |
| 数据库/文件损坏 | 转录 jsonl 是事实源，指针可重建 | ❌ sessions.json 损坏 = 指针全失，且无重建手段（转录里有 threadId 但没人反查） |

### Q10（用户点的图）→ 见下方状态机图与 §4 对照图。

---

## 3. 为什么平台每次扫码发新 bot_id？

无法从本仓库代码确认，属**观察到的平台行为**：同一 openid 四次扫码得到四个不同
bot_id（§1.1 实证）。iLink 侧每次扫码似乎新建一个 bot 实例。修复方案必须以
「bot_id 不可作为稳定键」为前提，不依赖对该行为的任何乐观假设。

---

## 4. 三层模型对照（GPT 建议 × 本机现实）

```
┌─ 第①层 连接状态 ────────────────┐   应含：token、bot_id、重连/重扫码逻辑
│  现状：与身份耦合 ✗              │   bot_id 是"本次连接的凭证名"，不是身份
├─ 第②层 用户身份 ────────────────┐
│  现状：不存在独立实体 ✗          │   openid 稳定存在但只当配角；
│                                  │   bindingKey 用 bot_id 当主键 = 身份骑在连接上
├─ 第③层 长期记忆 ────────────────┐
│  现状：数据在、指针挂错坐标 ✗    │   jsonl 永续；指针 = f(bot_id, cwd)，两个轴都会漂移
└──────────────────────────────────┘
```

---

## 5. 修复方向裁决建议（**未动代码，待拍板**）

> 原则：身份主键换掉之后，`242e7c9` 的搬家逻辑从「每次启动的常规操作」降级为
> 「对历史分裂 binding 的一次性收敛」，然后可以退役。

**方案 A（推荐）：身份主键换 openid**
- `buildBindingKey` 的 accountId 段改用 `userId`（openid）：bindingKey = `default:<openid>`。
  openid 跨扫码稳定 → 重扫码天然接续 thread，无需搬家。
- bot_id 退回连接层，只存在 `accounts/*.json` 里。
- workspaceRoot 固定为与安装目录无关的常量（如 `CYBERBOSS_WORKSPACE_ROOT` 默认
  `~/.cyberboss/workspace`），消灭 cwd 劈裂轴。
- 一次性迁移：把现存 4 套 binding 合并进 1 套 openid binding（旧 thread 优先），旧
  binding 保留只读或直接退役。
- 风险点：多微信号场景（openid 多值）语义变化——目前单用户产品，可接受；将来要多
  账号，再以 identity 表管理。

**方案 B：保留 bot_id 主键 + `242e7c9` 搬家**
- 已实现、已测试；但每次扫码依赖搬家成功，且 workspaceRoot 劈裂轴仍在——换包仍会
  丢一次记忆可达性。不推荐作为终态。

**P1（两案通吃）**：转录目录固定（消灭 5 个 projects 分家目录）；sessions.json 损坏时
可从转录 jsonl 反查 threadId 重建指针。

---

## 6. 证据清单

- `~/.cyberboss/sessions.json`（6 bindings / 4 accountId / 1 openid，2026-09-22 18:26 mtime）
- `~/.cyberboss/accounts/219e3e20e886-im.bot.json`（17:45，accountId=bot_id / userId=openid）
- `~/.codebuddy/projects/` 目录列表（5 个 Aidy 相关分家目录 + 10 个 verification 垃圾）
- `src/adapters/channel/weixin/login.js:196-200`（accountId=ilink_bot_id 映射）、`:98-115`（按 userId 认人清理）
- `src/adapters/runtime/codex/session-store.js:492-494`（buildBindingKey 三段式）
- `src/core/config.js:14`（workspaceRoot = env || cwd）
- `src/desktop/runtime-supervisor.js:805-808`（打包版 cwd = 安装 resources 目录）
