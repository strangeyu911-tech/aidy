# 评审：Kimi K2.8 修复计划 v1（疏漏核查）

- **日期**：2026-09-22（00:30）
- **性质**：**只读评审**。未修改任何源码、运行时数据、对话内容；也未改动被评审文档（`2026-9-21-Kimi-K2.8-plan-v1.md`）与原计划（`2026-09-21-aidy-reply-disorder-fix-plan.md`）。
- **被评审对象**：`docs/audits/2026-9-21-Kimi-K2.8-plan-v1.md`（含其 §6.1 用户裁决）。
- **方法**：对 Kimi 计划的每条结论与「方案有效性前提」逐条回源码核验；可行类主张一律追到「有没有可调用的写入/读取通道」为止，不接受"设计上应该可行"。

## 结论摘要

Kimi 的事实性结论**基本属实**（9 条 RC 中它保留的 8 条我全部复核通过，引用的测试基线也准确）。疏漏集中在**方案有效性**与**验收断言的可执行性**上，其中 1 条是决策级的：

| 级别 | 编号 | 一句话 |
|---|---|---|
| **决策级** | K1 | 路线 B 在当前 runtime（codebuddy）**没有写入通道**，可行性判反 |
| 决策级 | K2 | A2（10 分钟即弃）会吞掉 A8（8 次上限），优先级未定义 |
| 决策级 | K3 | RC5 只降级了一半：用户不回复时仍无任何到期核对 |
| 决策级 | K4 | 症状①/④ 的「新鲜竞争」分支无人认领，也没写进边界 |
| 落地级 | K5 | A6 负例表述会被理解成「不建任何 checkpoint」，有误删正常功能的风险 |
| 落地级 | K6 | D1 的「残余任务文本为空」没有可用的取值口 |
| 落地级 | K7 | 剥离会变成第三套实现，且未规定覆盖会话转录 |
| 落地级 | K8 | 两处 citation 偏差会把实施者引向错误文件 |
| 卫生 | K9 | checkpoint 层的同一陈旧问题未纳入，状态与事实不符 |
| 卫生 | K10 | 三份文档并存，无「已被取代」标记 |

---

## 1. 核对通过的部分（Kimi 对的地方）

| Kimi 结论 | 我的核验 | 结论 |
|---|---|---|
| RC5 降级为假根因：承诺可经用户回合兑现 | `capturePlanningCommitment` 门槛是 `state ∈ {awaiting_commitment, followup_scheduled}`（`daily-supervisor.js:94`），而 state 存在**按日期全局**的 `zhijiantime-daily-supervision.json`（`:24-28`），与 threadKey / 会话 scope **无关** → 用户回「21:00」确实能转同一条记录 | ✅ 成立 |
| RC2 修法落点在 flush 过滤链、沿用 `expired` 事件 | 重试消息经 `nextAttemptAt` 回到 `drainForAccount`（`system-message-queue-store.js:82-103`）→ **必经** `flushPendingSystemMessages` 过滤（`app.js:1372-1377`，`:1375` 已有 `expired` 事件）；字段 `taskType`/`source`/`supervisionKey` 真实（`supervision-policy.js:152-175`、`queue-store:128-136`）；`checkin:` 消息带 `dueAt`（`system-checkin-poller.js:47`）→ age 规则可落地 | ✅ 成立 |
| RC3 双路径、路径 B 入队的是富化后副本 | `app.js:2228-2233`（`...message` spread）+ `system-message-dispatcher.js:39`（`{...message}` 浅拷贝） | ✅ 成立 |
| 测试基线 711 / 710 pass / 0 fail / 1 skip | 本机实跑确认 | ✅ 准确 |

---

## 2. 决策级疏漏

### K1｜路线 B 在当前 runtime 下没有写入通道（裁决 1 的前提被反过来）

Kimi 的判断是：路线 B「保守、不动会话生命周期、直接实施」，路线 A「改动大、需评审」。用户据此在 §6.1 裁决「选 B，直接实施」。实际证据相反：

1. **当前 runtime 不是 builtin-api**。本机两个 provider profile 的 `runtimeId` 都是 `codebuddy`（`~/.cyberboss/provider-profiles.json:8`、`:44`）→ 活动链路是 CodeBuddy ACP。
2. **ACP 只暴露三种会话操作**：`session/new`、`session/resume`、`session/prompt`（`src/adapters/runtime/codebuddy/client.js:89`、`:115`、`:123`）；`prompt` 只接受 `{ sessionId, prompt: [{ type: "text", text }] }`（`:124-127`）——**没有任何「追加 assistant 历史」的方法**。
3. **Aidy 侧转录只属于 builtin-api**。全仓只有 `src/adapters/runtime/api/index.js` 引用 `ConversationStore`（`:233` resume、`:242` beginTurn、`:246` 拼接 `previous.messages`）；ACP runtime 的历史在 runtime 侧，Aidy 只持有 `bindingKey → threadId` 的绑定（`codebuddy/runtime-adapter.js:234`、`:287`、`:301`）。~~threadKey → sessionId~~

**推论**：「已送达的主动消息以助手角色镜像写入用户会话」在 codebuddy 下**今天无法实现**，需要 runtime 侧新增能力（外部依赖）。这条是三条路里最不"保守"的。

**反过来，路线 A 才是当前唯一可落地的根治**：~~threadKey 是 Aidy 自己传的（`system-message-dispatcher.js:30`），改成复用用户会话的 threadKey 即可让系统回合与用户回合共用同一 runtime 会话（`sessionStore` 的映射链路已存在）。~~ 🔴 **2026-09-22 勘误：结论（路线 A 是唯一可落地根治）成立，但机制表述与证据作废。** `threadKey` 全仓 0 处读取（死字段），无法承载作用域；真机制是 `app.js` 的 `buildSystemRuntimeBindingKey()` → `<bindingKey>::system` 后缀，路线 A 的实际改动是**去掉该后缀**（改动点与该行同源，故本条的方向判断仍有效）。详见 `2026-09-22-route-a-scope-merge.md` §3.1/§3.2。代价是 Kimi 自己指出的「模式污染」——但那是 **prompt 设计问题，不是能力缺失**，可缓解。

**若 A 与 B 都暂不做**，目前唯一能消掉用户可感主症状（重新打招呼）的手段，就是被裁决取消的第 3.5 步（用户回合 prompt 注入，`app.js:704-727` 已有现成追加点）。

> **净结论**：现在的事实是「取消了能做的（3.5），选了做不了的（B）」。裁决 1 需在 **A / 3.5 / 等 runtime 支持** 三者间重裁。

### K2｜A2 与 A8 在 random 消息上互相吞掉

`PROACTIVE_RETRY_DELAYS_MS = [5s, 30s, 120s, 600s]`（`app.js:77`），封顶后按 600s 无限重试 → 累计到第 8 次需约 **43 分钟**。而 Kimi 的 A2 是「random 超 10 分钟即弃」→ **random 消息永远到不了 8 次上限**，A8 的「达上限转 archived」对 random 不可达。计划未定义两者优先级，验收时两条断言会互相否定。

**建议**：显式写明「age 规则优先于 attempt 上限」，并区分来源（random 走 age、其余走 attempt）。

### K3｜RC5 只降级了一半：未答复分支仍无到期核对

D2 的论证只覆盖「用户回复了时间」。当用户**不回复**时：state 停在 `awaiting_commitment`，`followupDueAt` 与 `checkpointId` 被显式清空（`daily-supervisor.js:60-68`）→ 没有任何 checkpoint 到期；唯一兜底是 random 查岗，而 Kimi 又把 RC8 判为「产品特性、不保证跟进」。

于是 M3 那句「我准时来核对」在产品语义上**仍然是空承诺**。A5★ 只写「改成条件式措辞」不够：

- 要么补断言「未答复态 N 小时内必有跟进」；
- 要么明确把承诺降级为「我等着你」，并**显式告知用户这是产品语义变化**，而不只是修复手法。

### K4｜症状①/④ 的「新鲜竞争」分支无人认领

Kimi 判「不与用户消息落在同一分钟窗口」为伪目标（理由：在飞 turn 不可抢占、真凶是陈旧重放）——**陈旧重放那一半我认同，RC2 能兜住**。但另一分支仍然存在：**刚出炉的 random 消息与用户消息同时待发**时，用户回合会被缓冲、排到主动消息之后（`app.js:1050-1056` 的缓冲与重放）。

计划既没有补「同批 pending 时用户优先」的断言，也没把它写进 §5 边界 → **决策悬空**。建议二选一，别留白。

---

## 3. 落地级疏漏

### K5｜A6 负例表述有误删正常功能的风险

「我晚上8点要吃饭」在计划分支返回 null 后，`captureSupervisionArrangement` **会继续走** `extractExplicitCheckpoint`（`app.js:748-768`），建一条 `conversation` 类监督 checkpoint（`title: "吃饭"`）。所以 A6 的负例必须写成「**不建计划 checkpoint、不改 daily state、不抑制查岗**」；写成「不建 checkpoint」会被实施者理解成拦住 `:748-768`，从而削掉正常提醒能力。

### K6｜D1 的「残余任务文本为空」没有取值口

`extractExplicitCheckpoint` **内部**算了残余任务文本（`explicit-checkpoint.js:49-51` 的 `taskText`），但**不对外暴露**：返回值只有 `title`（空时兜底 `"按约定时间跟进"`）与 `canonicalTaskId`（空时兜底 `conversation:follow-up`）。

因此「纯时间表达」判定必须先补一个取值口：给 `extractExplicitCheckpoint` 增加导出字段（`hasTaskText` / `taskText`），或新增 `isBareTimeExpression(text)`。计划未指定 → 实施者只能靠兜底字符串反推，脆弱。

### K7｜剥离会变成第三套实现，且未规定覆盖会话转录

现有两处「往文本追加内部块」：`appendInternalContext`（`daily-supervisor.js:400-402`）、`captureSupervisionArrangement`（`app.js:739-745`、`:762-768`）。Kimi 还要再加 RC3 的剥离与 RC6 的 `[PLAN_COMMIT]` 标记剥离，以及第 7 步的内部指令分离。

计划应明确：**剥离只有一个实现、三处共用**；且剥离必须同时作用于「出站文本」与「写入会话转录的文本」——否则标记会留在历史里被后续回合看到，甚至被模型模仿。

### K8｜两处 citation 偏差会把实施者引向错误文件

- D2 说「`app.js:742` 的话术是硬编码的『我会检查你有没有在指尖时光做好计划』」→ 该硬编码字符串实际在 **`daily-supervisor.js:132`**（`capturePlanningCommitment` 的 `announcement`）；`app.js:742` 只是把它拼进 systemNote。
- 第 4 步「话术诚实化」落点写 `app.js:737-746` 是同一处偏差，真实落点是 `daily-supervisor.js:130-133`。

---

## 4. 卫生项

### K9｜checkpoint 层的同一陈旧问题未纳入（状态与事实不符）

`resolveDueCheckpointAction`（`supervision-policy.js:21-78`）**只在 dueAt 落静默时段时**判陈旧，非静默时段一律 `dispatch`（`:77`）；`SupervisionDispatcher.dispatch` 入队后立刻把 checkpoint 记成 `completed / queued`（`supervision-dispatcher.js:109`）。

于是「唤醒后被 message 层丢弃」的 random 消息，checkpoint 却显示已派发 → 状态与事实不符、可观测性失真。建议把 age 判定**下沉到 `resolveDueCheckpointAction`**（checkpoint 层作唯一真源），message 层只做兜底。

### K10｜三份文档并存，无权威版本标记

现状：本仓同时存在我的 v2（`2026-09-21-aidy-reply-disorder-fix-plan.md`）、Kimi v1（`2026-9-21-Kimi-K2.8-plan-v1.md`）及其内嵌裁决。Kimi v1 事实上已是最新基线，但 v2 没有任何「已被取代」标记 → 下一个实施者可能拿旧计划开工。

建议：按惯例**不删内容**，在 v2 顶部加一行 superseded 指针（或另起一份合并版），并指定唯一权威版本。

---

## 5. 建议对 Kimi 计划做的最小编辑（5 处）

1. **D4 / §6.1 裁决 1**：重裁。把「B 保守可行」改为「B 需 runtime 新增能力，当前不可落地；A 可落地但需接受模式污染」。
2. **第 2 步（RC2）**：补「age 优先于 attempt」，并把判定下沉到 checkpoint 层（见 K9）。
3. **A5 / A6**：改写负例口径与语义边界（见 K3、K5）。
4. **第 4 步（RC6）**：指定残余任务文本的取值口；统一剥离实现并覆盖会话转录（见 K6、K7）。
5. **§6 开放问题**：补一条「新鲜竞争分支的归属」（见 K4）。

> 本文档为只读评审结论，未执行任何修改，未触碰 `dist/` 与其它打包路径。
