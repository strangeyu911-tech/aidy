# Aidy 审计整改状态（对应 `2026-09-18-aidy-product-audit.md`）

审计原文保持为当日快照不改写；整改过程与证据记录在本文件。

**结论**：**14 / 14 项已整改并验证**，含重新出包。
**提交链**：`126e1a2`（审计文档）→ `cb909d3`（核心调度与工程卫生）→ `090f874`（桌面端与微信可见性）→ `5cdb430`（状态文档）→ `41ab774`（通道心跳）→ `e1db73d`（登录窗口 + 通道告警）→ `b85d973`（发布闸门 + 真启动冒烟）→ `faa1876`（品牌图标）→ `402351a`（发布门禁两处）→ `9ae83ac`（门禁三处修正）→ `cc3f08f`（托盘图标）。
**回归证据**：`node --test "test/**/*.test.js"` → `# tests 690 / # pass 689 / # fail 0 / # cancelled 0 / # skipped 1`（唯一 skip 是既有的 DPAPI opt-in 集成测试，需 `CYBERBOSS_TEST_REAL_DPAPI=1`）。
整改前同一条命令为 `612 / 588 pass / 15 fail`（其中 8 条是被静默取消而非运行失败）。

**发布校验链（最终产物上全部通过）**

| 命令 | 结果 |
| --- | --- |
| `npm run verify:release-names` | RC=0 |
| `npm run verify:artifacts` | RC=0，`packagedStateReopened=true` |
| `npm run verify:desktop-boot` | RC=0，`exit=0`、`heartbeatUntouched=true` |

---

## 逐条状态

| 编号 | 结论 | 证据 / 说明 |
| --- | --- | --- |
| P0-1 桌面无核心功能入口 | ✅ | `main.js` 新增 `desktop:create-checkpoint` / `desktop:run-checkin` / `desktop:set-checkin-config`；面板加输入框 + 4 个快捷时间 + 「立即查岗一次」 |
| P1-1 微信端全英文 | ✅ | `app.js` 所有 `sendText`、`command-registry.js` 帮助、审批提示、错误文案、思考状态行全部中文化 |
| P1-2 静默时段硬编码且覆盖不全 | ✅ | `quietHours` 可配置并入 `updateSettings` 白名单；非 random 来源 `defer` 到窗口结束；超 6h 宽限判 stale |
| P1-3 随机查岗默认过密且只读 | ✅ | 三档预设（默认「标准」15–45）+ 自定义区间；桌面可切换；`/checkin` 支持档位名与别名 |
| P1-4 微信掉线无可见提示 | ✅ | 会话过期/未登录/多账号可达且带「连接微信」按钮；**心跳 + 最后活动时间 + 超时不伪装成成功**（见下节） |
| P2-1 入站无 owner 校验 | ✅ | `message-utils.js` 归一化阶段丢弃非 owner 消息 + 脱敏日志；`test/inbound-owner.test.js` |
| P2-2 计划只增不删 + 每秒全量读盘 | ✅ | `AtomicJsonStore` mtime+size 读缓存；`SupervisionPlanStore.prune()` |
| P2-3 队列非原子写 | ✅ | `system-message-queue-store.js` 改 tmp+rename |
| P2-4 备份依赖 PATH 上的 `tar.exe` | ✅ | `resolveTarExecutable()` 优先 System32 bsdtar + `probeTarCapability()` |
| P2-5 TurnGate 无超时 | ✅ | TTL 默认 10 分钟 + `expireStale` |
| P2-6 打包产物落后于源码 | ✅ | 重新出包，见「出包结果」。`app.asar` 指纹由 `EB0D3E8D…B020A8B`（09-04）变为 `818F5FBE…C2B6E9` |
| P3-1 `/help` 只列开发者命令 | ✅ | 分层：默认用户档，`/help all` 出开发者档 |
| P3-2 监管计划面板语义误导 | ✅ | 空态改文案 + 随机查岗状态脚注 + 全局摘要 |
| P3-3 连接微信弹黑窗跑 npm | ✅ | 登录进程内跑、二维码画进 Electron 窗口；**exe/安装包图标也换成了品牌标记**（见下节） |

---

## P1-4 的三条补充（原文档列为未做）

1. **「最后一次成功收发消息」时间戳 + 通道告警横幅（已做）**。`src/core/wechat-activity-store.js` 把活动状态落盘到 `<stateDir>/wechat-activity.json`：桥子进程写、桌面父进程读，**这个文件本身就是跨进程心跳**。健康时 30s 节流写入，**状态跃迁立即写**；只存有界的 `lastErrorClass`，绝不存原始错误文本。`src/desktop/channel-health-view.js` 以 30 分钟为陈旧阈值渲染琥珀色横幅。
2. **bridge 心跳（已做）**。同上；`resolveChannelHealth()` 通过 `silenceSinceMs` 跨快照携带来留宽限期。
3. **轮询超时不再伪装成空结果（已做）**。这是本批里最重要的一个真 bug：`api.js` 把超时吞成 `{ret:0,msgs:[]}`，与健康空闲态**字节级相同**；`app.js` 的 poll 循环又**无条件**执行 `consecutiveFailures = 0`。两者叠加的后果是**一个只会超时的通道永远不累计失败、永不退避、永不报错**，表现为「一直没反应」而不是报错。
   设计依据取自真实日志（`~/.cyberboss/logs/bridge.jsonl`）：2334 次 poll 里 success 2325 / timeout 9，正常延迟约 19s，network 类错误 371 —— 结论是**「HTTP 200 且 0 条消息」才是正常空闲态，也才是活性信号**，超时（0.4%）是异常。
   修复：`src/core/channel-health.js` 纯状态机（success 才重置全部计数并清 degraded；timeout 只累加 `consecutiveTimeouts`，绝不重置失败计数/`lastSuccessAt`；单次 failure 不降级）；删掉 poll 循环里那句无条件重置。

---

## 出包过程中新发现的 6 个问题（均不在原审计 14 项内）

出包被放在最后是正确的，但**它跑了三轮** —— 因为出包暴露的问题会回流到源码。

1. **`npm run verify:artifacts` 在这台机器上根本跑不通：硬编码 `tar.exe`**。
   `scripts/verify-api-first-artifacts.js:66-67` 直接调 `tar.exe`，而本机 PATH 上 Git-for-Windows 的 **GNU tar** 排在 System32 **bsdtar** 前面，解不了 `BackupService` 用 `tar -a` 生成的 zip，报 `tar: Cannot connect to C: resolve failed`。
   讽刺的是应用层早就修过这个问题（P2-4 的 `resolveTarExecutable()`），**但校验脚本绕过了它**。已改为复用同一个 helper。

2. **同一个脚本还把 `ELECTRON_RUN_AS_NODE=1` 透传给子进程**。
   宿主自身跑在 Electron 里，会向所有子进程导出该变量；被继承时 `Aidy.exe` 不会启动 Electron，而是退化成**纯 Node**，于是 Node 的参数解析器拒绝了 Chromium 参数：
   ```
   Aidy.exe: bad option: --disable-gpu      （退出码 9）
   ```
   **判别特征**：`exit 9` + `bad option` 是 Node 的行为，不是 Electron；「无参数退出 0、带参数就报 bad option」正是这个坑。删掉该变量后应用正常启动。
   这条的意义比它本身更大：**该门禁的启动阶段从来没有真正验证过打包产物**，它一直在测 Node 的参数解析器。加上第 1 条，这个脚本有**两个互相独立、都导致它永远无法通过**的原因 —— 这也正是两个都没被发现的原因：**它从来没绿过，于是没人看它**。

3. **发布门禁不校验新鲜度**。
   `desktop:package` 只跑 `electron-builder --win nsis`，而便携版走的是另一个脚本 `desktop:package:portable`。于是我一度得到「安装包是新的、`dist/Aidy-0.1.0-x64.exe` 是 09-04 的旧二进制」这种组合 —— 而它**因为文件名恰好符合新命名规范而顺利通过校验**。
   已加入新鲜度闸门：基准取「最近一次触及**被打包路径**（`src/`、`bin/`、`native/`、`templates/`、`package.json`）的提交时间」与「已改动但未提交的被打包文件 mtime」中的较大值，2 秒容差。基准**按被打包路径收敛**是必要的 —— 否则一次纯文档提交就会让门禁误报产物过期，而误报几次之后它就会被无视。

4. **旧品牌检测正则漏掉裸 `CyberBoss.exe`**。
   原正则只匹配 `CyberBoss-Setup-v*.exe` 与 `CyberBoss-<数字>-x64.exe`，因此 `dist/win-unpacked-telemetry/win-unpacked/CyberBoss.exe` 就这么躺在仓库里、而门禁打印 `ok`。已改为匹配基名以 `CyberBoss` 开头的 `.exe`。

5. **`build.win.icon` 从未被设置**（详见下节「子 agent 汇报必须核对」）。

6. **托盘图标实际是空白的**。
   `createTrayIcon()` 把 **SVG** 数据 URL 喂给 `nativeImage.createFromDataURL`，而 `nativeImage` 只声明支持 PNG/JPEG。用真实启动（完整 Electron + 真窗口 + 临时 state 目录）捕获到运行时返回 **0×0** 图像。
   **托盘是 Aidy 这类常驻 Agent 的主要交互入口，图标空白意味着用户找不到它**，属实质缺陷而非观感问题。已改为：保留 SVG 尝试，为空时回退到 `nativeImage.createFromBitmap(rasterizeBrandIcon(32))`，两者都失败才报错。
   同时修掉了一个**门禁盲区**：`desktop-smoke.js` 的通用错误过滤正则 `/Error:|TypeError|…/i` **永远匹配不到这条文案**，所以这个缺陷对门禁完全不可见；已加一条专门的断言。

### 关于托盘图标的证据边界

**已证实**：真实启动下该诊断行会触发、`nativeImage.createFromDataURL` 返回 0×0；`createFromBitmap` 路径可用且通道序正确（往返字节零差异，中心像素 BGRA `[139,217,247]` = `#f7d98b`、周边 `[82,93,49]` = `#315d52`）。
**未证实**：无法独立判定「在非宿主环境的正常启动里 SVG 路径是否会成功」—— 因为本机所有图像解码（含一个已知正常的 1×1 PNG 对照）都返回 0×0，无法隔离出单一变量。**但这一点已不影响结论**：回退路径使 SVG 成功与否都不再有后果。

---

## 出包结果

**产物**（`dist/` 只保留当前构建）

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `Aidy-Setup-v0.1.0.exe` | 127,066,709 | 安装版 |
| `Aidy-0.1.0-x64.exe` | 103,664,136 | 便携版 |
| `win-unpacked/Aidy.exe` | 235,867,136 | 较加图标前 **+332,800** |
| `win-unpacked/resources/app.asar` | 133,430,446 | sha256 `818F5FBE…C2B6E9` |

**品牌图标确实嵌入可执行文件**（不是「配置写了就算数」）：构建日志中 `default Electron icon is used` 的出现次数由 1 变为 **0**，且 exe 体积增加了约 33 万字节。
图标本身经独立解码核验：256×256 / 8bit / colourType 6，四角全透明、圆角轮廓正确、中心为 `#f7d98b`。

**过期产物隔离**：原先 `dist/` 下同时存在 8 个过期目录，其中 `dist/win-unpacked-telemetry/win-unpacked/CyberBoss.exe` 是旧品牌可执行文件。全部移入新建的 `dist-quarantine/`，并放 `STALE-DO-NOT-SHIP.md` 作为**显式豁免标记**（门禁跳过带标记的目录）。豁免必须是有意做出的动作：未加标记的旧品牌目录仍会让门禁失败。
`dist-quarantine/` 已加入 `.gitignore`（含数百 MB 二进制）。另有一处独立隔离区 `dist-release-v0.1.0/`（首批发给外部测试者的旧品牌版本）。

---

## 出包环境的一个坑（已写入发布清单）

宿主的 safe-delete 垫片有**单次工具调用内的累计删除预算**（阈值 50）。报错形如：

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
{"count":55,"threshold":50,"scope":"turn","targetCount":1}
```

**要读懂 `count` 与 `targetCount`**：`targetCount` 是本次要删的文件数，`count` 是**本次工具调用内累计**已删数。所以 `targetCount:1, count:55` 的含义是「本调用已累计删了 54 个，这一下越界」，不是「要删 55 个文件」。
两个后果：① `electron-builder` 打包开头的 `emptyDir('dist/win-unpacked')`（71 个 locales 文件）会当场被拦；② **一次完整的 Windows 打包自身就产生约 55 次删除**，所以不要在一次工具调用里串两个目标，否则第二个必然失败、且 `&&` 断链会让末尾的 `desktop:sync-start-menu` **静默不执行**。
最阴的是**失败点在产物写完之后的临时文件清理阶段**：产物完整有效，退出码却是 1。
规避后两个目标均以 `EXIT=0` 完成，日志中 safe-delete 计数为 0。相关纪律已写入 `docs/release/FIRST-EXTERNAL-TESTER-CHECKLIST.md`。

---

## 一个流程教训：子 agent 的汇报必须核对实际改动

本批出现两次「汇报与代码不符」，两次都靠**字节级/差异级证据**发现：

1. `faa1876` 的提交信息写「set build.win.icon to \"assets/icon.ico\"」，但 `git show` 的实际 diff **只加了一行 `build:icon` 脚本**，`build.win.icon` 从未写入。核验手段：`grep -n icon package.json` 只匹配到脚本行；`builder-debug.yml` 无 icon 引用；**exe 字节数与加图标前一字不差**；在 exe 内按字节搜图标 256×256 条目的像素行搜不到。它描述了自己**打算**做的事。
   **若按汇报收工，这个包会带着 Electron 默认 logo 发出去，而提交信息会告诉未来的维护者「已经修好了」。**

2. 另一处把 `ELECTRON_RUN_AS_NODE` 环境缺陷误判为「产品级回归」并建议转交桌面团队。实测否证：同一 exe、同一参数，唯一变量是子进程环境 —— 继承时为 `exit 9 / bad option`，删掉后正常启动。

**规矩**：信代码，不信汇报。必查 —— 提交信息与 `git show` 是否一致、声称的配置项是否真在文件里、字节级证据（体积变化 / 像素搜索 / 往返比对）是否支持结论。

---

## 独立复核（2026-09-19）

不引用本文的自述，回到源码逐项查标记复验这 14 项（27 条断言全部通过）。其中两项断言过于宽松、不足以作为证据，已单独取证：

- **P1-2**：`DEFAULT_QUIET_HOURS = { enabled: true, start: "23:00", end: "07:00" }`（原为硬编码 00:00–06:00），
  且 `supervision-policy.js` 注释明确「by default, protect every checkpoint source」，另有 `QUIET_LATE_GRACE_MS = 6h`。
  **界面控件确实存在**（`index.html:207`：启停勾选 + 两个 `type="time"` 输入；`renderer.js:628` 经 `updateSettings` 保存）——
  只检查存储层白名单会漏判：本项的原话是「用户没有控制权」，**有控件才算改好**。
- **P1-3**：`DEFAULT_PRESET_ID = "standard"`、`DEFAULT_MIN/MAX_INTERVAL_MS = 15/45 分钟`（原 3–60）；档位别名支持中文「标准」。

## 本次整改**未覆盖**的两块（如实记录）

1. **`2026-09-07-aidy-project-tools-capability-parity.md` 的 release boundary 未完全闭合。**
   该文结论为 `source fixed only / packaged build pending / current user runtime not fixed`：
   - 「packaged build pending」——**已由本次重新出包解决**；
   - 但该文同时写明「**ReportScheduler、timeline launcher 与 stale queue 没有被本轮源码修复**」，
     这几项**不在** 9-18 产品审计的 14 项之内，本次也未处理。

2. **本机运行时仍未出现「报表 / 日记已恢复」的证据**（2026-09-19 实测）：
   - `reportEnabled` 现为 `true`（9-07 审计时为 `false`，且当时环境安全审核不允许修改）—— 这一项自行恢复；
   - `quietHours` 在持久化 state 中**不存在** → 走代码默认 23:00–07:00（功能正常，只是从未显式设置过）；
   - **日记最后一份仍是 `2026-08-25.md`**；
   - `reports/index.json` 现为 **0 条**（审计当日为全部 pending/running）；
   - `supervision-plan.json` **296 条 / 200 KB**（与审计当日同数，未增长）。

   这正对应产品审计 §5 的开放问题 #3（「`reportEnabled=false` 与 6 天没写日记，是你不想要还是它坏了」）—— **需要产品主判断，不是工程问题**。

3. 产品审计 §5 的另外 3 个开放问题（随机查岗默认密度、提醒入口以桌面还是微信为主、是否保留多用户场景）仍为**待决策项**，不属整改范围。

---

## 遗留事项（不阻塞发布）

1. **`dist-quarantine/` 可整体删除**。确认当前产物验证通过且不再需要这些证据之后即可清理，不影响构建或发布。
2. **rebrand 未完成且是有意为之**：`package.json` 的 `name` 仍是 `cyberboss`、`appId` 仍是 `com.cyberboss.desktop`、`BRAND.legacyUserDataDirectory` 仍是 `CyberBoss`。保留 Windows 身份与用户数据路径是为了不丢登录态，**改名前需先确认影响面**。
3. **托盘图标建议在真机上目视确认一次**：本机无法判定 SVG 路径在正常启动下是否成功（见上文证据边界），虽然回退路径已使该问题不具后果，但看一眼托盘仍是最直接的确认。
4. **`scripts/build-app-icon.js` 与 `src/desktop/brand-icon.js` 共用几何**：若要改品牌标记，改 `brand-icon.js` 一处即可，但记得重跑 `npm run build:icon` 并确认 `assets/` 产物变化符合预期（重构验证过一次字节一致，但那不代表以后随意改动也安全）。
