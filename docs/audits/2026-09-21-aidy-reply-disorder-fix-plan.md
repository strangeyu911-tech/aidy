# 修复计划：Aidy「主动触达 × 用户回合」错乱（v2）

> ⚠️ **已被取代（2026-09-22）** —— 本文件仅作过程留档，**请勿据此实施**。
> - 最新基线：`docs/audits/2026-09-22-Kimi-K2.8-plan-v2.md`（其上游 `2026-9-21-Kimi-K2.8-plan-v1.md` 亦已 superseded，含 §6.1 用户裁决）。
> - 本文件以下结论已作废：**RC5 判定**（已降级为假根因）、**RC8 处置**（已移出修复范围）、**P0-4 优先级**（P0 / P2 分歧，已取消过渡注入）。
> - 另见 `docs/audits/2026-09-22-kimi-plan-v1-review.md`：Kimi v1 的**路线 B 同样不可落地**（当前 runtime 无 assistant-history 写入通道），RC1 路线需重新裁决。

- **日期**：2026-09-21
- **性质**：**计划文档，不含代码改动**。不修改任何源码、运行时数据或对话内容。
- **输入（三份）**：
  1. `docs/audits/2026-09-21-aidy-zhijiantime-reply-disorder.md`（本会话早前，**静态源码推断**）
  2. `docs/audits/2026-09-21-aidy-reply-disorder-final-verified.md`（**bridge.jsonl / 网关日志 / 会话 jsonl 运行时证据**）
  3. `docs/audits/2026-09-21-aidy-supervision-gaps-followup.md`（Kimi K2.8，**全量重读监督链路源码的补漏**）
- **口径**：证据等级 **运行时日志 > 源码核实 > 静态推断**。本版对三份文档的结论逐条在源码侧复核（见 §1「亲验」列），并在 §0 显式列出被自己或他人推翻的条目。

## 修订记录

| 版本 | 变化 |
|---|---|
| v1（本会话） | 基于首份静态审计撰写；把「富化重复注入」的机制列为**阻塞待验证**，并安排「第 0 步：读 `5cac11a4-*.jsonl` 判定 6× 是 6 条 message 还是 1 条内 ×6」。 |
| **v2（本版）** | ① **RC3 机制已从源码坐实**，阻塞项解除；② 采纳 Kimi 的 4 项新发现并新增 RC6–RC9；③ 优先级重排（1 项降级、1 项升级）；④ 验收断言由 5 条扩到 9 条；⑤ 修正 v1 中一处**读码不全**导致的错误表述。 |

---

## 0. 勘误

> 🔴 **2026-09-22 追加勘误（RC1 机制写错 —— 本文件所有涉及之处一并作废）**
> 下表 §1 的 **RC1「关键证据」栏把机制归到 `threadKey`，这是错的**。`threadKey`
> 全仓只有 2 处写入、**0 处读取**，是死字段。真正的 scope 分裂是
> **`app.js` 的 `buildSystemRuntimeBindingKey(bindingKey)` → `<bindingKey>::system` 后缀**
> 在 session store 里造出独立 binding → 独立 threadId → 独立 ACP 会话。
> RC1 的**结论（两套会话互不共享历史）成立**，但**机制与证据行号无效**；
> 本文件 §1 表格、§0.1/0.2、§3 中凡以 `threadKey` 作为分裂凭证的表述，一律以
> `docs/audits/2026-09-22-route-a-scope-merge.md` §1 第 2 步、§3.1、§3.2 为准。
> 本文件为历史记录，保留原文不覆盖。

### 0.1 我（首份审计）被推翻的结论 —— 已作废

| 我的结论 | 实际核实 | 处置 |
|---|---|---|
| 「两条催办模板同时命中，产出 M2/M3 两泡」 | **错**。M2+M3 是**同一次模型回复**（81 字符），被发送器按 20 字最小块拆两泡。队列层 `coalesceSystemMessages` 按 identity（含 `supervisionKey` + `taskType`）合并，random 与 zhijiantime 同映射 `daily_plan:<date>` → **入队即合并**，双模板不可能同时出泡。 | 作废，改为 RC4。 |
| 「去重闸门缺口是重复回复的直接原因」 | **不成立为本因**（本次只走 `random` 一支）。该闸门现为**第二道防线**。 | 降为 P2 观察项。 |
| 「两条链路被塞进同一 turn」 | 是**两次独立 turn**（18:23:27 / 18:24:11），乱序观感来自**积压重放**。 | 改述为 RC2。 |
| §四 E8「静默时段默认 23:00–07:00 → 18:30 催办照发」 | **结论仍成立**（18:30 确不在窗口内，模板确无时刻语义），但须补一句：静默时段**已可配置**（`settings.quietHours`，见 `renderer.js:458`、`main.js:377` 持久化白名单），非硬编码；且窗口内非 random 消息是**延迟**而非丢弃。 | 收紧措辞，不改变结论 |
| v1 §1「**队列存储层不会拼接文本**」 | **读码不全**。我只核了 `flushPendingSystemMessages` 的重入队路径（确实传未富化的循环变量），**漏掉了第二条重试路径** `scheduleSystemMessageRetry`，它传的是**富化后的副本**。 | 见 RC3，本版已更正。 |

### 0.2 Kimi 对首份审计的正确指正 —— 已采纳
- 首份 E4/E5 双模板机制**已不存在**（队列层合并）→ 采纳，降级。
- 首份「重积压重放需**新增**限流」**部分已存在**：指数退避 5s/30s/120s/600s + 3 次失败熔断 2 分钟（`app.js:77-79, 2221-2227`）已有；**缺的是次数上限**（RC7）→ 采纳，修正措辞。

---

## 1. 已核实的根因清单

| 编号 | 根因 | 关键证据 | 等级 | 亲验 |
|---|---|---|---|---|
| **RC1** | **会话 scope 分裂（架构级，主根因）**：主动消息与用户回合走两套 thread，互不共享历史 | `system-message-dispatcher.js:30` → `threadKey: "system:<senderId>"`；`weixin/message-utils.js:47` → `threadKey: message.session_id`。运行时：turn 2 `session/new`、threadId `71b17216` ≠ `5cac11a4` | 强 | ✅ |
| **RC2** | **积压重放撞上用户上线** | 17:37 入队 → 17:39–18:00 七次 `CODEBUDDY_START_TIMEOUT` → 18:23:27 重放，早于 18:23:47 的 `hi` 仅 20 秒 | 强 | ⏸ 引用 |
| **RC3** | **富化非幂等 ＋ 重试入队的是「富化后副本」→ 文本随失败次数累加** | 见 §1.1 分解（本版新增，**机制已锁定**） | 强 | ✅ |
| **RC4** | **拆泡**：`DEFAULT_MIN_WEIXIN_CHUNK = 20`，两段须**都 < 20** 才合并 → 16 + 62 必然两泡 | `weixin/config-store.js:4`、`weixin/index.js:293-339`。**结构性**：监督文案天然「状态句 + 空行 + 指令句」两段式，故主动消息**几乎必然**两泡 | 强 | ✅ |
| **RC5** | **系统回合不可能创建 checkpoint → 主动消息的承诺无落库** | `app.js:730` `captureSupervisionArrangement` 对 `provider === "system"` 直接 return；而 M3 承诺「我准时来核对」 | 强 | ✅ |
| **RC6（新）** | **承诺捕获无意图门槛**：任何「8点 / 21:00 / 40分钟后」都被当成「计划承诺」 | `daily-supervisor.js:102` → `extractExplicitCheckpoint`；`explicit-checkpoint.js:23-72` **无任何意图词校验**。用户「我晚上8点要吃饭」→ 误建 daily-planning checkpoint → 硬编码话术自信确认 → state 写 `followup_scheduled` → **随机查岗被抑制数小时** | 强 | ✅ |
| **RC7（新）** | **监督消息重试无次数上限；非静默时段消息永不失效** | `app.js:2219` `Math.min(attempt-1, 3)` 封顶 600s 后**无限重试**；`supervision-policy.js:152-175` 的过期判定**只覆盖 dueAt 落静默时段**的消息 → 17:37 这类普通时段消息永不失效 | 强 | ✅ |
| **RC8（新）** | **空计划日 = 无限催办循环；`lastPromptAt` 全仓无读者** | state=`awaiting_commitment` 时闸门不拦 random → 每次随机查岗都催一次；`markPrompted()`（`:216-220`）只写不读。09-18 实测 18 天 266 条 random ≈ 15 次/天 | 强 | ✅ |
| **RC9（新）** | **`planning_followup` 在「派发前」就烧毁承诺状态** | `daily-supervisor.js:60-69` 在**派发之前**把 state 覆写为 `awaiting_commitment` 并清空 `followupDueAt`/`checkpointId` → 该次派发失败（如超时）时用户刚答应的契约被单方面作废且无记录，且闸门立刻对 random 失效 | 强 | ✅ |

### 1.1 RC3 机制分解（本版锁定，解除 v1 的阻塞项）

存在**两条重入队路径，载荷不同**：

| 路径 | 触发点 | 入队内容 | 证据 |
|---|---|---|---|
| A. 队列层重入队 | `flushPendingSystemMessages` | 循环变量 = **未富化**的原始消息 | `app.js:1392, 1397` |
| B. **运行时失败重试** | `dispatchPreparedTurn` 启动失败 / `turn.failed` | `prepared.systemMessage` = **已富化的浅拷贝** | `app.js:931`、`app.js:2096` → `app.js:2228-2233` `enqueue({...message, …})` |

链路：`app.js:1504` `message = enriched.message` → `system-message-dispatcher.js:39` `systemMessage: {...message}` → `app.js:812-813` 存入 activeRecord → 失败时 `scheduleSystemMessageRetry` → `enqueue`（**带 `[Zhijiantime …]` 块**）→ 下次 dispatch 时 `enrichSystemMessage` **再追加一段** → 每次失败 +1 段。

**本次事故的 7 次超时全走路径 B**，故 **6 段块在同一个 `Trigger:` 正文内累加** —— v1 那个「6 条 message 还是 1 条内 ×6」的问题，答案是 **1 条 message 内 ×6**，无需再读会话 jsonl。

**顺带后果**：① 每次派发多烧 2–4k 无用 token；② 队列 JSON 文本无限变长（`normalizeSystemMessage` 不清洗历史块）；③ 若块内数据前后不一致（用户中途填了计划），模型同时看到新旧两份「verified data」。

---

## 2. 验收断言（修复完成的判定标准）

| # | 断言 | 对应 |
|---|---|---|
| A1 | 用户回合 prompt 中能读到**当天已发出主动消息**的摘要，模型不再出现「重新打招呼」 | RC1 |
| A2 | 主动消息不与用户消息落在同一分钟窗口；用户回合待处理时主动消息**退避** | RC2 |
| A3 | 同一条系统消息无论重试多少次，注入块**恰好 1 份**；重试入队的文本**不含**历史注入块 | RC3 |
| A4 | 主动监督消息不再以「16 字独立成泡」的形态出现 | RC4 |
| A5 | 主动消息中每个「我会在 X 时刻回来核对」承诺，**必有 pending checkpoint** | RC5 |
| A6 | 不含计划意图词的用户消息**不会**创建 daily-planning checkpoint，**不会**抑制随机查岗 | RC6 |
| A7 | `turn.completed` 之前，`followup_scheduled` 契约**不被状态覆写**；派发失败后重试仍是同一契约 | RC9 |
| A8 | 监督消息重试达到上限后转入终态（archived），不再无限重放 | RC7 |
| A9 | 空计划日的催办频次有上限（冷却生效），不再出现 15 次/天 | RC8 |

---

## 3. 分阶段修复计划

### P0 — 阻断错误行为

#### P0-1 富化幂等 ＋ 重试剥离（RC3）
- **落点**：`src/integrations/zhijiantime/daily-supervisor.js`（`enrichSystemMessage` / `appendInternalContext`）、`src/core/app.js`（`scheduleSystemMessageRetry` 或 `buildPreparedMessage` 侧）。
- **做法（描述）**：**推荐单点解** —— 让 `appendInternalContext` 变为**幂等**：追加前先**剥离**文本中已存在的内部上下文块（`[Zhijiantime …]` / `[CyberBoss supervision note]` 等已知前缀到块尾），再追加当前块。这样**两条重入队路径同时被覆盖**，且能顺带清理历史队列里已累加的残留，不依赖新增标记字段。
  - 备选/叠加：在 message 上记 `enrichedFingerprint = hash(id + 块内容)`，指纹一致则跳过追加。适合需要「重试时刷新数据」的场景（此时应**替换**而非追加）。
- **风险**：低。剥离需用「已知块前缀 + 边界」精确匹配，避免误伤用户正文。
- **验证**：A3。构造连续富化 3 次断言块计数恒为 1；构造「重试入队 → 再富化」序列断言文本不增长；补一条针对路径 B 的单测（v1 只覆盖了路径 A）。

#### P0-2 承诺捕获加意图门槛（RC6）
- **落点**：`src/integrations/zhijiantime/daily-supervisor.js:92-134`（`capturePlanningCommitment`）、`src/core/app.js:737-746`。
- **做法（描述）**：二者并用 ——
  1. **意图门槛**：捕获前要求消息含计划类意图词（指尖时光 / 计划 / 安排 / 填 / 规划…），或要求「时间表达 + 意图表达」同时出现；纯时间表达不得单独触发。
  2. **话术诚实化**：`app.js:742` 目前把 `planningCommitment.announcement` **硬编码**为「好，今天 20:00 我会检查你有没有在指尖时光做好计划」——**该文案不反映用户实际所说**（conversation 路径的 announcement 会复述解析标题，误解析可见；planning 路径固定，误解析**不可见**）。改为复述解析结果，让误解析裸露给用户。
- **风险**：低。门槛过严会漏掉合理承诺，需保留「用户明确说『我会去做计划』」这一类；建议门槛词表可配置。
- **验证**：A6。断言「我晚上8点要吃饭」不建 checkpoint、不改 state；「我8点前把指尖时光填好」正常建立。

#### P0-3 积压重放限流 ＋ 被动优先（RC2）
- **落点**：`src/core/app.js`（`flushPendingSystemMessages` 1368-1400、`routePreparedInbound` 1050-1056、`isTurnDispatchBlocked` 771）、`system-message-queue-store.js`。
- **做法（描述）**：
  1. **重放合并**：确认同一 `supervisionKey` 的积压在**重启路径**上也走 `coalesceSystemMessages`（机制已存在，需验证覆盖到 `load()` 之外）。
  2. **重放节流**：`attempt > 0` 的积压消息重放前加最小间隔与**单批总量上限**，避免同一秒倾泻。
  3. **被动优先**：同一 `bindingKey` 下有待处理用户回合时，主动消息**推迟**，可复用 `deferProactiveForBurst` 形态。**注意按 `source` 豁免**：`source === "conversation"` 代表用户自己的明确约定，不应被退避。
  - **修正 v1**：退避/熔断**已存在**（`app.js:77-79, 2221-2227`），本项**不是新增限流**，而是补「被动优先」与「重放批上限」。
- **风险**：中。豁免逻辑写错会把用户自己的提醒也压掉。
- **验证**：A2。单测覆盖「用户回合 pending → 主动消息不派发」「conversation 来源不受退避影响」。

#### P0-4 跨 scope 上下文补齐（RC1 的**缓解**，非根治）
- **落点**：`src/core/app.js`（`enrichIncomingMessageWithZhijiantimeFreshRead` 704-727 附近）。
- **做法（描述）**：给用户回合 prompt 追加一段「本轮之前的主动触达记录」，取当天已 `sender.succeeded` 的系统消息文本摘要（限条数、限字数），并**显式声明**这是「助手侧已发出的主动消息」，不是用户发言。使 M4 能知道「我 20 秒前刚催过」。
- **为什么留在 P0**：它是**当前唯一能消除用户可见主症状（重新打招呼）且不动架构**的手段。
- **与 Kimi 的分歧**：Kimi 把它列为 P2「兜底缓解」。我保留在 P0 但**明确标注为缓解** —— 因为它直接对应本事故的用户可感症状；而根治（P1-5）回归面大、需先评审，不应阻塞症状消除。此分歧请用户在 §6.1 裁决。
- **风险**：中低。涉产品语义（用户可能间接感知内部编排）；注入块需脱敏、限长。
- **验证**：A1。

### P1 — 行为正确性

#### P1-1 承诺状态迁移改到「投递成功之后」（RC9）
- **落点**：`daily-supervisor.js:60-69`、`app.js:2093-2099`（`turn.completed` / `delivered` 路径）。
- **做法（描述）**：把 `planning_followup` 的 `followup_scheduled → awaiting_commitment` 迁移，从**富化阶段（派发前）**移到**投递成功之后**执行；失败路径保持 `followup_scheduled` 原状重试。
- **风险**：中。需确认 `delivered` 事件在两条失败路径上都可靠到达，否则会退回「永不迁移」。
- **验证**：A7。断言「派发失败 → state 不变 → 重试仍是同一契约」。

#### P1-2 重试上限与全局过期（RC7）
- **落点**：`app.js:2215-2236`、`supervision-policy.js:152-175`。
- **做法（描述）**：给 supervision 消息加 `maxAttempts`（建议 8 次，超则 `archived`）；并补一条**全局 staleness**（如 `dueAt` 超 24h 归档），使普通时段消息也能过期。
- **风险**：中。上限过低会在长时间坏运行时丢消息，需与 P2-2 的可观测性配套，保证丢掉有记录。
- **验证**：A8。单测断言第 N+1 次失败后不再入队且状态为 archived。

#### P1-3 催办冷却（RC8）—— 由 v1 的 P2 **升级**
- **落点**：`daily-supervisor.js:70-75`、`:216-220`（`markPrompted` / `lastPromptAt`）。
- **做法（描述）**：读取 `lastPromptAt` 实施冷却（例如 3 小时内不重复催同一件事）；或同日催办达 N 次后转「只静默记录、不再开口」。模板自带 "If this was asked before, use different wording"（`:300`）说明预期了重复，但只有措辞层面、无频次层面。
- **升级理由**：Kimi 给出量级证据（18 天 266 条 random ≈ 15 次/天），对 ADHD 目标用户属**关通知级 spam**，不再是可以延后的体验项。
- **风险**：低。
- **验证**：A9。断言同一空计划日催办次数 ≤ 配置上限。

#### P1-4 承诺落库 ＋ 措辞诚实化（RC5）
- **落点**：`app.js:729-737`（`provider === "system"` 短路）、`daily-supervisor.js:92-134`。
- **做法（描述）**：两者并用 ——
  1. **放宽采集**：允许系统回合创建「等用户确认时间」的**占位 checkpoint**（与用户主动约定在 source 上区分）；需配过期回收，避免占位堆积。
  2. **措辞约束**：催办模板禁止**无条件**承诺句式，改条件式（「你定了时间我就来核对」）。
- **风险**：中（占位回收不当会堆积）。
- **验证**：A5。

#### P1-5 会话 scope 架构解（RC1 根治）
- **落点**：`system-message-dispatcher.js:30`、`weixin/message-utils.js:47`、thread→session 映射层。
- **做法（描述）**：路线 A（推荐）= 让 system 通道 `threadKey` 与用户会话**对齐同一 scope**；路线 B = 保留双 scope，建立**单向镜像**（主动消息下发成功后作为助手侧历史写入用户会话）。
- **风险**：**高**。涉及 session 生命周期、历史长度、「主动消息是否应出现在用户可见历史」的产品语义。**须先方案评审**。
- **验证**：A1 在**关闭 P0-4 注入块**后仍成立。

### P2 — 观察与加固

| 项 | 内容 | 说明 |
|---|---|---|
| P2-1 拆泡策略（RC4）—— 由 v1 的 P1 **降级** | `weixin/index.js:293-339`、`config-store.js:4` | Kimi 指出更优解：**在文案侧**把监督消息压成单段（段落空行改句号），或对 `taskType === "supervision"` 禁用拆泡。**不要**全局提高阈值（影响所有回复）。降级理由：观感问题，非缺陷级。 |
| P2-2 可观测性 | 每次主动派发记录 `attempt / supervisionKey / 富化份数 / 是否与用户回合相邻` | 使下次定位直接可查，而非事后考古。**是 P1-2 丢消息的前置配套。** |
| P2-3 去重闸门缺口 | `daily-supervisor.js:70-75` | 已由队列层合并兜住，仅补一条 `planning_followup × random` 并发单测。 |
| P2-4 内部指令与用户正文分离 | `daily-supervisor.js:400-402` | 英文祈使句拼进 `message.text`，削弱「指令 vs 人话」边界。中期改独立 message role。 |

---

## 4. 依赖顺序

```
第 0 步（已解除）：RC3 机制 —— v2 已由源码坐实为「1 条 message 内 ×6，经重试路径 B 累加」
   └─ 可选廉价确认：检视落盘的队列文件，看文本是否随 attempt 增长（约 1 分钟）
第 1 步：P0-1 富化幂等/剥离   ← 落点最清晰、风险最低，且能顺带清掉历史残留
第 2 步：P0-2 意图门槛 ＋ P1-1 状态迁移时机   ← 同属承诺链路，一起改一起测
第 3 步：P0-3 重放限流/被动优先   ← 依赖对 source 的豁免判断
第 4 步：P1-2 重试上限 ＋ P2-2 可观测性      ← 配套，必须同批
第 5 步：P1-3 冷却 ＋ P1-4 承诺落库
第 6 步：P0-4 注入块（缓解）→ 观察症状是否消失
第 7 步：P1-5 会话 scope 架构解 ← 先出评审方案；P1-5 完成后可关掉 P0-4
第 8 步：P2-1 拆泡、P2-3 单测、P2-4
```

**闸门要求**：本仓 `AGENTS.md` 规定改桌面端接线后必须跑 `verify:desktop-boot`。本条链路涉及 `app.js` 回合派发与 channel 发送，**P0-3 / P1-5 / P2-1 落地后必须过三条闸门**（`verify:release-names` / `verify:artifacts` / `verify:desktop-boot`）。测试基线当前 **711 / 710 pass / 0 fail / 1 skip**；P0-1、P0-2、P1-1~P1-4 均应有单测。

---

## 5. 明确不做 / 边界

- 不修改三份审计文档，不修改任何对话内容或运行时数据。
- 不触碰 `dist/`、不并发跑打包（发布纪律）。
- **不在本计划内直接改会话架构**（P1-5 需先出评审方案）。
- 不用「全局提高拆泡阈值」解决两泡问题（影响所有回复）。
- 不引入跨 scope 全量历史同步；P0-4 只做**当天、脱敏、限长**的主动触达摘要。
- 不为了「少出泡」而牺牲 M3 类指令的清晰度（文案侧压单段需保留语义）。

---

## 6. 需要用户裁决的开放问题

1. **P0-4 注入块的优先级**（我与 Kimi 的分歧）：我主张 P0（唯一能立刻消除用户可见症状），Kimi 主张 P2（仅是兜底，根治在 scope 统一）。取舍点是「先消症状」还是「先修根因」。
2. **P0-4 的产品语义**：接受「用户可能间接感知到系统内部编排」吗？不接受则需换更隐晦的表述，或把 P0-4 让位给 P1-5。
3. **P1-5 路线**：A（对齐 thread scope，彻底但改动大）还是 B（单向镜像，保守但留双份历史）？
4. **P0-2 意图门槛**：门槛词表是否可配置？过严会漏掉合理承诺（如「我一会儿就去弄」）。
5. **P1-4 占位 checkpoint**：允许系统回合创建「等用户确认」的占位计划吗？不允许则 A5 只能弱化为「不承诺」而非「承诺必兑现」。
6. **P2-1 拆泡**：文案侧压单段（推荐）还是对 supervision 禁用拆泡？
