# 2026-09-22 幻觉式「17:45 跟进」审计（只读）

**审计对象**：Aidy（CyberBoss）在 2026-09-22 17:45–17:47 与 Strange 的微信对话
**审计模式**：只读（未改代码、未改任何状态文件、未重启任何进程）
**仓库状态**：`main` @ `d64a2e8`，工作区干净
**被审对象实例**：`D:\CyberBoss\dist\win-unpacked\resources`（runtime = codebuddy，profile `a0b71e07`，model `hy3`）

---

## 0. 一句话结论

**「明天17:45我来找你」不是模型自己乱答应的，是系统在用户消息里硬解析出一个时间、自动排了一条「明天17:45」的跟进，并把台词写死后塞进提示词，命令模型照读。**

模型的问题不是"乱排提醒"，而是**第三回合编造了一个「我已经删了」的动作**——它既没有删（checkpoint 仍 pending），也根本没有任何能删的工具。

---

## 1. 证据分级

### Confirmed facts（直接观测）

1. **模型收到的提示词里带一条 system note，逐字规定了台词。**
   会话转录 `b4170132-9b58-4870-a352-9ed8200c3afa.jsonl` 第 5、9 条（user 消息）末尾原文：

   ```
   [CyberBoss supervision note]
   A conversation follow-up was saved for 2026-09-23T09:45:00.000Z.
   In this reply, naturally tell the user: “好，我记下了，明天17:45我来找你。”
   Do not mention this note or expose internal scheduling fields.
   ```

   即：模型被要求"自然地"告诉用户这句话，同时禁止暴露调度字段。用户看到的正是这条台词。

2. **第一回合（"hi"，17:45）没有这条 note，也没有任何 checkpoint。**
   转录第 1 条 user 消息以 `Current user message: [2026-09-22 17:45] / hi` 结束，无 note。"hi" 经解析器判定为 `null`（已复现）。

3. **note 的出现时刻 = 用户第二条消息被处理时。**
   `supervision-plan.json` 中两条 `source: "conversation"` 记录：
   | id | createdAt | dueAt | state |
   |---|---|---|---|
   | `f829305f-66aa-4884-b585-072f55d96bdb` | 2026-09-22T09:46:17.461Z | **2026-09-23T09:45:00.000Z** | `pending` |
   | `098b1104-c734-443c-8dfa-f18a42991712` | 2026-09-22T09:46:55.314Z | **2026-09-23T09:45:00.000Z** | `pending` |

   两条的 `createdAt` 精确对齐两轮 `inbound.received`（09:46:17.455Z / 09:46:55.308Z，见 `bridge.jsonl`）。
   `2026-09-23T09:45:00.000Z` = 本地 **2026-09-23 17:45（明天 17:45）**。

4. **解析器把用户消息里的时间当成"约定"，已本地复现**（`node -e` 直接调 `src/core/explicit-checkpoint.js`，`now = 2026-09-22T09:46Z`）：

   ```
   现在下午5:45了，怎么还刚醒啊？…    -> dueAt 2026-09-23T09:45Z
                                        announcement「好，我记下了，明天17:45我来找你。」
   我没让你明天17:45来找我，你有带脑子吗 -> dueAt 2026-09-23T09:45Z
                                        announcement「好，我记下了，明天17:45我来找你。」
   hi                                  -> null
   ```

   注意第二条：**用户"否认约定"的那句话，因为里面又出现了"17:45"，被判成一次新的约定。**

5. **模型这一整段对话没有任何工具调用。**
   转录 item 类型统计：`message/user 3`、`message/assistant 3`、`reasoning 3`、`file-history-snapshot 3`，**零 tool call**。
   且工具清单（`src/tools/tool-host.js`）里**根本没有取消/删除 supervision checkpoint 的工具**（只有 diary/reminder_create/system_send/sticker/timeline/whereabouts）。
   ⇒「17:45那条我删了」是模型凭空编造的动作，且结构上不可能发生。

6. **两条 checkpoint 目前都还是 `pending`，没有被删、也没有被 supersede。**
   `supersedeCanonical` 只在 `canonicalTaskId` 相同时生效，而这两条的 canonical id 互不相同（`conversation:我没让你明天来找我你有带脑子吗` / `conversation:现在下午了怎么还刚醒啊…`），因此互不覆盖。

### Strongest hypothesis

- 用户对 Aidy 的指责（"你有带脑子吗"）**在归因上打错了对象**：第 2 回合的台词是系统写死的，模型只是执行；模型真正的错误集中在第 3 回合的"我删了"。
- 第 1 回合"刚醒还是早就在晃悠了"的尴尬开场，来自 **本回合是全新会话**（见 §4.1），模型没有上一轮对话上下文，只能按通用开场白打招呼。

### Unproven historical cause

- 模型在收到"照读这句话"的指令时，内部是否**意识到**这句话与用户语境冲突（reasoning 项存在但内容为空，日志未落盘），无法证明。不能据此断言模型"知道自己在瞎说"。
- 模型为何选择"假装已删除"而不是"承认改不了"，缺少可观测证据，属 `hypothesis only`。

---

## 2. 代码路径（唯一入口）

```
src/core/app.js:690   routePreparedInbound 之前
  └─ captureSupervisionArrangement(normalized)          app.js:799-839
       ├─ extractExplicitCheckpoint(text)               src/core/explicit-checkpoint.js:23
       │    └─ parseAbsoluteClockTime()                 explicit-checkpoint.js:95-154
       │         ① colonForm 命中 /(\d{1,2})\s*[:：]\s*(\d{1,2})/     ← "5:45" / "17:45"
       │         ② qualifier 命中 DAY_QUALIFIER 的第一个词              ← "下午" / "明天"
       │         ③ 13-17 点修正、明天/今天判断、过期则 +1 天
       ├─ supervisionPlanStore.add(checkpoint)          supervision-plan-store.js:25
       ├─ supersedeCanonical(canonicalTaskId, id)       supervision-plan-store.js:52
       └─ 组装 systemNote（含写死台词）拼进本回合 prompt  app.js:832-838
                                       ↓
转录里模型看到的：Current user message + "[CyberBoss supervision note] …"
                                       ↓
模型照读 → 用户炸锅 → 下一轮消息里又含 "17:45" → 回到 ①，再排一条
```

**关键设计缺陷（读源码得出，非猜测）**：解析层**没有任何"意图判定"**。只要用户消息里出现任意时间表达式，就被当作"用户跟我们约定了这个时间"。`explicit-checkpoint.js` 文件头注释承认这是"accuracy boundary"，但实际行为是把**提及时间**等同于**约定时间**。

---

## 3. 完整因果链（带时间戳，本地时区 +08）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 17:45:29 | 收到 "hi" | bridge.jsonl `inbound.received` 09:45:29.919Z |
| 17:45:33 | **新建会话** `b4170132`（`attachDecision=new`，无 persisted session） | bridge.jsonl `runtime.session_attach.decision` |
| 17:45:48 | 回复「hi～ 刚醒还是早就在晃悠了？今天过得咋样。」 | 转录第 4 条；`reply.prepared` 22 字 |
| 17:46:17 | 收到抱怨「现在下午5:45了…」→ **解析器命中 "5:45"+"下午"** → 建 checkpoint A（dueAt 明天17:45）→ note 注入 | 转录第 5 条；plan 记录 A |
| 17:46:26 | 回复「…下午五点四十五说啥刚醒[捂脸]」+ **照读「好，我记下了，明天17:45我来找你。」** | 转录第 8 条 |
| 17:46:55 | 收到「我没让你明天17:45来找我」→ **又命中 "17:45"+"明天"** → 建 checkpoint B（同一 dueAt）→ **note 再注入一次，同一句台词** | 转录第 9 条；plan 记录 B |
| 17:47:07 | 回复「…17:45那条我删了，你说啥时候你说了算。」← **幻觉动作 + 实际未删** | 转录第 12 条；plan 两条仍 pending |
| — | 若无人干预 | 明天 17:45 `SupervisionDispatcher.tick` 取到 **2 条** due，各自 enqueue → **两条独立主动消息**（prompt = 「用户之前约定在这个时间跟进『…』」，内容就是这两句抱怨） |

明天会发出的两条 prompt 原文（`supervision-plan.json` 的 `prompt` 字段）：

- `用户之前约定在这个时间跟进"我没让你明天 来找我 你有带脑子吗"。请结合最近对话自然地询问进展。`
- `用户之前约定在这个时间跟进"现在下午 了 怎么还刚醒啊 是你刚醒 脑子不清醒吧[敲打]"。请结合最近对话自然地询问进展。`

`SupervisionDispatcher`（`src/desktop/supervision-dispatcher.js:52-77,85-111`）对 `due()` 结果是**逐条 dispatch**，两条 canonical key 不同 → 不去重 → 两条消息。

---

## 4. 次要发现（同一时间窗内，独立缺陷，建议单独立项）

### 4.1 「会话被重置」——第一回合是全新会话

`sessions.json` 里同一 `senderId`（`o9cq80y1…@im.wechat`）存在 **4 个不同 accountId** 的 binding，本次实时回合用的是 `219e3e20e886-im.bot`（threadId `b4170132…`），而历史用户会话是 `71b17216…`（accountId `082e9f8aec81-im.bot`）。因为 bindingKey 含 accountId，换了 account 就等于**换了个全新记忆**。

**机制已由既有结论解释**（见 `.workbuddy/memory/PITFALLS.md` §13）：`accountId` 来自服务端 `ilink_bot_id`，**每次扫码都会新铸**（`login.js:220-221`）。
⇒ 因此这不是偶发漂移，而是 **必然**：**每次重新扫码登录 = 换 accountId = 换 bindingKey = `session/new` = 记忆清零**。

- 影响：产品北极星是"模型侧记忆永不清零、越来越懂用户"，但**扫码登录会静默清零**。本次的"刚醒"式空开场正是它的可见症状，也解释了为什么第 1 回合没有任何历史上下文可用。
- 与 §13 是同一根因的两个面：那边是"扫码会打死旧会话"，这边是"扫码会丢记忆"。

### 4.2 解析器 qualifier 取"第一个日期词"，会产出离谱时间

复现输入 `今天下午开会开到5点，累死了`：

```
-> dueAt 2026-09-22T21:00:00.000Z   （= 本地 2026-09-23 05:00）
   announcement「好，我记下了，明天05:00我来找你。（这条落在你的静默时段里，是你自己定的，我照发，不会跳过。）」
```

原因：`DAY_QUALIFIER` 用 `match()` 取**最先出现**的词，"今天"在"下午"之前 → 下午修正（`hour<12 → +12`）没触发 → hour 停在 5 → 过期回滚到次日 → **凌晨 5 点**，且因 `exemptQuietHours: true` 连静默时段都豁免。
⇒ 用户随口一句"今天下午开会开到5点"就可能换来明早 5 点的消息。

### 4.3 状态文件未提供"取消"通路

`SupervisionPlanStore` 有 `update/state`，但没有面向模型或用户的"取消这条跟进"入口；`reminder-queue.json` 是另一套系统（`cyberboss_reminder_create`），**与 checkpoint 不互通**。所以用户说"我没让你来找我"时，链路上没有任何一环能把它撤掉。

---

## 5. 影响面

| 维度 | 评估 |
|---|---|
| 用户可感知 | 高。被强制说一句用户明确否认过的承诺；且**明天会重复出现两次** |
| 可重复性 | 100%。纯确定性字符串解析，无随机性，无模型依赖 |
| 触发条件 | 用户消息中出现 `H:MM` / `H点`/`H点半` 等任意时间表达式 |
| 误伤面 | 不只"抱怨时间"，一切**陈述性提及时间**都会中招（"今天下午开会到5点"、"我8点起的"…） |
| 安全影响 | 明日 17:45 会产生 2 条主动消息；若叠加 §4.2，可能在**凌晨/静默时段**发消息 |
| 数据损坏 | 无。仅新增状态记录，未污染历史 |

---

## 6. 建议（本次未执行任何一项，待裁决）

按 收益/风险 排序：

1. **P0 — 台词不写死**：`app.js:832-838` 的 note 不应给出逐字台词。系统只应告知"已排定一条 X 时刻的跟进"，措辞交给模型，或至少禁止对**否认语境**注入。理由：写死台词把系统的解析错误直接变成用户的"AI 撒谎"体验。
2. **P0 — 加意图闸门**：`extractExplicitCheckpoint` 只在**具备约定语义**时生效（如出现 提醒我/叫我/来找我/监督我 等祈使词，或时间为将来时），纯陈述句只做记录不排跟进。
3. **P0 — 引用/否认语境排除**：消息中出现 `没让你|不用|别|取消|删掉` 等否定词时，不得新建跟进，且应视为对**同 dueAt 既有跟进**的撤销意图。
4. **P1 — 去重**：同一 `dueAt` 的多条 `conversation` checkpoint 应合成一条（现状会发两条）。
5. **P1 — §4.2 qualifier bug**：`DAY_QUALIFIER` 应取**时间表达式邻近**的修饰词，而非全文第一个日期词。
6. **P1 — 提供撤销通路**：给模型/用户一个真正能取消 pending checkpoint 的入口，避免"只能撒谎"。
7. **P2 — §4.1 账号漂移**：独立排查 accountId 变更为何导致 binding/thread 重置。

**立即可做的止血（需用户批准，本次未做）**：把 `supervision-plan.json` 里那两条 `pending` 改成 `skipped`（或删掉），即可阻止明天 17:45 的两条消息。

> ⚠️ 本节只覆盖"17:45 跟进"这一条链。**"更新/扫码后记忆清零"是另一组缺陷，方案见 §10**（用户追问后补写）。

---

## 7. 证据文件清单（均只读）

- `C:\Users\23159\.codebuddy\projects\d-cyberboss-dist-win-unpacked-resources\b4170132-9b58-4870-a352-9ed8200c3afa.jsonl` — 三段完整提示词与回复（含 note 原文）
- `C:\Users\23159\.cyberboss\supervision-plan.json` — 两条 pending checkpoint（317 条历史记录）
- `C:\Users\23159\.cyberboss\logs\bridge.jsonl` — 三段 `inbound.received` 与 `reply.prepared`
- `C:\Users\23159\.cyberboss\sessions.json` — 4 个 accountId binding
- 源码：`src/core/app.js:690,799-839`、`src/core/explicit-checkpoint.js:23-72,95-154`、`src/core/supervision-plan-store.js:25,52,68`、`src/desktop/supervision-dispatcher.js:52-111`、`src/tools/tool-host.js`

**未做**：未改任何源码；未改 `supervision-plan.json`；未重启 Aidy / bridge / runtime；未触碰 `dist/`。
**隐私**：本文档对用户原话做了省略处理；完整原文仅存于上述本机文件。

---

## 8. 用词闸门（按验收 Skill）

- 「系统排了一条 17:45 的跟进，并强制模型照读台词」→ **FIXED 级证据成立**（提示词原文 + 状态文件 + 本地复现三方一致）。
- 「模型编造已删除」→ **证据成立**（零 tool call + 无删除工具 + 状态仍 pending）。
- 「模型当时的内心判断」→ 仅 **hypothesis**，不作结论。

---

# 附录（同日追问后补）：为什么"更新后要重新扫码"，以及记忆为什么会清零

用户追问两点：① §6 里没有"防止扫码后记忆清零"的方案；② 最近几次换新包都要重新扫码，别的软件更新后能保住登录态。

## 9. 归因

### 9.1 凭据是持久的，更新不会删它

- `stateDir = CYBERBOSS_STATE_DIR || ~/.cyberboss`（`src/core/config.js:7`），**与构建产物路径无关**。账号文件 `~/.cyberboss/accounts/<accountId>.json` 因此跨构建保留（今天的重建后它一直在，直到 17:45 被新扫码顶掉）。
- 扫码**只由用户点「连接微信」触发**（`src/desktop/main.js:591` 的 IPC），应用里没有任何自动扫码逻辑。
- 桥接子进程也拿到了显式的稳定状态目录（`runtime-supervisor.js:341` `CYBERBOSS_STATE_DIR`）。

⇒ **"更新导致退出登录"不成立。** 真正发生的是：**"扫码"这个动作本身会把正在跑的桥接弄死，于是 UI 让你再扫一次。**

### 9.2 确证链条（2026-09-22 16:56–17:45，逐条可查）

| 时刻(本地) | 事件 | 证据 |
|---|---|---|
| 16:56:44 – 16:58:51 | poll-1 … poll-8 **全部 success**，同一 cursor `a965e592` | `bridge.jsonl` poll.result |
| 16:58:59 | **一次扫码完成**（凭据落盘）→ login-recovery 触发 | `desktop.jsonl` `wechat.login_recovery` |
| 16:59:09 | **poll-9 返回 `rpcCode: -14`** → `disconnected → process_exit → adapter_close` | `bridge.jsonl` poll.error |
| 16:59 – 17:21 | 桥接**没有退出**（该区间无 `bridge.exited`），即 §13 的"半死"形态 | 两份日志对照 |
| 17:21:22 | 用户手动关掉 Aidy（SIGTERM, intentional=true） | `desktop.jsonl` |
| 17:44:23 | 新包启动，桥接用**16:58 那张凭据**开始 poll-1 | `bridge.jsonl` poll.started |
| 17:45:02 | 用户在 poll-1 尚未返回前**又扫了一次**（新账号 `219e3e20e886` 落盘，旧账号被 `cleanupStaleAccountsForUserId` 删除） | `accounts/*.json` savedAt；`desktop.jsonl` |

**机制（五步，全部有代码或日志支撑）**

1. `createWeixinChannelAdapter` 把账号**进程级记忆化**：`src/adapters/channel/weixin/index.js:25-31` `ensureAccount()` 只在首次解析，之后永不重读磁盘。
2. 平台**在建立新会话时吊销旧会话**（§13 已记录）。
3. ⇒ 任何一次扫码，都会让**正在运行的那个桥接**手里握着一张已被吊销的票。
4. `src/core/app.js:441` 把 `-14` 当**致命错误**抛出（不走重试），桥接随即 `finally → releaseRuntimeResources()`。
5. `src/desktop/runtime-supervisor.js:415` 把 "-14 / session expired" 归类为 `WECHAT_SESSION_EXPIRED`，并在 `handleExit`（440-450 行）里判定为**阻塞性错误、故意不自动重启**；UI 文案即「微信登录已过期，需要重新扫码」。

⇒ **扫码 → 吊销 → 报"需要重新扫码" → 你再扫一次**，闭环。这就是"每次都要重扫"的观感来源。
唯一的出口是"完全退出 Aidy 再重开"：新进程启动时读的是**最新**那张凭据（这也解释了为什么这个土办法有效）。

**缓解措施已经在代码里，但有竞态。** `wechat-login-recovery.js` 应在扫码成功后调 `supervisor.retry()` 强制重生桥接，`runtime-supervisor.js:319-332` 也确实实现了（`forceBridgeRestart` + `plannedChildStops`）。

- **17:45 那次生效了**：旧桥接被 SIGTERM（17:45:02.121）→ 新桥接 17:45:12.301 启动 → ready 17:45:27。
- **16:58:59 那次没有生效**：`runtime.starting`(16:58:59.348) → `runtime.ready`(16:58:59.402) 只隔 **54 ms**，而一次真正的强制重生至少要 ~10 s（`stopChild(existing, 10_000)`），且该区间**没有任何 `bridge.spawn_spec`**。⇒ 那次 `retry()` 实质没有重启桥接，被吊销的凭据继续被轮询，10 s 后 `-14`。

> **归因边界（按验收 Skill 纪律）**：**"16:58 那次 `retry()` 为何没有重生桥接"尚未证实**（落盘日志里该次 respawn 毫无痕迹，微秒级交错无法复原）。记为 `INCIDENT_UNRESOLVED`，**不升级为根因**；值得单开一次带插桩的排查。
> 另一条**未被证据支持**的猜想（仅登记、不作为结论）：17:44 那次启动在 poll-1 尚未返回时用户就扫码了，说明**当次 UI 让用户扫码的理由，落盘日志里没有直接证据**。

### 9.3 为什么别的软件更新不掉登录，Aidy 会

| | 常规软件 | Aidy（iLink 机器人） |
|---|---|---|
| 凭据形态 | 长期 refresh token / session cookie | **按次铸造的机器人注册**（`ilink_bot_id` + `bot_token`） |
| 客户端重启 | 服务端**不**因此吊销 | 平台在**建立新会话**时吊销旧的 |
| 旧凭据兜底 | 通常保留，可回退 | **主动删除**：`login.js:98-114` `cleanupStaleAccountsForUserId` 在登录成功后删掉同 `userId` 的旧账号文件 |
| 更新影响 | 安装包只替换程序文件，与登录态正交 | 结构上同样正交（凭据在 `~/.cyberboss`，跨构建保留） |

⇒ 结论：**"要重扫码"不是更新造成的，是这套登录语义造成的**。更新只是让你又开机一次，于是又撞上这个环。

### 9.4 记忆为什么会清零 —— 两条独立机制，都有硬证据

**M1：身份换了，binding 就换了**

- `bindingKey = default:<accountId>:<senderId>`；`sessions.json` 里同一 `senderId`（`o9cq80y1…@im.wechat`）挂着 **4 个不同 accountId** 的 binding：`d810faa977fc`（8/21）、`97b10c7063a3`（9/8）、`082e9f8aec81`（9/21）、`219e3e20e886`（9/22）。
- 换 accountId ⇒ 新 binding ⇒ `hasPersistedSessionId:false` ⇒ `session/new`（今天 09:45:33 就是这样产生了 thread `b4170132`）。
- **旧 binding 与旧 thread 并没有被删，只是再也无人引用。**
- 修复可行性 —— **旧数据全在**：`sessions.json` 保留历史 binding；ACP 转录按 threadId 存放在 `~/.codebuddy/projects/…`，与 accountId 无关；而且 `71b17216` 这类旧 thread 今天仍在被 `session/resume` **成功恢复**（09:44:39 四连 resume）。⇒ **"搬家"可行，不需要重造。**

**M2：workspaceRoot 一变，转录就被劈开（更隐蔽）**

ACP 转录按「workspaceRoot 转义名」分目录。实测**同一个 threadId 同时存在于多个目录**：

| threadId | 目录 | 大小 / 时间 |
|---|---|---|
| `29929783-7427-452c-bd8f-f3204c261a83` | `d-CyberBoss-dist-win-unpacked-**new**-win-unpacked-resources` | 14 KB / 09-04 |
| 同上 | `d-CyberBoss-**local-dist**-win-unpacked-resources` | **0 字节** / 09-21 |
| 同上 | `d-cyberboss-dist-win-unpacked-resources` | **0 字节** / 09-22 |
| `ec01e9e1-4624-4465-8cec-2bd1782dd17d` | `d-CyberBoss-dist-win-unpacked-new-…` | 4.4 KB / 09-04 |
| 同上 | `d-cyberboss-dist-win-unpacked-resources` | 415 KB / 09-21 |

只要构建目录名换一次（历史上出现过 `dist-rebuild` / `local-dist` / `dist-win-unpacked-new`），同一个 thread 在新的 workspaceRoot 下就是**空转录**，模型看到的历史清零。
⇒ **构建目录名是记忆的一部分**，这一点和发布纪律强耦合：`dist/win-unpacked` 这个路径必须保持稳定。

## 10. 修复方案（新增，排在 §6 的第 1 项之前）

0. **P0｜`-14` 先比对凭据新鲜度，别急着喊"重新扫码"**（直接治闭环）：
   在 `app.js:441` 分类之前，比较 `accounts/*.json` 的 `savedAt` 与**当前桥接进程的启动时间**。若凭据比进程更新，说明这是"扫码吊销旧会话"，应走 `forceBridgeRestart` 自动换票，而不是把 `WECHAT_SESSION_EXPIRED` 丢给用户。
   同时把 `runtime-supervisor.js:330` 的 `stopChild(existing, 10_000)`（静默等 10 s）改成"SIGTERM → 2 s 后强杀"，缩短换票窗口 —— **现在这 10 s 恰好就是旧桥接拿到 `-14` 的窗口**。
1. **P0｜记忆与 accountId 解绑（迁移，而不是清零）**：
   登录成功后（`runLoginFlow` 末尾、紧邻 `cleanupStaleAccountsForUserId`）按 **`userId`（= senderId，跨扫码稳定）** 找到旧 binding，把 `threadIdByWorkspaceRootByRuntime` **继承**到新 accountId 的 binding 上，并记 `legacyAccountIds` 供审计。目标：换了马甲，人还是那个人。
2. **P0｜"先搬家，再删旧账号"**：`cleanupStaleAccountsForUserId` 目前登录后立即删旧账号。应改为**搬家成功后才删**，否则一旦搬家逻辑有 bug，凭据与数据一起没。
3. **P1｜固定 ACP workspaceRoot**：不要拿打包目录当 workspaceRoot（它随构建目录名漂移），或至少在迁移时把新 workspaceRoot 映射回同一份转录。（治 M2）
4. **P1｜`-14` 从"致命"降级为"可诊断"**：`app.js:441` 直接 throw 会让整个桥接进程走 shutdown；至少应先落盘 poll 元数据，并让 UI 区分"凭据被吊销"与"进程已死"。

> 说明：0/1/2 三项都落在**已存在的稳定路径**上（`~/.cyberboss`、`sessions.json`、`~/.codebuddy/projects`），不需要新的留存机制，也不需要周期性换会话 —— 与"模型侧记忆永不清零"的产品决策方向一致。
