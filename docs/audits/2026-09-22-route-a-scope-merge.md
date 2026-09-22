# 主动触达 × 用户回合错乱：A2 缓解 + 路线 A 根治（实施记录）

- **日期**：2026-09-22
- **上游计划**：`docs/audits/2026-09-22-Kimi-K2.8-plan-v2.md`（v2.1，第 3 步 = A2；§3 路线 A 两条配套）
- **裁决**：用户确认「先做 A2，完成后再走路线 A 根治」，并要求新代码必须落到包与开始菜单快捷方式。
- **提交**：`0ca2bba`（A2 缓解）、`2251ee3`（路线 A 根治）；重建轮另含 `01e41da`（codebuddy 传输层与权限模式）、`d738413`（微信重扫码恢复）、`ae046a1`（分块上传脚本）、`52a7b0d`（审计文档入库）
- **性质**：已执行，含打包。**真实微信链路未验证**（见 §6）。

---

## 1. 做了什么

### 第 1 步｜A2：把「已发出的主动消息」告诉用户回合（`0ca2bba`）

| 落点 | 变化 |
|---|---|
| `src/core/proactive-delivery-log.js`（新） | 记录**模型最终送达文本**（不是队列原文）；同文 10 分钟内去重；写入时按 3 天保留期裁剪；生成摘要时限 6 条 / 700 字 / 单条 160 字 |
| `src/core/internal-context-blocks.js`（新） | **剥离实现唯一**（K7）：`stripInternalContextBlocks` 供第 1/4/7 步共用 |
| `src/core/stream-delivery.js` | 新增 `onSystemReplyDelivered`，**只在 provider 接受消息后**触发；`deferSystemReply` 路径不算送达 |
| `src/core/app.js` | `enrichIncomingMessageWithZhijiantimeFreshRead` 末尾串联 `injectProactiveDeliveryDigest`；`provider === "system"` 与空文本跳过 |
| `src/core/config.js` | `proactiveDeliveryLogFile` = `<stateDir>/proactive-delivery-log.json` |

**注入文本形态**（刻意避开 `[Zhijiantime` / `[CyberBoss supervision note]` 前缀，A1 断言要求）：

```
===== 本日已发出的主动消息（系统记录，非用户发言）=====
下面是你今天已经通过微信主动发给该用户的消息，用户已经看过了。
不要把本轮当成初次接触，不要重复、也不要重新宣布下面已经说过的内容；顺着已有进展往下说。
- 20:00 指尖时光今天还是空的，先把计划做一下
```

### 第 2 步｜路线 A：主动回合与用户回合共用一个会话（`2251ee3`）

**关键修正：RC1 的机制不是 `threadKey`。** 全仓搜索确认 `threadKey`
（`system-message-dispatcher.js:30`、`weixin/message-utils.js:47`）**没有任何读取方**，
是死字段。真正的 scope 分裂是 `app.js` 里的一行：

```js
const runtimeBindingKey = prepared.provider === "system"
  ? buildSystemRuntimeBindingKey(bindingKey)   // → "<bindingKey>::system"
  : bindingKey;
```

`::system` 后缀在 session store 里造出**独立的 binding → 独立 threadId → 独立 ACP 会话**，
所以用户回合永远看不到主动回合的历史。路线 A = 去掉这个后缀，并补三处配套：

1. **`systemTurn` 显式传递**（`metadata.systemTurn`）→ `codebuddy/runtime-adapter.js`
   的 `resetOrdinarySessionAfterTimeout` 用它替代 `endsWith("::system")` 推断。
   **没有这一步会出大事故**：主动回合的非终态超时会把用户共享的会话清掉，
   下一次用户回合直接 `session/new`，**丢历史**。旧后缀判断保留作为存量 binding 的兜底。
2. **延迟回复前缀改为惰性取用**（`stream-delivery.js` 的 `adoptBindingDeferredPrefix`）。
   原先在 `attachReplyTarget` 阶段取用；那时主动回合有独立 binding key 所以互不干扰，
   共享之后主动回合会**吞掉**本该拼给用户回复的「期间模型主动联系」批次 —— 而该批次
   在设置前缀时**已从 store 中 drain 掉**，吞掉即永久丢失。
3. **触发文本改日志体**（`system-message-dispatcher.js`）。共享转录之后这段文本会被
   每个后续回合回读，命令体框架既是每轮成本也是风格带偏源。JSON 动作契约不变；
   已核对 `buildActionRequest` 解析结果与新框架**逐字节等价**
   （`requiresEvidence: true`、`requestedTargets: ["00]"]`，两者由单测钉住 —— 注意
   `markdown` 里的 `mark` 本来就命中变更动词正则，这是**原有行为**，不是本次引入）。

## 2. 证据

> **重建轮次（2026-09-22 14:35–14:52）**：先在 4 个提交里记录既有改动，再重打包。
> 下表 `app.asar` 的值与重建前**逐字节一致**，这证明提交只是**记录**了已进包的内容。

| 项 | 结果 |
|---|---|
| 全量单测 | `728 tests / 727 pass / 0 fail / 1 skip`（基线 711，本次 +17） |
| `verify:release-names` | `[release-check] ok` exit=0，`app.asar sha256=870F51EE4329209D3BD0F9B90F02B2265C6CD428D44022EB2A9F685626D61C2F` bytes=133462648 mtime=2026-09-22T06:48:03Z |
| `verify:artifacts` | `packaged=true` exit=0，`packagedExe=D:\CyberBoss\dist\win-unpacked\Aidy.exe`，`packagedResourceEntries=6263` |
| `verify:desktop-boot` | `[desktop-smoke] ok` exit=0，`heartbeatUntouched=true` |
| 产物（重建后） | `dist/Aidy-Setup-v0.1.0.exe`（127,082,402 B, 06:39:57）、`dist/Aidy-0.1.0-x64.exe`（103,675,158 B, 06:50:38）、`dist/win-unpacked`（80 文件） |
| 开始菜单 | `%APPDATA%\…\Start Menu\Programs\Aidy.lnk` → `D:\CyberBoss\dist\win-unpacked\Aidy.exe`，StartIn 同目录，Icon `…Aidy.exe,0`；脚本自带 `$verify` 校验 exit=0 |
| 包内容（新代码在不在） | 字节级搜索：`系统查岗（你自己的主动触达回合`=1、`本日已发出的主动消息`=1、`不要把本轮当成初次接触`=1、`onSystemReplyDelivered`=6、`proactiveDeliveryLog`=7、`createWechatLoginRecovery`=4、`--permission-mode`=3、`httpStatusFailure`=3 |
| 包内容（旧代码走了没） | `SYSTEM ACTION MODE: internal trigger`=0、`Do any timeline/diary/reminder/whereabouts work`=0、`No markdown fences`=0 |
| 并发/残留 | 构建前后 `Aidy.exe`/`electron.exe`/`electron-builder`/`signtool`/`7za` 残留计数均为 **0**；未并发 electron-builder；旧产物 `mv` 到 `D:/cyberboss-old-build-20260922/` 后单独删除 |

**过程中踩到并修复的一处真实故障**：第一次裸跑 `build-portable.js`（未加 `--prepackaged`）时，它与 NSIS 共用
`appOutDir=dist/win-unpacked`，需要 `emptyDir` 掉 68 个文件 → 撞 safe-delete 的 50 次预算
（`SAFE_DELETE_BULK_CONFIRM_REQUIRED count:68`）→ exit 1，**且把 NSIS 刚产出的 `win-unpacked` 清成了残骸（`app.asar` 消失）**。
处置：`mv` 走残骸 → 让便携版从「不存在的目录」开始重跑（删除次数变为 0）→ 成功。
正解已写入 `.workbuddy/memory/PITFALLS.md` §2.1（NSIS 先建、portable 用 `--prepackaged` 复用）。

**两处方法论错误也已记录**：① 用 `buf.toString('latin1')` 搜中文字符串得到**假的 count=0**，差点误判「新代码没进包」
（实际 UTF-8 字节存在，须用 `Buffer.from(needle,'utf8')` 做字节级搜索）；② `win-unpacked` 的 81→80 文件差异是
`resources/app-update.yml` —— `nsis` 产出而 `portable` 不产，且本仓库 `build.publish=null` 且 src 零引用 `autoUpdater`，
属**无读者的遗留死文件**，缺失无害。

**唯一一处 `SYSTEM ACTION MODE` 命中来自 `src/core/system-message-dispatcher.js:51` 的注释**
（说明旧框架为何被替换），不是运行时代码。为不让刚冻结的产物失效，该注释保留未改。

## 3. 结论分级（按验收技能口径）

- **已证明**：源码修复 + 打包已完成，包内含新逻辑、不含旧触发框架；三道闸门与开始菜单同步均过。
- **未证明**：真实微信链路上的「不再重新打招呼」。需要一次真实验收（§6）。
- **因此措辞**：`automated tests pass, packaged build updated, real-chain unverified`。
  **不得**称 `FIXED` / `ACCEPTANCE PASS`。

## 3.1 为什么四轮评审都没有发现机制写错（事后复盘）

RC1 从 09-21 首份审计到 09-22 计划 v2，被四个独立信源（首份审计、K2.8 plan v1、v1 review、
v2 review）**逐轮引用并确认**，却始终是错的。根因不是「审得不够认真」，而是四处**方法论缺陷**：

| # | 缺陷 | 具体表现 |
|---|---|---|
| 1 | **字段名当成了机制** | `threadKey: "system:<senderId>"` 字面写着「system」前缀，读者把它当成作用域凭证。实际上 `normalizePreparedMessage` 没有白名单，多余的键被原样透传、然后被静默丢弃。**字段存在 ≠ 字段被读**。 |
| 2 | **亲验标记被误读** | RC1 那行写着 `亲验 ✅`。核对的其实是**下游现象**（threadId 71b17216 ≠ 5cac11a4 —— 这是真的），但**从未核对「谁把两套 threadId 写进同一个 store」**。现象亲验 ≠ 机制亲验。 |
| 3 | **代码搜索从未执行** | 全仓 `threadKey` 只有 2 处、都是写入。这条只需一次 `grep -rn` 就能推翻，但四轮都停在「读这两行代码」，没人反向去问「谁读它」。 |
| 4 | **确认偏误** | 后续每一轮都引用前一版结论（plan v1 引首份审计 → v1 review 引 plan v1 → v2 review 引 v1 review），**链条越长越像事实**。复用「已核实的根因清单」时把上一轮的推断当作输入事实。 |

**反例（本次是怎么抓到的）**：不是靠更仔细地读代码，而是靠**消费真实数据** ——
读 `~/.cyberboss/sessions.json` 时直接看到 `bindingKey` 尾部带 `::system`
（`…@im.wechat::system`）。数据里出现了一个代码搜索里找不到的东西，才把注意力从 `threadKey`
转到 `bindingKey`。**教训：静态符号搜索与运行时数据对账，缺一不可。**
（相关纪律已补入 `PITFALLS.md` §11。）

## 3.2 机制写错对两条落地路线的影响：A2 无损，路线 A 方向对但论证错

| | 结论 | 依据 |
|---|---|---|
| **A2** | **完全不受影响，不需要返工** | 它操作的是 `proactive-delivery-log`（实际送达文本）与用户回合的入站富化，**既不读 `threadKey` 也不读 `bindingKey`**。根因名字写错不影响它的正确性。 |
| **路线 A 的**「去后缀」修正 | **方向正确，效果不变** | 计划里虽然把 「threadKey 对齐」 的名字叫错了，但**要动的那处代码是同一行**（`app.js` 里由 `prepared.provider === "system"` 驱动的分支）。去掉 `::system` 与「让两边 threadKey 相同」达到的是同一个可观测结果。 |
| **路线 A 的**`systemTurn` 配套 | **必须做，事后看必要性更高** | 计划没预见到这个风险。而在修复后的代码里，`endsWith("::system")` 对**新**主动回合恒为 false → 若不显式传 `systemTurn`，一次主动回合的非终态超时会 `clearThreadIdForWorkspace` 清掉用户共享会话 → **用户下一回合丢历史**。这是「按错误机制推理、但恰好需要、且必须补对」的一环。 |
| 新增的 **deferred 前缀惰性取用** | 计划缺项 | 同上：独立 binding 时代无碍，共享后才暴露（主动回合会吞掉已 drain 的延误批次 → 永久丢失）。 |

**结论**：机制写错**没有造成返工**，因为 A2 与绑定解耦、路线 A 的改动点与错误论证恰好落在同一行；
但它**掩盖了两个必须补的中毒点**（`systemTurn`、deferred 惰性取用），这两处是靠**先把机制搞对**才发现的
（见 §1 第 2 步 1./2.）。若照错误机制直接改，会引入「用户回合莫名丢历史」与「延误回复永久丢失」两个新 bug。

## 4. 已知边界与遗留

1. **路线 A 配套之三「定期换本会话」— 已由用户裁决取消，不再是遗留项**（2026-09-22 14:20）。
   原设计：每 1–2 周主动 `session/new` 并在首条 prompt 放「搬家摘要」，把「永久污染」变为「周期性清零」。

   **否决理由（产品级，非技术级）**：用户要的产品形态就是「**模型侧记忆永不清零，这样它才能越来越懂用户**」。
   周期性换会话会主动摧毁这一点 —— 换句话说，本条的代价分析一开始就建立在错误的取舍前提上：
   把「转录里累积日志体行」当成必须清除的污染，而用户根本不认为那是污染。

   **连带结论**：既然不换会话，为写「搬家摘要」而需要的「入站用户消息本地留存」也随之取消 →
   **新增的隐私面不存在了**。这正是「不做那个功能，就不用保护那个功能」。

   **⚠️ 更正本文件先前的表述**：原文写「Aidy 侧不持有用户对话转录（历史在 runtime），要写摘要必须先落地本地留存」——
   **不准确**。转录**就在本机磁盘上、明文可读**：
   `~/.codebuddy/projects/d-codebuddy-dist-win-unpacked-resources/`
   下有 `71b17216-….jsonl`（78,553 B，用户回合会话）与 `5cac11a4-….jsonl`（43,242 B，主动回合会话，13 行明文 JSONL）。
   Aidy 只是**不读**它，不是读不到。⇒ 将来真要做「搬家摘要」，**直接读这份 jsonl 即可，无需新建任何留存**。

   **唯一真实风险随之从「隐私」变为「上下文窗口上限」**：共享会话会越长越大，某个时刻运行时会被迫压缩或失败。
   codebuddy 侧的压缩策略**尚未查证**，是本条真正需要跟进的技术问题。
   （隐私 / ACL 的完整结论见 `.workbuddy/memory/PITFALLS.md` §12。）
2. **延迟后补发的主动消息未进日志**：只有 `system_reply` 真正送达才记录；走
   `deferredSystemReplyQueue` 后被拼进用户回复的那批不计入。占比小，已在代码注释中知悉。
3. ~~工作区里存在本次未提交的既有改动，它们被打进了这个包……若现在把它们 commit，会把新鲜度基准推到构建之后 → 三个产物立刻判 stale，故未提交。~~
   **已解决（2026-09-22 14:35）**：这批改动已按主题拆成 4 个提交入库
   （`01e41da` codebuddy 传输层与权限模式 / `d738413` 微信重扫码恢复 / `ae046a1` 分块上传脚本 / `52a7b0d` 11 份审计文档），
   随后按「先 commit、再打包」重打了包。原顾虑的成因是**顺序错了**（先构建、后考虑提交），
   正确顺序下新鲜度基准天然落在构建之前 —— 这是我上一轮给出的判断错误，记录在此以免重犯。
4. 存量 `<bindingKey>::system` binding 会留在 `sessions.json` 里成为孤儿（无害，未清理运行时数据；因「定期换会话」已取消，清理它的必要性进一步降低）。

## 5. 复现/复查手法

```bash
node --test "test/**/*.test.js"
node ./scripts/check-release-artifacts.js
node ./scripts/verify-api-first-artifacts.js
node ./scripts/desktop-smoke.js
# 判定某份构建含不含某修复：直接数 asar 里的字符串
grep -a -o "本日已发出的主动消息" dist/win-unpacked/resources/app.asar | wc -l
```

## 6. 真实验收（待用户执行）

自动化不能替代真实链路。请在**退出旧 Aidy、从开始菜单重新启动**后做一次：

1. 启动 Aidy（`Aidy.exe` 必须是 `dist/win-unpacked/` 下这一份）。
2. 等一条主动触达落地（或直接用微信发一句触发主动查岗）。
3. **主动消息发出后**，在微信里回一句普通消息，观察模型是否**不再**对同一件事重新打招呼、
   是否顺着已有进展说话。
4. 复查 `~/.cyberboss/logs/bridge.jsonl` 有无 `rpcCode`.

> 本文件只记录实施与证据，不修改任何历史审计文档。
