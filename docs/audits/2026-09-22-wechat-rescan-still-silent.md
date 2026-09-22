# 2026-09-22 — 扫码"连上了"但收不到消息：重扫恢复为何仍然失效

> 触发：用户在开始菜单打开 Aidy → 点「连接微信」扫码 → UI 显示已连接、通道正常
> → 发微信**看不到"对方正在输入"，也收不到回复**。
>
> 结论：**这是新包（`dist/win-unpacked`，16:56:25 启动），不是旧包**；
> `d738413` 引入的重扫恢复（`wechat-login-recovery`）**确实触发了**，
> 但被三个缺陷叠加抵消，最终表现为"通道显示健康、实际零轮询"。
> 修复：commit `eec4eae`（4 文件 / +224 −11 / 4 个新测试）。

---

## 1. 现场时间线（全部来自 `~/.cyberboss/logs/*.jsonl` 与进程快照）

| 时刻 (本地) | 事件 | 证据 |
|---|---|---|
| 16:56:25 | Aidy 启动，**就是新包** | `PID=30800 "D:\CyberBoss\dist\win-unpacked\Aidy.exe"` |
| 16:56:26 | bridge 子进程 spawn | `PID=24104`；`owned-processes.json` 记 `startedAt 08:56:26.158Z` |
| 16:56:44 | `runtime.ready`（冷启动完成，**耗时 18.0s**） | `desktop.jsonl 08:56:44.222Z` |
| 16:57:02 → 16:58:51 | poll-1…7 全部 `rpcSuccess:true` | `bridge.jsonl`；`wechat-activity.json` `lastOutcome:"success"` |
| **16:58:59.337** | **扫码成功，写入新 token** | `accounts/276dae995d29-im.bot.json` → `savedAt 08:58:59.337Z` |
| 16:58:59.348 | `runtime.starting` | `desktop.jsonl` |
| **16:58:59.402** | **`runtime.ready`（距上一条仅 54ms）** | 冷启动是 18.0s → **说明没有真正重启** |
| 16:58:59.421 | `wechat.login_recovery` | `previousStatus:"confirmed"` → 恢复钩子**确实跑了** |
| 16:59:09.654 | poll-8 仍 `rpcSuccess:true` | 旧 token 此刻还有效 |
| **16:59:09.783** | **poll-9 `poll.error` `rpcCode:-14`（124ms 快速失败）** | 见 §2 缺陷 1 |
| 16:59:09.794/834/838 | transport `disconnected` → `process_exit` → `adapter_close` | 见 §2 缺陷 2 |
| 16:59:09.839 | **`bridge.jsonl` 最后一行** | 之后再无任何写入 |
| 17:01:26 | `integrations.jsonl` 仍在写 | 桌面进程正常，停的只是 bridge |

### 停摆形态（关键判据）

- `PID 24104` **仍存活**，但 CPU 三次采样冻结在 `2.094s`、工作集冻结 `94.3MB`；
- **零 TCP 连接**，只有一条 `State:2 / 0.0.0.0:0` = **LISTEN 套接字**；
- `bridge.jsonl` 停写，`desktop.jsonl` 无 `bridge.exited`。

→ 这不是"卡死"，是**活干完了但进程退不出去**，被自己没关的监听端口吊住。

---

## 2. 三个缺陷（均为代码可验证）

### 缺陷 1 — `retry()` 无法重启还活着的 bridge

```js
// src/desktop/runtime-supervisor.js:319（历史遗留，非 d738413 引入）
const existing = this.children.get("bridge");
if (existing && existing.exitCode == null) return;   // ← 桥接活着就直接返回
```

```js
// src/adapters/channel/weixin/index.js:25
function ensureAccount() {
  if (!selectedAccount) { selectedAccount = resolveSelectedAccount(config); }  // ← 进程级记忆化
  return selectedAccount;
}
```

```js
// retry() 只置 phase 再调 start()，从不停止已有桥接
async retry() { this.restartTimes = []; this.phase = "stopped"; this.lastError = null; await this.start(); }
```

三者相乘：扫码写新 token → **平台随后吊销旧会话** → 恢复钩子调 `retry()` →
`startBridge` 早退（没有 `bridge.spawned`）→ `probeProfile()` 对着旧桥接探活竟然通过（54ms）→
**新 token 从未被读取**，旧桥接继续用已吊销的凭据轮询 → 10.3s 后 `-14`。

> 反直觉之处：**是"重新扫码"这个动作把原本正常的连接打死的**。polls 1-8 用扫码前的 token 全部成功，
> 而扫码建立新会话时平台会吊销旧会话。所以"连上"的瞬间，正在跑的桥接手里的凭据已经死了。

### 缺陷 2 — `WECHAT_SESSION_EXPIRED` 抛出后进程不退出

```js
// src/core/app.js:445（修复前）
if (isSessionExpiredError(error)) {
  throw Object.assign(new Error("...微信登录已过期..."), { code: "WECHAT_SESSION_EXPIRED" });
}
```

抛出 → 走 `finally` 清理。但**同一份清理清单在文件里存在两份拷贝，且已漂移**：

| 路径 | 是否关 `bridgeControlServer` |
|---|---|
| `createShutdownController` 闭包（`app.js:267`） | ✅ 有 |
| `finally`（`app.js:453`，即致命路径） | ❌ **没有** |

没关掉 HTTP 控制服务 → 监听套接字吊住事件循环。再叠加：

```js
// bin/cyberboss.js:8（修复前）
process.exitCode = 1;   // ← 只设退出码，不能终止"事件循环仍被占用"的进程
```

→ 进程永久存活。这就是 §1 里"CPU 冻结 + LISTEN 长挂"的来源。

### 缺陷 3 — supervisor 永远不知道，UI 因此说谎

`handleExit()` 依赖子进程的 **`exit` 事件**才会走到 `blockingWechatError` 分支
（把 `phase` 置 `error` 并给出「微信登录已过期，需要重新扫码」）。进程不退出 → 事件不来 →
`phase` 停在 `running` → **前端显示"已连接 / 通道正常"，实际零轮询**。这正是用户看到的现象。

---

## 3. 修复内容（`eec4eae`）

| 文件 | 改动 |
|---|---|
| `src/desktop/runtime-supervisor.js` | 新增一次性 `forceBridgeRestart`；`startBridge` 在强制模式下**停掉旧桥接再 spawn**，并记入 `plannedChildStops` 防止 `handleExit` 误判为崩溃；`retry()` 置位并在 `finally` 清除 |
| `src/core/app.js` | 抽出唯一一份 `releaseRuntimeResources()`，两条退出路径共用（结构上杜绝再次漂移） |
| `bin/cyberboss.js` | 保留 `exitCode`，另加 3s 宽限后 `process.exit(1)` 的 `unref` 看门狗 |
| `test/wechat-session-expiry.test.js` | +4 用例：retry 必换桥接 / 计划内停止不算崩溃重启 / 普通 start 仍复用健康桥接 / 释放逻辑必关控制服务 |

**测试：732 total / 731 pass / 0 fail / 1 skip**（基线 728，正好 +4）。
**未做**：新包重建（用户在 `dist\win-unpacked` 有实例在跑，文件被锁，必须用户先退出 Aidy）。

---

## 4. 决定性验证：新 token 是好的，而且服务端压着 3 条未投递消息

在桥接**已停摆（无并发轮询）**的窗口内，用磁盘上的新 token 打了一次真实 `ilink/bot/getupdates`：

```
accountId 276dae995d29-im.bot   tokenSavedAt 2026-09-22T08:58:59.337Z
httpStatus 200   ret null   errcode null   msgCount 3   cursorReturned 104 chars   738 ms
```

⇒ **凭据完全可用**，`-14` 是旧 token 的、不是新 token 的。并且**服务端积压了 3 条从未投递的更新**
（就是用户那几条没人回的消息）⇒ **用户重启 Aidy 后微信即可恢复**，这是被验证过的结论，不是推测。

### ⚠️ 一个我必须记录的副作用（我的假设错了）

我原本判断"`get_updates_buf` 是客户端持有的游标，探针不写回就不会丢消息"。**错。**
连续第二次同形状探针返回 `pendingUpdates 0 / cursorReturnedChars 0` ⇒
**服务端按 token 跟踪投递状态，每次被接受的轮询都会推进游标** ⇒
**第一次探针把那 3 条积压消费掉了**，重启的桥接再也拿不到它们。
影响可控（那些消息本来就是用户在故障期发的测试消息，用户手机上仍看得到自己发出的那侧，Aidy 只是从未看到），
但结论必须更正：**该探针不是只读操作**。
已固化为 `scripts/diagnose-wechat-token.js`，并在文件头用醒目段落写明"会消费积压"。
诊断"token 是否已死"这类场景下积压本来就已不可投递，代价可接受；**但要先知道有这个代价**。

### 副产品：为什么 `sync-buffers/` 里有三个孤儿的账号游标

`login.js:220-221`：

```js
const account = saveWeixinAccount(config, result.accountId, result);
cleanupStaleAccountsForUserId(config, account);   // 删掉同 userId 的其它账号文件
```

`accountId` 来自服务端的 `ilink_bot_id` —— **每次扫码都会铸出一个新 bot id**，
而 `cleanupStaleAccountsForUserId` 会把同 `userId` 的旧账号文件删掉。
所以 `sync-buffers/` 里的 `d810faa977fc`(08-25)、`97b10c7063a3`(09-08)、`082e9f8aec81`(09-21)
= **用户过去三次扫码各自留下的孤儿游标**，当前账号 `276dae995d29` 则**没有任何游标文件**。
这也把 `-14` 的时机解释到位了：扫码铸出新 bot id → 旧会话被吊销 → 仍在跑（且已记忆化）的桥接随即 `-14`。

---

## 5. 重新打包与验收证据（2026-09-22 17:24–17:32）

前置：`git status` 干净、无 Aidy/cyberboss 进程、`dist/win-unpacked/Aidy.exe` 未被锁。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 0 | `mv dist/win-unpacked → D:/cyberboss-old-build-20260922/win-unpacked-prev` | 把删除换成重命名，删除预算恒为 0 |
| 1 | `cli.js --win nsis` | **exit 0**，无 safe-delete 报错 |
| 2 | `build-portable.js --prepackaged dist/win-unpacked` | **exit 0** |
| 3 | `sync-start-menu-shortcut.ps1` | `Target=dist\win-unpacked\Aidy.exe`，StartIn/Icon 正确 |

产物：`Aidy-Setup-v0.1.0.exe` 127,083,236 B @17:25:52｜`Aidy-0.1.0-x64.exe` 103,673,138 B @17:28:56。

### asar 字节级内容校验（全绿）

`forceBridgeRestart`=4、`this.forceBridgeRestart = true`=1、`plannedChildStops.add("bridge")`=3、
`releaseRuntimeResources`=3、`await this.bridgeControlServer?.close?.()`=1、
`A fatal error must still end the process`=1、`createWechatLoginRecovery`=4、`systemTurn`=11；
**旧清理代码 `shutdown.dispose(); this.clearPendingImageInboundTimers();` = 0 ⇒ 旧代码确已被替换**。
asar `sha256=74AA9950F8F9FB521CCB529E003FA3D8CAAF3EDCAB1B35EDB68DADE3CFF2E428`、bytes=133,465,303（上一版 133,462,648）——
与 `verify:release-names` 独立算出的哈希完全一致。

> ⚠️ 一个差点误判的标记坑：我用 `buildSystemRuntimeBindingKey` 当"Route A 仍在"的标记，得 count=0。
> 真相是**该函数就是被 `2251ee3` 删掉的**（`git show 2251ee3` 可见 `-function buildSystemRuntimeBindingKey`），
> 它的缺席才是正确状态。**标记必须取自"修复后应存在"的符号，不能用已被修复删除的旧符号。**

### 三道闸门：1 绿 / 2 与 3 **无法运行**（不是回归）

- `verify:release-names` ✅ exit 0（`[release-check] ok`）
- `verify:artifacts` ❌ 启动打包 app 时 `FATAL: GPU process isn't usable. Goodbye.`
- `verify:desktop-boot` ❌ 同样的 GPU 崩溃

穷尽排查后才下结论：Bash 沙箱内 ❌ → PowerShell 工具 ❌ → `dangerouslyDisableSandbox` ❌ →
10 种 Chromium 参数组合全 ❌（`--disable-gpu` / `--no-sandbox` / `--disable-gpu-sandbox` / `--in-process-gpu` /
`--single-process` / `--disable-gpu-compositing` / `--disable-software-rasterizer` /
`--disable-gpu-process-crash-limit` / `--disable-gpu-watchdog` / `--use-angle=swiftshader`）。
⇒ **本执行环境拿不到 GPU/显示会话**（与 `PITFALLS §3` 一致）。
⚠️ 本项目早前记录过闸门二/三 exit 0，**现在无法复现**，原因未查明 ⇒ **不许拿"过去绿过"当现在的证据**。

**结论（严格按验收契约）**：闸门 2/3 未运行 ⇒ **不宣告打包验收通过**。
已验证：闸门一、asar 字节级内容、全量测试（732/731 pass/0 fail/1 skip）、快捷方式目标。
**待用户完成**：双击开始菜单的 Aidy，确认能启动、能收回微信消息 —— 这才是本次修复的真实链路验收。

**回滚包**：`D:/cyberboss-old-build-20260922/win-unpacked-prev`（496 MB）**故意保留**，待用户确认新包可用后再删。

## 6. 方法论沉淀

1. **"进程还活着" ≠ "进程还在工作"。** 本轮靠 **CPU 增量 + TCP 状态 + 日志 mtime** 三件套
   把"卡死"与"干完不退"区分开：CPU 冻结 + `State:2` LISTEN + 日志停写 = 活干完了被句柄吊住。
2. **重复的清理清单是定时炸弹。** 同一份资源释放写两遍，迟早有一遍漏。改成单一方法是被动防御。
3. **`process.exitCode = N` 不是"退出"。** 事件循环仍被占用时它只是一张空头支票；
   致命路径必须有强制退出兜底，否则子进程的生死无法传达到父进程的 supervisor。
4. **功能的"触发"与"生效"要分开验证。** `wechat.login_recovery` 日志证明钩子**跑了**，
   但 `runtime.starting→ready` 只有 54ms（vs 冷启动 18s）证明它**什么也没做成**。
   只看前者会得出"新功能正常工作"的错误结论。
5. **别把"只读探针"当成理所当然。** 我对 `get_updates_buf` 的语义做了未经验证的假设，
   结果消费掉了用户的积压消息。**对外部协议的副作用要先证伪再断言**（本轮是第二次踩同类坑，
   第一次是 `latin1` 搜索得假 count=0）。
6. **同一份日志里的时间差是最便宜的判据。** `runtime.starting` 与 `runtime.ready` 相隔 54ms
   对比 18s，一个数字就证明"没有真的重启"，胜过读十遍 `retry()` 源码。

