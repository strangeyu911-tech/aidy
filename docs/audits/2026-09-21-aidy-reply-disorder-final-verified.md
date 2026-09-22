# aidy 回复乱序问题 · 代码+运行时日志双验证审计（最终版）

- **日期**：2026-09-21
- **审计对象**：18:23–18:24 微信对话（用户「hi」1 条 + aidy 3 条）
- **方法**：bridge.jsonl / desktop.jsonl / CodeBuddy 网关日志 / 会话历史 jsonl / 源码逐一核实。本文档修正同日早前 `2026-09-21-aidy-zhijiantime-reply-disorder.md` 中基于推测的两处结论（见 §6）。
- **性质**：只读审计，未修改任何对话内容与运行时数据。

---

## 1. 真实时间线（bridge.jsonl + 网关日志还原）

| 本地时间 | 事件 | 证据 |
|---|---|---|
| 17:37 | 随机查岗 checkpoint 到期，入队系统消息队列（id 前缀 `supervision:random:`） | supervision-plan.json：`completed/queued` |
| 17:39–18:00 | 该消息在旧构建下 **7 次派发失败**（`CODEBUDDY_START_TIMEOUT` → `reply.skipped(runtime_failed)`） | bridge.jsonl |
| 18:23:12 | 用户启动修复版（pid 21732，工作区 dist\win-unpacked\resources） | 网关日志 |
| 18:23:27 | **turn 1**：积压的查岗消息派发，channel=system，thread `5cac11a4`，附着已有会话发 `session/prompt` | 网关日志 |
| 18:23:47 | 用户「hi」到达（turn 1 的 prompt 已在 20 秒前生成） | bridge.jsonl `inbound.received` |
| 18:24:11 | **turn 2**：`hi` 应答，channel=weixin，thread `71b17216`，**先 `session/new` 新建会话**再发 prompt | 网关日志 |
| 18:24:11 / 18:24:26 | 两次发送成功：81 字符（turn 1 回复）、24 字符（turn 2 回复） | bridge.jsonl `sender.succeeded` |

## 2. 三条 aidy 消息的真实来源

| 对话中的消息 | 来源 | 长度 |
|---|---|---|
| M2「今天指尖时光里还是一个安排都没有」 | turn 1 模型回复的**前半段** | 16 字 |
| M3「现在就把今天要做的…回我一个具体时间点」 | turn 1 模型回复的**后半段** | 61 字 |
| M4「hi 呀，晚上好。都快六点半了…」 | turn 2（对「hi」的应答） | 24 字 |

**M2+M3 本是同一次模型回复（合计 81 字符，含换行）**，被微信发送器的分泡逻辑拆成两个气泡：`splitTextAtBoundaries` 以段落空行为边界、`DEFAULT_MIN_WEIXIN_CHUNK = 20`（config-store.js）——M2(16) < 20 无法独立成段、M3(62) ≥ 20，两者不合并 → 拆两泡。**用户感知的「连发三条」实为「两条回复 × 前者被拆泡」**。

## 3. 逐问题定位与根源归类（最终版）

### 问题 1｜用户初始消息被忽略的观感（M2/M3 先于「hi」被处理）
- 表现：用户觉得「hi」没被回应，先收到催办。
- 真相：turn 1 是 17:37 入队、18:23:27 派发的**主动消息**，先于 18:23:47 到达的「hi」。时序本身符合「主动触达」设计，但主动消息与用户消息在同一分钟挤在一起，观感上像乱序。
- 归类：**生成/派发时序问题（积压重放）**——本质是 17:39–18:00 的 7 次派发失败把主动消息推迟到了用户上线时刻。

### 问题 2｜重复回复/消息洪 fluorescent（M2+M3 两气泡）
- 归类：**生成逻辑正常，发送侧拆泡**。81 字回复按 20 字最小块规则拆分是既定行为；但拆出的第一泡只有 16 字独立成句，观感像两条刻意分开的消息。属于体验问题而非缺陷级异常。

### 问题 3｜M4「上下文记忆丢失」（重新打招呼）——**主根因确认**
- 铁证（会话历史 `71b17216-….jsonl`）：turn 2 的会话是 18:24:11 **新建**的（网关日志 `session/new`），第一条消息是人格指令（WECHAT SESSION INSTRUCTIONS），第二条才是「hi」。会话内**没有** turn 1 的任何痕迹。
- 机制（sessions.json threadScopes）：会话线程按**运行时身份指纹/channel 分 scope**——turn 1 走 system 通道（thread 5cac11a4），turn 2 走 weixin 通道（thread 71b17216）。两个 scope 天然不共享历史；且 weixin scope 在本次重启后的首个用户回合新建了线程。
- 归类：**上下文记忆丢失（架构级：主动消息与用户应答分属不同会话 scope）**。

### 问题 4｜语气跳变（监督命令式 M3 → 闲聊关怀式 M4）
- 真相：不是同一会话的人格漂移，而是**两份不同的系统指令**：turn 1 的 prompt 是 SYSTEM ACTION MODE + 「firm」催办指令；turn 2 是完整的陪伴人格长指令。各自都忠实执行了自己的 prompt。
- 归类：**上下文记忆丢失的连带症状**。

### 问题 5｜M4 不知道 M3 刚立下的「回时间点」待办
- 同问题 3。turn 2 会话里既无 M2/M3 文本，也无 zhijiantime 状态注入。
- 归类：**上下文记忆丢失（跨 scope）**。

### 问题 6｜（新发现，修正早前审计）zhijiantime 上下文块重复注入 6 次
- 铁证（`5cac11a4-….jsonl` turn 1 prompt 全文）：同一段 `[Zhijiantime daily supervision — verified data] … zero schedules and zero todos … awaiting_commitment` 块**出现 6 次**。
- 机制推断：17:39–18:00 的每次派发失败/重新入队都对该消息做了一次富化追加，`daily-supervisor.js` 的 `enrichSystemMessage` 未做幂等去重。
- 影响：本次未直接改变回复内容（模型仍按指令输出），但属明确缺陷，且与 M2/M3 内容的高度模板化相关。
- 归类：**生成逻辑异常（富化非幂等）**。

### 数据真实性核查
- M2「一个安排都没有」**不是幻觉**：prompt 注入的是 verified data（`readDay` 成功，状态文件 `zhijiantime-daily-supervision.json` 存在且 state=awaiting_commitment）。早前「状态文件不存在、读取失败」的判断系 find 命令误报，已纠正。

## 4. 根源汇总

| 根源类别 | 问题 | 证据强度 |
|---|---|---|
| 上下文记忆丢失（会话 scope 分裂，架构级） | 问题 3、4、5 | 强（session/new + 双 threadId + 会话历史原文） |
| 生成逻辑异常（富化非幂等 ×6） | 问题 6 | 强（prompt 原文） |
| 派发时序（积压重放撞上用户上线） | 问题 1 | 强（bridge.jsonl 失败重试链） |
| 发送侧拆泡（既定行为，体验问题） | 问题 2 | 强（分泡常量与边界规则） |

## 5. 修复方向

1. **统一会话 scope 或跨 scope 注入历史**：用户 weixin 回合的 prompt 应携带同线程近期主动消息摘要（至少含当天已发的系统消息文本），消除「重新打招呼」。
2. **富化幂等**：`enrichSystemMessage` 对同一 systemMessageId 只追加一次 zhijiantime 块；重试路径复用已富化内容。
3. **积压重放限流**：重启后对积压系统消息做合并（同一 `daily_plan:<date>` key 只发一条），避免与用户消息挤在同一窗口。
4. **拆泡阈值复核**：16 字独立成泡的观感问题，可考虑提高 `DEFAULT_MIN_WEIXIN_CHUNK` 或对主动消息禁用拆泡。

## 6. 对早前审计文档的修正

| 早前结论（2026-09-21-aidy-zhijiantime-reply-disorder.md） | 本审计核实结果 |
|---|---|
| 推测「两段几乎相同的 zhijiantime 上下文」 | 实为 **6 段**（每次重试各追加一段） |
| 推测「readDay 每次抛错、注入的是读取失败上下文」 | 错误。读取成功，注入 verified data；状态文件存在（247 字节） |
| 「主动消息与对话回复不共享上下文」（方向正确） | 精确化为：**system/weixin 双通道会话 scope 分裂 + turn 2 新建线程** |
