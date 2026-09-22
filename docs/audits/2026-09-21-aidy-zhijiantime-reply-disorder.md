# 只读审计：Aidy 多气泡回复错乱（指尖时光日程助手）

- **审计日期**：2026-09-21
- **审计性质**：只读。**未修改、未重写、未重新生成任何对话内容**；仅对仓库源码做只读检索（未改动任何被打包路径）。
- **审计对象**：用户与 Aidy 的一段 4 条消息记录
- **结论**：单一用户输入（`hi`）触发了 **3 条独立气泡**，其中 2 条来自主动催办链路、1 条来自被动应答链路；**被动应答被排到最后**，且主动链路与被动链路的语义、语气互相矛盾。这不是「模型写错了一句话」，而是**回合编排层把两条互不知情的链路并行塞进了同一时间窗口**。

---

## 一、审计对象（原样引用，未作任何改写）

| 序 | 角色 | 内容 |
|---|---|---|
| M1 | 我 | hi |
| M2 | aidy | 今天指尖时光里还是一个安排都没有 |
| M3 | aidy | 现在就把今天要做的和行程填进去，然后直接回我一个具体时间点（比如 21:00），我准时来核对——别回"等会儿"，要给我准确时间 |
| M4 | aidy | hi 呀，晚上好。都快六点半了，你今天怎么过的？ |

> 记录中 M2/M3 同属一次主动催办；M4 是对 M1（`hi`）的应答。

---

## 二、逐条问题定位

### 缺陷① 忽略用户初始消息 —— 定位：M1 → M2 之间
- **表现**：用户在 M1 只发了 `hi`。M2、M3 完全没有任何问候语义，直接进入「你今天没做计划，现在去填」的指令态。用户的第一句话在**前两条回复里被彻底跳过**。
- **判定**：**双方都失败**。Aidy 不是「答了一半」，而是「答了另一件事」——M1 的应答被推迟到 M4 才出现。

### 缺陷② 重复回复 / 同源催办未合并 —— 定位：M2 与 M3
- **表现**：M2 与 M3 之间无任何用户输入，却是两条独立气泡，且**同源同义**：
  - M2 = 「当前没有任何安排」（状态陈述）
  - M3 = 「现在就去把安排填进去 + 回我一个准确时间 + 不许说等会儿」（动作要求）
- 这恰好对应两条**并行的催办指令模板**（见 §四证据 E2 / E3），二者在 `total === 0` 时都会命中，且都要求「firm 语气 + 要一个准确时间 + 不接受 later」。**重复催办**而非「分两条说清楚一件事」。

### 缺陷③ 逻辑矛盾 / 时间线冲突 —— 定位：M3 与 M4 之间
- **表现**：
  - M3 隐含语义 = **规划态**（今天还没计划，现在去做）——像日初/日中的催促。
  - M4 明确语义 = **复盘态**（"都快六点半了，你今天怎么过的？"）——像日终的收尾寒暄。
- **矛盾点**：18:30 让用户「现在去把今天要做的事规划好」本身已很勉强；紧跟着又问「今天怎么过的」，两条消息对**同一天处于什么阶段**给出了互斥判断。
- **附带**：M3 里的 `21:00` 是模型自造的具体时刻（模板只要求「要一个准确时间」，未给候选）。它比当前时刻晚 2.5 小时，未被真实窗口校验，但本身不构成错误，仅标注。

### 缺陷④ 应答顺序倒置 —— 定位：M4 的**位置**
- **表现**：对 M1（`hi`）的应答本应是这一批输出的**第一条**，实际被排在**第三条**。用户视角是「我打招呼，机器人先骂我两句，最后才想起跟我打招呼」。
- **判定**：**顺序倒置**，不是内容错误。链路缓存/闸门导致先发的主动消息先落盘，后生成/后放行的被动应答被追加在尾部。

### 缺陷⑤ 语气跳变 —— 定位：M3 → M4
- **表现**：
  - M2/M3 语域：**命令式、最后通牒**（"现在就把……填进去"、"别回'等会儿'"、"要给我准确时间"）。
  - M4 语域：**亲切寒暄、近人**（"hi 呀"、"晚上好"、"你今天怎么过的？"）。
- **判定**：**同一批次内语域断崖**。原因不是模型情绪不稳，而是两个来源的 prompt 各带相反的语域要求（见 §四证据 E2/E3 的 "firm" vs 应答侧的自然人格）。

---

## 三、问题根源归类

| 缺陷 | 症状 | 归类 | 落点 |
|---|---|---|---|
| ① | 忽略用户初始消息 | **生成逻辑异常**（回合编排） | 主动消息与用户回合共用同一发送闸门，未做「先答用户」互斥 |
| ② | 重复回复 | **生成逻辑异常**（去重闸门缺口） | 唯一去重只拦 `random` + `followup_scheduled`；同日 `planning_followup × random` 并发不被拦 |
| ③ | 逻辑矛盾 / 时间线冲突 | **上下文记忆丢失** | 两条 prompt 分支互不可见；催办上下文**无时刻语义**（唯一时间感知是静默时段 23:00–07:00，18:30 不在其中） |
| ④ | 应答顺序倒置 | **生成逻辑异常**（时序） | 用户回合若被 `isTurnDispatchBlocked` 缓冲，重新放行时排在已入队的主动消息之后 |
| ⑤ | 语气跳变 | **指令遵循失败** | 两份 prompt 语域相反（强制 firm ↔ 自然寒暄），同一批次内叠加 |

**一句话归因**：主因是**生成逻辑异常（回合编排 + 去重闸门缺口）**，它造成了 ①②④；**上下文记忆丢失**造成 ③；**指令遵循失败**是 ⑤ 的直接原因，但它是 ① 的**下游症状**——如果没有把两条链路塞进同一窗口，语域根本不会打架。

---

## 四、代码级证据链（只读检索所得）

**E1 — 两条链路的分叉点**
`src/integrations/zhijiantime/daily-supervisor.js`
- `classifySystemMessage()`（:393-398）把系统消息分为 `random`（`checkin:` / `supervision:random:`）与 `planning_followup`（`supervision:zhijiantime-planning:`）。
- `enrichSystemMessage()`（:35-90）对二者**分别**注入上下文：`:77-79` 二选一。
- 用户回合走的是**另一条路**：`src/core/app.js:704-727` `enrichIncomingMessageWithZhijiantimeFreshRead()` —— 只做 freshness 判定，**不注入**监督上下文。**两条路互不知情。**

**E2 — 催办文案模板（对应 M2 + M3）**
`daily-supervisor.js:293-303` `buildRandomCheckinContext()`（`total === 0` 分支）：
> "Send one short, **firm**, natural WeChat message requiring the user to make today's plan in 指尖时光 **and reply with an exact follow-up time**." / "Do not accept a vague 'later'."

**E3 — 第二条催办模板（与 E2 同窗口会被一起注入）**
`daily-supervisor.js:314-322` `buildPlanningFollowupContext()`（`total === 0` 分支）：
> "Send one short, **firm** message stating that the plan is still missing. Require the user to **make it now or give another exact follow-up time**." / "Do not accept a vague 'later'."

E2 + E3 叠加 = M2/M3 的「无安排 → 现在去填 → 给准确时间 → 不许等会儿」，且**只有在两条都被注入时才会出现两条气泡**。

**E4 — 去重闸门的缺口（缺陷②的直接原因）**
`daily-supervisor.js:70-75` 是**唯一**的重复抑制：
```js
if (kind === "random" && daily.total === 0 && record.state === "followup_scheduled") { ... return skip }
```
- 它**只**在 `state === "followup_scheduled"` 时抑制 `random`。
- 若当日记录停在 `unseen` / `awaiting_commitment`（`:60-69` 会把 `planning_followup` 强写成 `awaiting_commitment`，而 `:206-213` 也会写 `awaiting_commitment`），则 `random` **不会被抑制** → 与同窗口的 `planning_followup` 一起放行 → **重复催办**。
- `markPrompted()`（:216-220）只写 `lastPromptAt`，而全文件**没有任何地方读取 `lastPromptAt` 做冷却判断** → 当日已催过也不会被拦。

**E5 — 设计意图本是「一天只留一条」，实现未闭合**
`src/core/supervision-policy.js:195-214` `resolveSupervisionKey()` 把 `random` 与 `zhijiantime` daily-planning **都映射成同一个 key** `daily_plan:<date>`；`system-message-queue-store.js:218-225` `mergeCoalescedSystemMessage()` 按「新者胜 + 优先级取大」合并。
→ **意图**：同日至多一条监督消息。**实际**：E4 的缺口让两条模板在**进入队列前**就已各自生成气泡，合并发生在 `message` 级而非 `prompt` 级，因此用户仍看到两条。

**E6 — 时序倒置（缺陷④）**
`src/core/app.js:1050-1056` `routePreparedInbound()`：用户回合若命中 `isTurnDispatchBlocked()`，走 `bufferPendingInboundMessage()` **缓冲**；而主动链路 `flushPendingSystemMessages()`（:1368-1400）→ `dispatchSystemMessage()`（:1496-1520）也在同一闸门下放行。两者**没有「被动应答优先」的排序约束** → 被缓冲的 `hi` 应答只能排到已入队主动消息之后。

**E7 — 内部指令直接拼进正文（放大器）**
`daily-supervisor.js:400-402` `appendInternalContext()`：`message.text = 用户文本 + "\n\n" + 内部上下文`。英文祈使句指令（E2/E3）被拼进同一个 `text` 字段，模型对「这是给我下的指令」和「这是要回复的人话」的边界被削弱。

**E8 — 时刻语义缺失（缺陷③的直接原因）**
`supervision-policy.js:7-11` 静默时段默认 `23:00–07:00`。18:30 **不在其中**，因此催办照发；而 E2/E3 的模板**没有**任何「现在几点 / 今天还剩多久」的约束 → 18:30 仍输出「现在去规划今天」。

**E9 — 非根因（排除）**
`src/core/explicit-checkpoint.js:103-107` 能解析裸 `21:00`（`colonForm`），`capturePlanningCommitment()` 的闭环本身**可以**成立。故「用户回 21:00 却收不到跟进」**不是**本次问题，无需归因于此。

---

## 五、可验证的复现路径

1. 让当日 `zhijiantime-daily-supervision.json` 的 `record.state` 停在 `awaiting_commitment`（而非 `followup_scheduled`），使 E4 闸门失效。
2. 在同一时间窗口内先后触发一次 `checkin:`（random）与一次 `supervision:zhijiantime-planning:`（planning_followup）。
3. 在两者 drain 之前发送 `hi`。
4. 预期观察：出现 ≥2 条主动气泡 + 1 条被排在尾部的应答气泡 → 与 M2/M3/M4 同构。
5. 反证：将 `state` 预置为 `followup_scheduled` 且 `followupDueAt` 未到，则 M2/M3 应只出现一条（或 0 条），M4 应回到首位。

---

## 六、修复方向（建议，非本次审计结论）

| 优先级 | 方向 | 落点 |
|---|---|---|
| P0 | 去重闸门从「`random` 单侧 + state 白名单」改为「同日 `daily_plan:<date>` key 已放行过即抑制全部监督模板」 | `daily-supervisor.js:70-75`、`system-message-queue-store.js` |
| P0 | 显式定义「被动应答优先于主动消息」的发送排序 | `app.js:1368-1400`、`routePreparedInbound` |
| P1 | 催办上下文注入当前时刻与「今日剩余时段」；日终（如 ≥18:00）改用复盘语域模板 | `daily-supervisor.js:293-329` |
| P1 | 用户回合与主动回合**互斥**：同一 `bindingKey` 下有未消费的用户回合时，主动消息退避 | `app.js` 闸门层 |
| P2 | 内部指令与用户正文分离为不同 message role，不再拼进 `text` | `daily-supervisor.js:400-402` |
| P2 | 读取 `lastPromptAt` 实施催办冷却 | `daily-supervisor.js:216-220` |

> 本审计为只读结论，未执行上述任何修改，也未触碰 `dist/` 与其它打包路径。
