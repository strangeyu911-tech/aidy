# Aidy 审计整改状态（对应 `2026-09-18-aidy-product-audit.md`）

审计原文保持为当日快照不改写；整改过程与证据记录在本文件。

**结论**：11 / 14 项已整改并验证；3 项未做，原因见文末「仍未完成」。
**基线**：`126e1a2`（审计文档）→ `cb909d3`（核心调度与工程卫生）→ `090f874`（桌面端与微信可见性）。
**回归证据**：`090f874` 上 `node --test "test/**/*.test.js"` → `# tests 623 / # pass 622 / # fail 0 / # cancelled 0 / # skipped 1`（唯一 skip 是既有的 DPAPI opt-in 集成测试，需 `CYBERBOSS_TEST_REAL_DPAPI=1`）。`npm run check` 与 `npm run verify:acceptance-skill` 均通过。
整改前同一条命令为 `612 / 588 pass / 15 fail`（其中 8 条是被静默取消而非运行失败）。

---

## 逐条状态

| 编号 | 结论 | 证据 / 说明 |
| --- | --- | --- |
| P0-1 桌面无核心功能入口 | ✅ | `main.js` 新增 `desktop:create-checkpoint` / `desktop:run-checkin` / `desktop:set-checkin-config`；面板加输入框 + 4 个快捷时间 + 「立即查岗一次」 |
| P1-1 微信端全英文 | ✅ | `app.js` 所有 `sendText`、`command-registry.js` 帮助、审批提示、错误文案、思考状态行全部中文化；`formatThreadStatus()` 翻译内部英文状态词 |
| P1-2 静默时段硬编码且覆盖不全 | ✅ | `quietHours` 可配置（默认 23:00–07:00）并入 `updateSettings` 白名单；`resolveDueCheckpointAction` 改为对非 random 来源 `defer` 到窗口结束（原为 `archive`）；超 6h 宽限判 stale |
| P1-3 随机查岗默认过密且只读 | ✅ | 三档预设（默认「标准」15–45）+ 自定义区间；桌面可切换；`/checkin` 支持档位名、中文标签、前缀与别名 |
| P1-4 微信掉线无可见提示 | ⚠️ 部分 | 见下节。核心链路（会话过期 / 未登录 / 多账号）已可达且带「连接微信」按钮；心跳与「上次活动时间」未做 |
| P2-1 入站无 owner 校验 | ✅ | `message-utils.js` 归一化阶段丢弃非 owner 消息 + 脱敏日志；`config.js` 新增 `ownerUserId`；`test/inbound-owner.test.js` |
| P2-2 计划只增不删 + 每秒全量读盘 | ✅ | `AtomicJsonStore` mtime+size 读缓存；`SupervisionPlanStore.prune()`；`test/atomic-json-store.test.js` |
| P2-3 队列非原子写 | ✅ | `system-message-queue-store.js` 改 tmp+rename；`test/system-message-queue-store.test.js` |
| P2-4 备份依赖 PATH 上的 `tar.exe` | ✅ | `resolveTarExecutable()` 优先 System32 bsdtar + `probeTarCapability()`；`test/backup-service.test.js` 已适配 |
| P2-5 TurnGate 无超时 | ✅ | TTL 默认 10 分钟 + `expireStale`；`test/turn-gate-store.test.js` |
| P2-6 打包产物落后于源码 | ❌ 未做 | 需要重新出包并记录 hash，属发布动作，见文末 |
| P3-1 `/help` 只列开发者命令 | ✅ | 分层：默认用户档，`/help all` 出开发者档 |
| P3-2 监管计划面板语义误导 | ✅ | 空态改文案 + 随机查岗状态脚注 + 全局摘要（档位/区间/静默/今日次数） |
| P3-3 连接微信弹黑窗跑 npm | ⚠️ 仅图标 | 品牌图标已从「CB」换成 Aidy 猫头 SVG；登录窗口未产品化 |

---

## P1-4 为什么是「部分完成」

审计建议 4 条，落地 1 条，另 3 条未做：

1. **接上 `WECHAT_SESSION_EXPIRED` 的 emit（已做）**。`runtime-supervisor.js` 的 `handleOutput` 新增识别分支；`app.js:371` 抛出的错误改为携带 `code: "WECHAT_SESSION_EXPIRED"`，并删掉了 `Run \`npm run login\` again.` 这句用户无法执行的开发者提示。

   排查中发现**只加识别分支并不生效**，原因值得记下来：`app.js:249` 在 poll 循环**之前**就打印 `[cyberboss] bridge loop started`，而会话过期是在 poll 循环里抛出的。于是 `waitForBridgeReady` 早已返回 true、`startBridge` 正常返回，那个被捕获的错误**永远不会被抛出**，而是随 child 从 `this.children` 删除一起消失，最终收敛到通用的 `RESTART_CIRCUIT_OPEN`。因此补了 `handleExit`：对 `WECHAT_LOGIN_REQUIRED` / `WECHAT_ACCOUNT_SELECTION_REQUIRED` / `WECHAT_SESSION_EXPIRED` 三类「只能由用户解决」的错误，置 `phase:"error"`、写 `lastError` 并**停止重启**（重启对这三类无效，只会白烧熔断器）。`test/wechat-session-expiry.test.js` 按真实时序（ready → 报错 → exit）覆盖三种情况，并加了一条回归护栏：无 `__cyberbossError` 的普通崩溃仍照旧重启。
2. **「最后一次成功收发消息」时间戳 + 超时横幅（未做）**。现有 poll 诊断（`poll-observability.js` 的 `startedAt`/`endedAt`）只经 `logRuntimeDiagnostic` 写瞬时日志，不是可查询的持久化存储；要展示需 app.js 在成功 poll 时写一个节流的持久化时间戳并经 snapshot 暴露。这是**唯一能覆盖「轮询还活着但什么都没送到」这类静默失效**的手段，建议排下一批。
3. **bridge 心跳（未做）**。目前仍只在子进程 `exit` 时才有反应。
4. **轮询超时不伪装成空结果（未做）**。`api.js:231` 超时仍返回 `{ret:0, msgs:[]}` 伪成功（只在 `attachPollMeta` 里标了 `outcome:"timeout"`），因此**持续超时不会累加 `consecutiveFailures`**，表现为「一直没反应」而不是报错。日志层有痕迹，桌面层没有。

---

## 审计未列、整改中发现的 3 个真 bug

1. **`exemptQuietHours` 没有持久化**。`explicit-checkpoint.js:65` 与 `main.js` 都会设置该标记，但 `supervision-plan-store.js` 的 `normalizeCheckpoint` 在构造返回对象时把它丢掉了 → 用户在微信里明确指定的深夜提醒会被静默 defer 到早上 7 点。已补字段，并用「重新打开 store 实例」的真磁盘往返测试锁住。同时修正判定顺序：**stale 检查优先于豁免**，否则笔记本睡一周再打开会补发一批过期提醒。
2. **`saveSettings()` 用未水合的 DOM 覆盖持久化状态**（`renderer.js`）。它把整个设置对象一次性写回，却绑定在 6 个控件上；只要在首次 snapshot 渲染完成前动过任何一项，HTML 里未勾选的复选框默认值就会被写进 `desktop-state.json` → **`reportEnabled` 被静默改成 false**（代码默认值是 `true`）。这与「6 天没写日记」对得上：`report-scheduler.js:47` 见 `reportEnabled=false` 直接 return。已加 `settingsHydrated` 守卫。另一半原因是本机桌面端自 **2026-09-10** 之后未再运行（`~/.cyberboss` 下多数文件 mtime 停在 9-10 15:11）。
3. **`vision-fallback.js` 的硬超时定时器被 `unref()`**。unref 的定时器在它是事件循环唯一待办时永远不会触发，于是 8 条测试被 node:test 判为 `cancelledByParent`——**是静默取消，不是失败**，所以此前一直被当成「环境噪声」。已在干净 HEAD 的 worktree 上复现同样结果（`pass 2 / cancelled 8`）确认是既有问题。去掉 unref（`cleanup()` 本来就在 `finally` 里 `clearTimeout`）后 10/10 通过。

另：`codebuddy-managed-serve.test.js` 那条失败属**测试自污染**——它断言 `CODEBUDDY_GATEWAY_PASSWORD` 不在子进程 env 里，但宿主会透传 `process.env`，而沙箱 shell 本身带着该变量（`src/` 全仓库不引用这个变量名，应用没有设置它）。已让该测试在自身作用域内临时清除并还原。

---

## 仍未完成

1. **P2-6 重新出包**。`dist/` 与 `dist-release-v0.1.0/` 仍是 09-04 的产物，不含本轮及 9-08 的改动；且 `dist-release-v0.1.0/` 里是旧品牌的 `CyberBoss-Setup-v0.1.0.exe`，而 INSTALL.md 要求 `Aidy-Setup-v0.1.0.exe`。属发布动作，需确认后再执行并记录新 hash。
2. **P3-3 登录窗口产品化**。当前「连接微信」仍 spawn `cmd /d /k npm.cmd run login` 黑窗（`main.js:519-531`）。注意登录流程本身要把二维码打进终端，所以真正的产品化是**把二维码渲染进 Electron 窗口**（`qrcode-terminal` 已在依赖里），不是换个命令。鉴于 P1-4 的恢复路径就是「点连接微信重新扫码」，这项的收益比审计时更高。
3. **P1-4 的 2/3/4 条**（活动时间戳 + 心跳 + 不伪装超时），见上节。
