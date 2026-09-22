# 微信重新扫码后不生效 —— 恢复回边缺失（Aidy）

- **日期**：2026-09-21
- **分支 / HEAD**：`main` @ `c5a40ba9168572532199a0ff84a047d4fa3abb35`（2026-09-21 01:05:08 +0800，`fix(desktop): stop the hero card claiming WeChat is connected without a heartbeat`）
- **工作树**：干净（仅 `scripts/upload-release-chunked.js` 未跟踪）
- **结论等级**：**根因已在源码层面认定（代码证据 + 日志时间线一致）；恢复动作尚未执行，故非 `FIXED`**
- **一句话**：扫码成功后，桌面端只保存了新 token 并更新了登录面板，**没有任何代码去重启 bridge、也没有把 supervisor 从 `phase="error"` 拉回**，于是新凭证永远不会被轮询循环使用。

---

## 1. 证据行（source / package / launched / observed 分离）

| 行 | 证据 |
| --- | --- |
| **source** | HEAD `c5a40ba`，工作树干净 |
| **package** | `D:\CyberBoss-local-dist\win-unpacked\`（`app.asar` mtime `2026-09-21T01:26:52`，size 133438018）<br>`D:\CyberBoss\dist\win-unpacked\`（`app.asar` mtime `2026-09-21T01:28:31`，size 133438018） |
| **同源性** | 两个 `app.asar` 的 MD5 均为 `8fb787a24cbcd6a67a9a35e6ba284839`；两个 `Aidy.exe` 的 MD5 均为 `445d30f4e933a15237f815eb47a0bb2e` → **同一份构建产物**，故"点哪个包"与本次故障无关 |
| **launched** | 主进程 PID 12076（15:08:13 启动）+ 子进程 876 / 21656 / 9616 / 29256，`ExecutablePath` 全部为 `D:\CyberBoss-local-dist\win-unpacked\Aidy.exe` |
| **launch surface** | 开始菜单 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Aidy.lnk` → `D:\CyberBoss\dist\win-unpacked\Aidy.exe`（**与正在运行的 local-dist 路径不一致，但产物哈希相同，属隐患而非本次病根**） |
| **observed** | `wechat-activity.json`：`lastSuccessAt: null`、`lastOutcome: "failure"`、`lastErrorClass: "unknown"` |

---

## 2. 时间线（本机时间 UTC+8）

| 时刻 | 事件 | 证据 |
| --- | --- | --- |
| 09-08 00:34 | 最后一次成功的微信轮询 | `bridge.jsonl` 末条 `"outcome":"success"`，`2026-09-08T16:34:49.949Z` |
| 09-20 22:38 | 首次出现 `rpcCode: -14` | `bridge.jsonl:5939` |
| **09-21 15:08:13** | Aidy 主进程启动 | 进程 `CreationDate` |
| **09-21 15:08:17** | bridge 子进程 29256 启动，`bridge loop started` | `desktop.jsonl` `bridge.spawned` |
| **09-21 15:08:41.638** | `poll.error`，`rpcCode: -14`，`consecutiveFailures: 1` | `bridge.jsonl` 最后一行 |
| 09-21 15:08:41.7 | ACP transport `disconnected → process_exit → adapter_close` | `bridge.jsonl` |
| **09-21 15:08:41 之后** | **`bridge.jsonl` 再无任何新行（至今 34 分钟）** | 文件 mtime `15:08`，而 `integrations.jsonl` 每 5 分钟仍在写（末条 `15:38`）→ 主进程活着，轮询循环已停 |
| **09-21 15:14:23** | 用户扫码，新凭证落盘 `accounts/082e9f8aec81-im.bot.json`（`token` 长度 58，结构完整） | 文件 mtime + `savedAt` |
| 09-21 15:41 | 复检：仍无新轮询记录 | — |

> 关键时序：**bridge 死于 15:08:41，用户扫码在 15:14:23 —— 晚于死亡 5 分 42 秒。**

---

## 3. 根因链（逐点对应源码）

1. `src/core/app.js:226` — bridge 启动时 `resolveAccount()` 解析账号；**token 只在此刻读入内存一次**。
2. `src/core/app.js:290+` — 轮询 `while` 循环全程使用这个内存中的 `account`，**循环内不重新读取账号文件**。
3. `src/core/app.js:432` — 轮询收到 `rpcCode -14` → `isSessionExpiredError()` 为真 → **`throw`**，直接跳出整个 `while` 循环，**bridge 主循环终止**。
   （这正是"日志停在 15:08:41"的原因：循环已经退出，不再产生 `poll.started`。）
4. `src/desktop/runtime-supervisor.js:403-404` — supervisor 从 bridge 输出中匹配 `errcode[=:\s-]+-14` → 记下 `WECHAT_SESSION_EXPIRED`（"微信登录已过期，需要重新扫码。"）。
5. `src/desktop/runtime-supervisor.js:436-441` + `:614` — bridge 退出时，因该 code 属于 `BLOCKING_WECHAT_CODES`，supervisor **有意不自动重启**，改把 `phase = "error"`（设计意图正确：重启无法修复登录态，只会烧熔断器并掩盖真因）。
6. `src/desktop/main.js:579` — 用户点「连接微信」→ `weixinLoginRunner.start()`。
7. `src/desktop/weixin-login-runner.js:142-159` — 扫码成功后 `runLoginFlow` 返回，runner **只做两件事**：把登录面板置为 `status:"connected"/"微信已连接。"`，以及（在 login flow 内部）写入新 token 到 `accounts/*.json`。**没有任何一处调用 `supervisor.retry()` / `supervisor.start()`，也没有清除 `phase="error"`。**
8. `src/desktop/connection-diagnostics.js:82-99` — 快照渲染时 `phase` 仍是 `"error"` → 连接状态卡片继续输出 `state:"error"`、`label:"连接异常"`、`detail:"微信连接已过期。"`。
9. `src/desktop/renderer/connection-status-view.js:49-50` — 该诊断的 `nextAction` 是 `wechat_login` → **UI 只渲染「连接微信」按钮，不渲染「重试启动」**。

### 用户被困的死循环

```
点「连接微信」→ 扫码成功 → 新 token 落盘（15:14）
        ↓
bridge 早在 15:08 就已抛错退出，无人用新 token 重新轮询
        ↓
phase 仍为 "error" → UI 仍显示「连接异常」
        ↓
UI 只给「连接微信」按钮 → 用户再点、再扫、再无效
```

**这解释了全部三个现象**：微信侧"扫码成功"、Aidy 前端"配置失败"、发消息连"对方正在输入"都没有（根本不存在 poller，"正在输入"由 bridge 在处理入站消息时触发）。

---

## 4. 立即恢复动作（需用户执行 GUI）

**完全退出 Aidy 后重新启动**（不是关窗口——关窗口只会缩进托盘继续运行）：

1. 托盘图标右键 → 退出（或任务管理器结束 `Aidy.exe` 全部 5 个进程）。
2. 重新从开始菜单启动。

重启后 bridge 会重新走 `resolveAccount()`，读取 15:14 落盘的新 token。`desktop-state.json` 的 `desiredState` 为 `running`，故 `main.js:185` 会自动 `supervisor.start()`。

> 预期：若新 token 有效，`bridge.jsonl` 会出现 `"outcome":"success"` 的 `poll.result`。
> 若仍报 `-14`，则说明 15:14 这次扫码产出的凭证本身不可用，需要重新扫码。

---

## 5. 修复建议与实施状态

### 实施记录（2026-09-21 16:40）

| 项 | 状态 |
| --- | --- |
| **P0** 扫码成功 → 恢复后台 | ✅ 已实施：新增 `src/desktop/wechat-login-recovery.js`（`createWechatLoginRecovery`），`main.js` 把 `weixinLoginRunner` 的 `onUpdate` 接到它上面。扫码成功（status 由非 `connected` → `connected`）转成**恰好一次** `supervisor.retry()`。 |
| **P1** UI 在可自修错误下同时给「重试启动」 | ✅ 已实施：`connection-status-view.js` 的 `resolveErrorView` 新增 `secondaryAction/secondaryLabel`；`renderer.js` 渲染并绑定 `#error-secondary-button`；`styles.css` 增 `.error-actions`。 |
| **P2** bridge 循环内热重载账号 | ⬜ 未做。P0 已覆盖用户实际路径（UI 扫码），热重载属纵深防御。 |
| **P3** 统一启动面 | ✅ 已消除：`CyberBoss-local-dist` 已删除，`dist/win-unpacked` 成为唯一产物，开始菜单指向它。 |

**为什么 `retry()` 是对的入口**：它清空熔断器 `restartTimes`、清 `lastError`、把 `phase` 置回 `stopped` 再 `start()`；而 `start()` 的守卫只排除 `["starting","running","quiet"]`，**`error` 不在其中** —— 因此能从本次事故的 `phase="error"` 正确恢复。

**出包与验证**（2026-09-21）
- `electron-builder --win nsis` → `BUILD_EXIT=0`，0 个 safe-delete 报错。
- 新 `app.asar` sha256 `4808FE027D584ACD3113C93C12EB6AC5FEF3AFC45640CFB67FA9B005E7CB54E0`（133442336 B）；特征串 `createWechatLoginRecovery`×4、`error-secondary-button`×2，**旧包全为 0**。
- 全量测试 **708 / 707 pass / 0 fail / 1 skip**（基线 699，新增 9 条）。
- 三条闸门：`verify:release-names`=0、`verify:artifacts`=0（`packaged=true`）、`verify:desktop-boot`=0（`heartbeatUntouched=true`）。
- 便携版经 `build-portable.js --prepackaged` 重建（exit=0），`win-unpacked` 未受影响。

**尚未取得的证据**：新包尚未由用户启动并完成一次真实微信收发。因此本轮结论停留在
`source fixed + packaged verified by automation`，**不构成 `ACCEPTANCE PASS`**；真实入站消息的验收仍待执行。

---

## 5b. 原修复建议（保留原文）

**P0 — 补上"扫码成功 → 恢复后台"的回边。**
在 `WeixinLoginRunner.run()` 成功分支（`weixin-login-runner.js:149`）之后，或在 `main.js` 的 `onUpdate` 里监听 `status === "connected"`，触发一次 supervisor 恢复：清除 blocking error → `phase` 回到 `starting` → 重新 spawn bridge。这样用户扫码后无需重启整个应用，也不必手动找「重试启动」。

**P1 — UI 在 `phase="error"` 且失败码可被用户操作修复时，同时给出「重试启动」。**
现在 `connection-status-view.js` 是二选一（`wechat_login` **或** `retry`），导致"扫完码只能再扫码"。至少应在重新扫码成功后暴露一次 restart 入口。

**P2 — bridge 循环内支持热重载账号。**
`app.js:226` 的"只读一次"是当前架构的前提假设；若在 `isSessionExpiredError` 分支里改为「重新 `resolveAccount()`，token 变了就继续循环而不是 `throw`」，bridge 就能自愈，不依赖桌面端回调。

**P3 — 启动面漂移。**
开始菜单指向 `D:\CyberBoss\dist\win-unpacked`，实际运行在 `D:\CyberBoss-local-dist\win-unpacked`。本次两者哈希相同故无害，但将来只更新其一就会造成"用户点的"与"实际跑的"不是同一份。建议统一，或让验收路径明确固定为其中一个。

---

## 6. 证据边界

- **已证实（代码 + 日志一致）**：bridge 因 `-14` 退出且不再轮询；扫码后无任何代码重启 bridge；`phase` 停留 `error`；UI 只给「连接微信」按钮。
- **未验证**：15:14 落盘的新 token 是否本身有效（需重启后由真实轮询判定）。
- **未确定**：`-14` 的初始触发原因（09-08 ~ 09-20 之间的会话失效过程）。09-20 22:38 之前的日志未做进一步溯源，本次不做推断。
- **不构成**：包陈旧（哈希已证明同源且晚于 HEAD）、多账号冲突（`accounts/` 仅一个账号文件）、网络层故障（`poll.error` 的 `httpStatus` 为 200，`address`/`errno` 均为空，是应用层 `rpcCode` 而非传输错误）。
