# aidy 监督链路补充审计：两份 09-21 审计的盲区与新发现

- **日期**：2026-09-21（21:40）
- **性质**：只读审计。在前两份文档（`2026-09-21-aidy-zhijiantime-reply-disorder.md`、`2026-09-21-aidy-reply-disorder-final-verified.md`）基础上，全量重读监督链路源码后的查漏补缺。**未修改任何代码、对话与运行时数据。**
- **方法**：逐条复核前两份文档的结论是否仍被当前代码支持；对未被覆盖的链路（重试入队内容、承诺捕获、冷却、静默时段现状）做独立核查。

---

## 一、对前两份文档的核对结论

### 仍然成立（代码核实无误）
| 结论 | 证据 |
|---|---|
| 富化非幂等，同一消息上下文块被重复注入 | `app.js:1496-1504` enrich 发生在每次 dispatch；重试路径见下文 N1 |
| system / weixin 双通道会话 scope 分裂是 M4「重新打招呼」的根因 | ~~代码级根因可钉死：`system-message-dispatcher.js:30` `threadKey: "system:${senderId}"`，与用户回合的 weixin threadKey 分属不同 scope~~ 🔴 **2026-09-22 勘误：结论成立、证据与机制作废。** `threadKey` 全仓 0 处读取（死字段）；真机制是 `app.js` `buildSystemRuntimeBindingKey()` → `<bindingKey>::system` 后缀。详见 `2026-09-22-route-a-scope-merge.md` §3.1/§3.2 |
| 派发时序：积压重放撞上用户上线 | `bridge.jsonl` 7 次失败链（final-verified 已用运行时日志证实） |
| 拆泡规则导致 81 字回复变两泡 | 既定行为，非缺陷级异常 |
| 模板无时刻语义（18:30 催「现在去规划今天」） | `daily-supervisor.js:293-329` 两个模板均不接收 `now` |

### 已被代码推翻 / 过时（**不要按这些去修**）
1. **首份文档 E8「静默时段硬编码 23:00–07:00、只保护部分来源」——已过时。** 当前 `supervision-policy.js:7-11` 静默时段可配置、默认保护**所有**来源；有 `exemptQuietHours` 显式豁免（用户自己定的时间照发，`:80-82`）；静默时段内非 random 的 checkpoint **延迟到窗口结束**而非丢弃（`:59-75`）；有过期宽限 6h（`:19, :47-51`）。09-18 产品审计的 P1-2 修复已落地。
2. **首份文档 E4/E5「去重闸门缺口导致两条催办模板同时出泡」——机制已不存在。** 队列层 `coalesceSystemMessages`（`system-message-queue-store.js:162-206`）按 identity（account+sender+workspace+taskType+supervisionKey）合并；random 与 zhijiantime 都映射 `daily_plan:<date>` 且 taskType 同为 `supervision` → **入队即合并**（新者胜，priority 取大）。`daily-supervisor.js:70-75` 的闸门如今只是第二道防线。本次事故的双泡是单回复拆泡（final-verified 已修正）。
3. **首份文档 P0「重积压重放需新增限流」——部分已存在。** 指数退避 5s/30s/120s/600s + 3 次失败熔断 2 分钟（`app.js:77-79, 2215-2236`）已有；缺的是**次数上限**（见 N3）。

---

## 二、新发现（两份文档均未覆盖）

### N1（P0）重试入队的是「富化后文本」，队列文件随失败次数变长
- **机制**：`dispatchPreparedTurn` 失败 → `scheduleSystemMessageRetry(prepared.systemMessage, …)`（`app.js:930-931` 启动失败路径；`:2093-2096` turn.failed 路径）。而 `prepared.systemMessage = { …message }` 存的是 **enrich 之后的副本**（`system-message-dispatcher.js:39`）。重试入队的是已带 `[Zhijiantime …]` 块的文本；下一次 dispatch 时 `enrichSystemMessage` **再追加一段**。
- **后果**：① 本次事故的「6 段重复」每失败一次 +1 段，7 次重试 ≈ 2–4k 无用 token/次派发，持续烧模型额度；② 队列 JSON 里的文本无限变长（`normalizeSystemMessage` 不清洗历史块）；③ 若块内数据前后不一致（用户中途填了计划），模型同时看到新旧两份「verified data」。
- final-verified 的修复建议 2（富化幂等）方向正确，但落点要加一个：**重试入队时剥离旧的 `[Zhijiantime …]` 块**，或按 `message.id` 记 enriched 标记、同 id 不重复追加。

### N2（P0）承诺捕获无意图门槛：随口一句话会被当成「计划承诺」
- **机制**：`captureSupervisionArrangement`（`app.js:729-769`）对每条用户消息执行。state=`awaiting_commitment` 时 `capturePlanningCommitment`（`daily-supervisor.js:92-134`）直接调 `extractExplicitCheckpoint(text)`，而该解析器**没有任何意图门槛**（`explicit-checkpoint.js:23-72`）：任何 "8点 / 21:00 / 40分钟后" 都命中。
- **后果链**：用户随口说「我晚上8点要吃饭」→ ① 误建 daily-planning checkpoint；② systemNote（`app.js:739-745`）要求模型自然带出**写死的**「好，今天 20:00 我会检查你有没有在指尖时光做好计划」——自信确认一件用户没答应的事（conversation 路径的 announcement 会复述解析标题、误解析可见；planning 路径的 announcement 固定，误解析不可见）；③ state 被写成 `followup_scheduled` → **随机查岗被 `:70-75` 闸门抑制到那个时间点**——用户随口一句话让监督系统闭嘴数小时。
- **修复**：`capturePlanningCommitment` 在捕获前要求消息含计划类意图词（指尖时光/计划/安排/填…），或对解析结果做二次确认（「你是想让我 X 点来核对你的指尖时光计划吗？」确认后再落库）。

### N3（P1）监督消息重试无次数上限，非静默时段消息永不过期
- `PROACTIVE_RETRY_DELAYS_MS` 封顶 600s 后 `Math.min(attempt-1, 3)` 无限重试（`app.js:2219`）；`isStaleTimeSensitiveSystemMessage`（`supervision-policy.js:152-175`）只对 **dueAt 落在静默时段**且超 6h 宽限的消息判过期。17:37 这类普通时段的消息**永不失效**。
- 运行时长期损坏（如本次 CODEBUDDY 吊死未修复）→ 一条监督消息无限重试数天，每次重启后积压重放——正是本次事故的放大器。
- **修复**：supervision 消息加 `maxAttempts`（如 8 次，超则 `archived`），或加全局 staleness（dueAt 超 24h 归档）。

### N4（P1）空计划日 = 无限催办循环，冷却字段无人读
- state=`awaiting_commitment` 时 `:70-75` 闸门不拦 random → **每一次随机查岗（默认 3–60 分钟一次）都触发一次「去做计划」催办**。模板自己写了 "If this was asked before, use different wording"（`daily-supervisor.js:300`）——预期了重复，但没有冷却。
- `markPrompted()` 写的 `lastPromptAt`（`:216-220`）**全仓库没有任何读者**。按 09-18 审计实测（18 天 266 条 random ≈ 15 次/天），空计划日最多可被催 15+ 次——对 ADHD 用户这是关通知级别的 spam。
- **修复**：读 `lastPromptAt` 做冷却（如 3 小时内不重复催计划），或同日催办 ≥3 次后转「只静默记录、不再开口」。

### N5（P1）planning_followup 在「派发前」就烧毁承诺状态
- `enrichSystemMessage` `:60-69`：kind=`planning_followup` 且当日为空时，**在派发之前**就把 state 从 `followup_scheduled` 覆写为 `awaiting_commitment` 并清空 `followupDueAt`/`checkpointId`。
- 若该次派发失败（如本次超时），重试时 state 已是 `awaiting_commitment` → `:70-75` 对 random 失效 → **随机查岗立刻恢复催办**。用户刚答应的「21:00 来核对」契约在派发失败那一刻就被单方面作废，且无任何记录。
- **修复**：该状态迁移移到「turn.completed（delivered）」之后执行；失败路径保持 `followup_scheduled` 原状重试。

### N6（P2）拆泡规则与监督文案形态冲突（结构性，非边角）
- M2(16 字)+M3(61 字) 被拆两泡不是偶然：监督文案天然是「状态句 + 空行 + 指令句」两段式，而拆泡以段落空行为边界、最小块 20 字 → **主动监督消息几乎必然以两泡呈现**。final-verified 提了阈值复核，这里补充：更优解是对 `taskType==="supervision"` 的消息在文案侧压成单段（换行改句号），或监督消息禁用拆泡。

---

## 三、修复优先级汇总

| 优先级 | 项 | 落点 | 预期收益 |
|---|---|---|---|
| P0 | 重试剥离旧上下文块 / 富化幂等 | `app.js` `scheduleSystemMessageRetry`、`daily-supervisor.js appendInternalContext` | 消除 token 浪费与数据矛盾 |
| P0 | 承诺捕获加意图门槛 | `daily-supervisor.js capturePlanningCommitment` / `app.js:737` | 消除误承诺 + 误抑制查岗 |
| P1 | supervision 消息 maxAttempts / 全局过期 | `app.js:2215-2236`、`supervision-policy.js` | 坏运行时不再无限重放 |
| P1 | 催办冷却（读 lastPromptAt） | `daily-supervisor.js:70-75, 216-220` | 空计划日不再 spam |
| P1 | 承诺状态迁移改到 delivered 之后 | `app.js:2097-2099` + `daily-supervisor.js:60-69` | 派发失败不烧毁契约 |
| P2 | 监督消息拆泡策略 | 微信发送器 `splitTextAtBoundaries` / config-store | 两泡观感消失 |
| P2 | weixin 回合注入「今日已发主动消息摘要」 | `app.js enrichIncomingMessage…` | M4 类「重新打招呼」兜底缓解（根治仍需统一 scope，见 final-verified 修复 1） |

> 只读结论，未执行任何修改，未触碰 `dist/` 与其它打包路径。
