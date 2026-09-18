# Aidy 产品审计报告

日期：2026-09-18
审计视角：产品经理 + 目标用户（ADHD / 执行功能困难、中文、需要在微信里被主动监督的人）
审计对象：`D:\CyberBoss`（Aidy v0.1.0，`main` @ `a57c706`）
审计方式：源码通读 + 本机真实运行态取证 + 构建产物比对 + 全量测试执行

---

## 0. 一句话结论

**Aidy 的「配置链」已经跑通，「监督链」的决策逻辑也扎实，但用户到达核心功能的那一步断了**：桌面控制中心没有设定提醒/查岗的入口，用户只能绕行到微信发自然语言或英文命令；而微信端所有系统回复都是英文，静默时段又硬编码且覆盖不全。结果是——一个中文 ADHD 用户会在开箱后立刻被一个「默认每 3–60 分钟就可能开口、且他无法在界面里调」的助手打扰，并且收不到真正有用的提醒时也不知道为什么。

按「影响体验与价值交付」排序，共 14 项问题：**P0 × 1、P1 × 4、P2 × 6、P3 × 3**。

---

## 1. 审计基线与证据

| 项目 | 实测值 |
|---|---|
| HEAD | `a57c706 fix: bind action claims to verified tool evidence`（2026-09-08） |
| 工作区状态 | 8 个文件未提交（含新增 `src/core/persona-pack-store.js`、`templates/personas/jiheng.md`） |
| 全量测试 | **575 tests / 562 pass / 4 fail / 8 cancelled / 1 skipped** |
| 4 个失败 | 3× `backup-service.test.js`（`tar: Cannot connect to C: resolve failed`）、1× `codebuddy-managed-serve.test.js`（仅在本沙箱环境失败，非产品缺陷） |
| 真实 state dir | `C:\Users\23159\.cyberboss` 存在，`desiredState=running`、`randomCheckinsEnabled=true`、`reportEnabled=false` |
| 监督计划数据 | 296 条 checkpoint（random 266 / zhijiantime 19 / conversation 6 / context 5），跨 2026-08-23 → 2026-09-10，文件 194 KB |
| `checkin-config.json` | **不存在** → 随机查岗运行在代码默认值 3–60 分钟 |
| 日记 | 最后一份 `2026-08-25.md`；8-25 之后无新增 |
| 报表 | `reports/index.json` 全部为 `pending` / `running`，**无一份生成成功**，最后更新 2026-08-23 |
| 已打包产物 | `dist/win-unpacked/resources/app.asar` SHA-256 `EB0D3E8D…B020A8B`，mtime **2026-09-04** |
| `dist-release-v0.1.0/` | 只有 **`CyberBoss-Setup-v0.1.0.exe`**（2026-08-30，旧品牌），没有 `Aidy-Setup-v0.1.0.exe` |

---

## 2. 问题清单（按严重度排序）

### P0-1 · 核心功能在桌面控制中心没有入口

**现象**
首页「监管计划」面板是只读列表，能做的操作只有「延后 10 分钟」和「取消」，**没有任何「新建」入口**。

**证据**
- `src/desktop/renderer/index.html:66-72` —「监管计划」面板只有标题、计数徽标和列表容器，无按钮；空态文案「还没有固定查岗安排」也不带下一步操作。
- `src/desktop/renderer/renderer.js:274-287` — `renderCheckpoints()` 只渲染 `data-delay-checkpoint` / `data-cancel-checkpoint`。
- `src/desktop/main.js:296` — IPC 只有 `desktop:update-checkpoint`，**没有 create**。
- 对比 `README.md:43` 的承诺：「3. 设定提醒、check-in 区间或任务 checkpoint」——这一步在桌面上不存在。

**用户影响**
产品最核心的差异化能力（「你可以约定一个时间点，让 Aidy 到时回来提醒你」，`README.md:21`）在 GUI 里无路可走。用户打开控制中心，看到的是一个只能看、不能设的「监管计划」。这一条直接决定产品是否「可用」。

**改进建议**
1. 在「监管计划」面板加「新建提醒」：一句话输入 + 时间选择（支持「30 分钟后」「今晚 21:00」「明天早上」三种快捷），落库到 `SupervisionPlanStore.add({source:"conversation", dueAt})`。
2. 空态文案改为行动导向：「还没有安排。要我在什么时间回来问你一次？」，并直接内嵌输入框。
3. 把「随机查岗区间」从只读改为桌面可编辑（见 P1-3）。
4. 提供「立即查岗一次」按钮用于验收与自测——目前没有任何手动触发手段，导致这个核心功能极难被验证（本机 18 天数据是唯一证据来源）。

---

### P1-1 · 微信端所有系统回复、帮助文本、错误提示都是英文

**现象**
桌面控制中心全中文，但用户真正交互的界面——微信——的系统回复是英文。

**证据（均为发给用户的原文）**
- `src/core/app.js:1776` → `⏰ Current check-in interval is 3-60 minutes.`
- `src/core/app.js:1786` → `💡 Usage: /checkin <min>-<max>`
- `src/core/app.js:1798` → `✅ Check-in interval reset to ... minutes and will apply on the next polling cycle.`
- `src/core/app.js:1507/1516/1525/1535/1549` → `💡 Usage: /bind /absolute/path`、`⚠️ Only absolute paths are supported for /bind.`、`✅ Workspace bound`
- `src/core/app.js:1765` → `⏹️ Stop request sent`
- `src/core/app.js:1809/1818` → `💡 Current minimum merge chunk is ...`
- `src/core/command-registry.js:290` → 帮助文本标题 `💡 Available commands:`，分组标题 `Lifecycle & Diagnostics` / `Workspace & Thread` / `Approvals & Control` / `Capabilities`
- `src/core/app.js:1493-1498` → **任意未识别的 `/xxx` 都会触发全屏英文帮助**

**用户影响**
目标用户是中文 ADHD 用户。他在微信里唯一会主动使用的设置手段（改查岗区间）需要读英文命令；他误发一个 `/` 开头的消息就会被吞掉并收到一屏英文。这是最容易被用户直接感知的「不像给中国人做的产品」信号。

**改进建议**
1. 把 `command-registry.js` 的 `summary` 与 `label` 改为中文（可保留英文 key 作为内部 id）。
2. `app.js` 中所有 `channelAdapter.sendText` 的用户可见文案改中文，尤其是 `/checkin`、`/bind`、`/status`、`/stop` 三类。
3. 未识别命令的兜底回复改为「这条命令我还不认识。想让我提醒你，直接说『X 点提醒我』就行」，而不是甩帮助全文。
4. 建议加一条测试断言：`app.js` 中 `sendText` 的 `text` 字面量必须含中文（防回归）。

---

### P1-2 · 静默时段硬编码、无法配置，且覆盖不全

**现象**
「0–6 点安静」写死在代码里，设置页没有这一项；而且它只保护一部分提醒来源。

**证据**
- `src/core/supervision-policy.js:2-3` — `QUIET_HOURS_START = 0` / `QUIET_HOURS_END = 6`，无环境变量、无配置项。
- `src/core/supervision-policy.js:49-54` — `isTimeSensitiveCheckpoint()` 只认 `source === "random"` 和 `canonicalTaskId` 以 `zhijiantime:daily-planning:` 开头的项。
- `src/core/supervision-policy.js:22-33` — 静默抑制**只对上述「时间敏感」项生效**；`conversation`、`context`、以及其他 `zhijiantime` 项不走静默判断，直接 `dispatch`。
- 提醒类消息（`taskType:"reminder"`）走的是另一条路径，**完全不经过该判定**。
- `src/core/desktop-state-store.js:74` 存了 `timezone` 字段，但没有任何策略代码读它（死配置）；`index.html:182-183` 只暴露了「吃饭后/洗澡后查岗」两个时长。

**用户影响**
用户白天说一句「凌晨两点叫我起来看一眼」，到点就会被叫——这可能是好事；但用户说「明天上午 9 点提醒我」，Aidy 在反复重试或后续补发时也可能落在凌晨。更关键的是**用户没有控制权**：他无法设置自己的睡眠时段。对一个「无监控感、不打扰」定位的产品，这是价值观层面的漏洞。

**改进建议**
1. 静默时段进设置页（起止时间两个 time 控件），存 `desktop-state.json`，默认 23:00–07:00。
2. 让 `isTimeSensitiveCheckpoint` 的判定反转：**默认所有来源都受静默保护**，只有用户显式设定「这个必须在几点发」的提醒才豁免。
3. 豁免场景要在微信里明说：「这条我按你说的凌晨 2 点发，不受静默影响」。
4. 静默期内被抑制的提醒不要静默丢弃：改为「静默结束后顺延发送」或至少在桌面「监管记录」里显示「因静默期跳过 N 条」，让用户知道发生过什么（当前 `outcome: "suppressed_quiet_hours"` 在桌面只是一个小标签，用户不理解）。

---

### P1-3 · 随机查岗默认 3–60 分钟过密，且桌面只能看不能改

**现象**
开箱默认就是「每 3–60 分钟给我一次主动开口的机会」，用户从桌面上无法调整。

**证据**
- `src/core/checkin-config-store.js:4-5` — `DEFAULT_MIN_INTERVAL_MS = 3 * 60_000`、`DEFAULT_MAX_INTERVAL_MS = 60 * 60_000`。
- 本机 `~/.cyberboss/checkin-config.json` **不存在**，说明一直在用默认值。
- `src/desktop/renderer/renderer.js:186-188` — 只读展示 `${min}–${max} 分钟`；`index.html:180` 只有勾选框，没有输入框。
- 修改的唯一途径是微信 `/checkin <min>-<max>`（`src/core/app.js:1770-1801`），而这条命令的说明是英文（见 P1-1）。
- 实测数据：18 天产生 **266 条 random checkpoint**，约 15 次/天。
- `src/desktop/supervision-dispatcher.js:115-130` — 同一时刻只保留一个 pending random checkpoint，到点后立刻生成下一个，因此这个频率是**持续性的**。

**用户影响**
对 ADHD 用户，Aidy 的价值完全取决于「打扰密度」是否合适——太频繁会让他关掉通知甚至卸载，太稀疏又没监督感。目前这个最关键的产品参数被固定在两个极端之间的宽区间里（3–60 分钟，平均约 31 分钟），用户无法表达自己的偏好。这是**留存生死线**。

**改进建议**
1. 把区间做成桌面上的三档预设（「轻陪伴 30–90 分钟 / 标准 15–45 分钟 / 紧密 5–20 分钟」）+ 一个自定义区间，落 `checkin-config.json`。
2. 首次启动时的 onboarding 第 4 步问一句：「希望我大概多久来问你一次？」——这是产品该在第一天就收集的唯一偏好。
3. 默认值保守化：建议默认 30–90 分钟，而非 3–60。
4. 在「监管记录」里显示「今天主动找过你 N 次，其中你回应了 M 次」，让用户有依据去调，而不是靠感觉。

---

### P1-4 · 微信会话过期/掉线时，用户看到的是无关的错误提示

**现象**
微信登录失效会让 bridge 退出，但用户界面上呈现的是「微信连接服务连续退出」这类通用熔断文案，**不指向「重新扫码」**。

**证据**
- `src/core/app.js:68`、`src/core/app.js:2447-2454` — 以 errcode `-14` 判定会话失效。
- `src/core/app.js:371-373` — 直接抛出并终止轮询循环，进程退出，只在控制台提示重跑 `npm run login`。
- `src/desktop/runtime-supervisor.js:399-402` — `handleOutput` 只匹配 `No saved WeChat account` 和 `Multiple WeChat accounts`，**不识别会话过期**。
- `src/desktop/connection-diagnostics.js:29` 定义了 `WECHAT_SESSION_EXPIRED` 文案，但**全仓库没有任何 emit 点**（死代码）。
- `src/adapters/channel/weixin/api.js:229-239` — 轮询超时被吞成伪成功 `{ret:0,msgs:[]}`，服务端持续慢时表现为「一直没反应」而不是报错（静默失败）。
- `src/desktop/runtime-supervisor.js` 没有周期性健康探活，只监听子进程 `exit`。

**用户影响**
这是「主动监督」类产品最致命的失效模式：用户以为艾迪在运行（托盘图标还在、控制中心显示「运行」），实际上他**一条提醒都收不到**，而且没有任何信号告诉他。用户不会去读日志，他只会得出「这个产品不 work」的结论。

**改进建议**
1. 把 `WECHAT_SESSION_EXPIRED` 接上 emit：让 supervisor 识别 -14，映射到 `connection-diagnostics.js` 的中文文案 + 「重新扫码」按钮（复用已有的 `buttonAction: "wechat_login"` 分支，`renderer.js:209-217`）。
2. 加一个「最后一次成功收发消息」时间戳，在首页「微信」卡片上展示；超过阈值（如 30 分钟且有 pending 消息）就在首页顶部弹提示。
3. 给 bridge 加轻量心跳：周期性调用一个廉价接口，连续失败 3 次即置 `error` 并提示，而不是等子进程退出。
4. 轮询超时不要伪装成空结果——至少计数并在连续 N 次后在桌面显示「网络似乎不稳定」。

---

### P2-1 · 入站消息没有发送者归属校验

**现象**
任何人都能给这个微信机器人发消息，且消息会被当成用户本人的指令送进 runtime 执行。

**证据**
- `src/adapters/channel/weixin/message-utils.js:29-57` — `senderId = message.from_user_id`，`chatId = senderId`，**没有任何一处把它和已登录账号比对**。
- `src/core/config.js:17` 定义了 `allowedUserIds`（`CYBERBOSS_ALLOWED_USER_IDS`），但 `src/core/default-targets.js:14-19` 是它**唯一**的使用点，且只用于**出站**选人。
- 工具 allowlist（`docs/audits/…capability-parity.md:275`）包含 `cyberboss_diary_append`、`cyberboss_timeline_write` 等有写入副作用的工具。

**用户影响**
Aidy 在微信里是一个可被添加的联系人/机器人。只要别人能对它说话，就能驱动一个拥有写日记、写时间轴、读指尖时光日程权限的 Agent。这是隐私与账号安全问题，而不只是功能问题。

**改进建议**
1. 在 `message-utils.js` 归一化阶段加 owner 闸门：若 `from_user_id !== 已登录账号绑定的 ownerId`，丢弃并记一条脱敏日志。
2. `allowedUserIds` 从「出站选人」升级为「入站白名单」，并接入桌面设置。
3. 若要保留多用户能力，至少把非 owner 的消息降级为「只读问答」，不允许触发任何写工具。

---

### P2-2 · 监督计划数据只增不删，且每秒全量读盘

**现象**
`supervision-plan.json` 没有任何裁剪机制，而调度器每秒都会完整读取并解析它。

**证据**
- `src/core/supervision-plan-store.js:25-37` — `add()` 只做 append，**全类没有 delete/prune**。
- `src/core/supervision-dispatcher.js:16,34` — `setInterval(..., this.intervalMs)`，`intervalMs` 默认 **1000 ms**。
- `src/core/supervision-dispatcher.js:51` — 每秒调用 `this.planStore.due(now)`。
- `src/core/supervision-plan-store.js:68-72` — `due()` → `list({state:"pending"})` → `this.store.read()`。
- `src/core/atomic-json-store.js:13-19` — `read()` 每次执行 `fs.readFileSync` + `JSON.parse`，**没有内存缓存**。
- 实测：18 天 → 296 条 / 194 KB。

**用户影响**
当前不痛，但这是线性劣化：按 ~16 条/天增长，一年后约 6000 条 / 4 MB，而读取频率是 60 次/分钟。届时 `buildSnapshot()`（`main.js:399-400` 又各调一次 `list()`）和 `resolveLegacySupervisionKey()`（`supervision-dispatcher.js:144-150`，每条队列消息都 `list()` 全量扫描一次）会开始拖慢 UI 与消息吞吐。属于「一定要在增长到出问题之前修」的类型。

**改进建议**
1. `SupervisionPlanStore` 加 `prune({ keepDays: 30, keepPending: true })`，在 `start()` 时执行一次、之后每天一次。
2. `AtomicJsonStore` 加基于 mtime 的只读缓存，或给 `SupervisionPlanStore` 加一层内存索引（按 state 分桶）。
3. `due()` 改为只读 persisted 的 pending 子集，而不是全量 parse 后再 filter。

---

### P2-3 · 系统消息队列非原子写，且主进程与 bridge 子进程并发读写同一文件

**现象**
队列落盘用的是裸 `writeFileSync`（不同于项目其他 store 的 tmp+rename 原子写），而两个进程都在改它。

**证据**
- `src/core/system-message-queue-store.js:47` — `fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2))`，无临时文件、无 rename。
- 对比 `src/core/atomic-json-store.js:32-47` — 项目其他 store 用的是「写 tmp → rename」的原子模式。
- 队列文件 `system-message-queue.json` 同时被 Electron 主进程的 `SupervisionDispatcher`（`main.js:24-27`）和 bridge 子进程（`app.js:223-227`）读写。

**用户影响**
在「主进程刚 dispatch 一条查岗、同时 bridge 刚发完一条消息」的窗口里，read-modify-write 可能互相覆盖，表现为**用户少收到一条提醒**，且没有任何告警。对「主动监督」产品，丢提醒等于丢信任。

**改进建议**
1. 把 `SystemMessageQueueStore` 改为复用 `AtomicJsonStore`。
2. 明确单一写入者：让 bridge 成为队列的唯一 owner，主进程只通过控制通道提交，避免双进程直写。
3. 加一条计数器日志（enqueue / sent / dropped），便于事后核对。

---

### P2-4 · 备份/导出/恢复依赖 PATH 上的 `tar.exe`，在装有 Git 的机器上会直接失败

**现象**
本机全量测试中 3 个备份测试失败，错误是 `tar: Cannot connect to C: resolve failed`。

**证据**
- `src/services/backup-service.js:51` — `runHidden("tar.exe", ["-a", "-c", "-f", resolvedTarget, "."], { cwd: staging })`
- `src/services/backup-service.js:68` — 解包同样调用 `tar.exe`
- `src/services/backup-service.js:167` — 读取 manifest 也调用 `tar.exe`
- 本机 `which -a tar.exe` 结果是 `/usr/bin/tar.exe`（GNU tar，来自 Git for Windows）**排在** `/c/WINDOWS/system32/tar.exe`（bsdtar）之前 → GNU tar 把 `C:\...` 当成远程主机 `C`。
- 失败测试：`test/backup-service.test.js` 的 25/26/27 三条。

**用户影响**
- 在**未安装 Git** 的干净用户机上大概率正常（系统 bsdtar 优先）。
- 但在**装了 Git for Windows 并勾选了 Unix 工具**的机器上，桌面「创建备份 / 导出日记 / 导出报表 / 恢复」会全部失败，且报错是 `Cannot connect to C`，用户完全无法自查。
- 本仓库 README 的「从源码运行」路径本身就要求 `git clone`，所以这个人群是真实存在的。

**改进建议**
1. 显式使用绝对路径 `path.join(process.env.SystemRoot, "System32", "tar.exe")`，找不到时再回落到 `tar.exe`。
2. 启动时探测一次 tar 能力（`tar --version`），不兼容就在桌面诊断里给出明确中文提示。
3. 长期看，打包内自带一个归档实现（如 `archiver`）比依赖宿主 tar 更可控。

---

### P2-5 · TurnGate 无超时，单个会话可能永久卡死

**现象**
如果 runtime 没发出终止事件，该会话的 gate 会一直挂着，之后该会话的消息只入队不派发，且缓冲无上限。

**证据**（来自源码通读，未构造复现）
- `src/core/turn-gate-store.js` 无 TTL 机制。
- `src/core/app.js:979-983`、`:1103-1128` — scope 处于 pending 时，后续消息不派发。
- 正常释放依赖 `runtime.turn.completed/failed`（`app.js:1989`）。
- `src/core/app.js:797-800` 早退时删了 `activeRecord` 却**不释放 gate**，而 `attachThread`（`:819`）晚于 `sendTurn`，存在 gate 悬挂的理论竞态（未复现）。

**用户影响**
表现为「某天开始，艾迪突然不回我消息了，但界面显示运行中」。与 P1-4 一样属于「静默失效」，而且重启才能恢复（重启即丢内存态）。

**改进建议**
1. 给 TurnGate 加 TTL（建议 10 分钟）+ 超时后强制释放并记 `TURN_GATE_TIMEOUT`。
2. `app.js:797-800` 的早退路径补上 gate 释放。
3. 桌面诊断里暴露「当前挂起的 turn gate 数与最久等待时长」。

---

### P2-6 · 已打包产物落后于源码，且两份构建目录品牌/日期互不一致

**现象**
用户拿到的安装包不含 9-08 的关键修复；项目里同时存在两套互相矛盾的构建产物。

**证据**
- `dist/win-unpacked/resources/app.asar` SHA-256 `EB0D3E8D…B020A8B`，mtime **2026-09-04**。
- 该 hash 与 `docs/audits/2026-09-07-…capability-parity.md:16` 记录的 pre-Round-2 hash **完全一致** → 说明 9-08 的 `474880e checkpoint: wire CodeBuddy Project Tools supervision` 与 `a57c706` **没有进入已打包产物**；同审计文档 `:298` 自述「source fixed only / packaged build pending」。
- 工作区还有 8 个未提交文件（人格包功能 + `runtime-adapter.js` 改动），同样不在包内。
- `dist-release-v0.1.0/` 里是 **`CyberBoss-Setup-v0.1.0.exe`（2026-08-30）**；`INSTALL.md:17` 与 `docs/release/FIRST-EXTERNAL-TESTER-CHECKLIST.md:16` 都要求 `Aidy-Setup-v0.1.0.exe`。`dist/` 下的才叫 `Aidy-Setup-v0.1.0.exe`（2026-09-04）。

**用户影响**
如果现在把安装包交给外部测试者，对方装到的是一个**品牌名还是 CyberBoss、且缺少 Project Tools 能力**的版本，然后按 `INSTALL.md` 找不到对应的文件名。这会直接污染外部测试结论——测试者报告的「日记不写、报表不出」可能源于包太旧，而不是产品逻辑。

**改进建议**
1. 删掉或明确标注 `dist-release-v0.1.0/`（建议改名加 `-stale-` 或直接移除，避免误发）。
2. 先提交或明确搁置工作区的 8 个文件改动，再 `npm run desktop:package` 重新出包。
3. 出包后跑 `npm run verify:artifacts`，并把新 `app.asar` SHA-256 记进验收清单。
4. 把「installer 文件名与 INSTALL.md 一致」做成发布前自动检查项。

---

### P3-1 · `/help` 列出的是开发者命令，核心功能不在帮助里

**现象**
用户在微信里唯一能找到的「说明书」，教的全是他用不到的东西。

**证据**
`src/core/command-registry.js:1-250` 的微信可见命令全集：`/bind`、`/status`、`/new`、`/reread`、`/compact`、`/switch`、`/stop`、`/checkin`、`/chunk`、`/yes`、`/always`、`/no`、`/model`、`/star`、`/help`。

**用户影响**
`/bind`（绑工作目录）、`/reread`、`/compact`、`/chunk`、`/switch` 对「想被监督的普通人」几乎无意义；而他真正想知道的「怎么让你提醒我」不在里面。帮助文本反而推高了他的认知负担——这恰好违背产品自身定位（`SOUL`/`weixin-instructions.md` 都强调「先给最小下一步，别一次说太多层」）。

**改进建议**
1. 帮助文本按受众分两层：默认只显示 `提醒我`、`改查岗频率`、`暂停/继续`、`看今天`；开发者命令折叠到「更多命令」。
2. 把 `system.send`、`system.checkin_poller`、`reminder.create` 三个标 `status:"active"` 但**没有任何入口**的条目从帮助里移除（`command-registry.js:56-68,221-226`）。

---

### P3-2 · 「监管计划」面板的语义会让用户误判产品没在工作

**现象**
随机查岗正在运行时，首页「监管计划」仍显示「还没有固定查岗安排」。

**证据**
- `src/desktop/main.js:399` — `planStore.list({ includeRandom: false }).filter((item) => item.state === "pending")`，**显式排除 random**。
- `src/desktop/renderer/index.html:71` — 空态文案「还没有固定查岗安排」。
- 而同一个首页的另一张卡片（`index.html:63`）显示「随机查岗 3–60 分钟」，说明系统确实在跑。

**用户影响**
用户看到「什么都没有」，会认为主动监督没生效——尤其在第一天他还没收到任何消息时。

**改进建议**
1. 空态补一句「随机查岗正在运行，下一次大概会在 X 分钟后（具体时间保持随机）」。
2. 面板标题区加一行「全局设置」摘要（随机查岗开关 + 区间），让这张卡自解释。

---

### P3-3 · 「连接微信」会弹出一个黑窗口跑 npm

**现象**
非打包运行时，点「连接微信」会 `spawn` 一个 `cmd /d /k npm.cmd run login` 窗口。

**证据**
`src/desktop/main.js:442-456` — `const command = process.env.ComSpec || "cmd.exe"`；非打包路径 `["/d","/k","npm.cmd","run","login"]`；`stdio: "ignore"`、`detached: true`。打包路径走 `node bin/cyberboss.js login`，仍是黑窗。

**用户影响**
与整个控制中心的产品化体验割裂；`npm` 命令对普通用户是噪音。同时 `stdio:"ignore"` 意味着登录过程出错时用户看不到任何原因。

**改进建议**
1. 短期：把登录二维码渲染进一个专用的 Electron 窗口（`qrcode-terminal` 已经在依赖里），或用 `shell.openPath` 打开一个带标题的窗口。
2. 至少把 stdout 接到一个「登录详情」面板，而不是 `ignore`。

---

## 3. 做得好的地方（不要在这些地方回退）

1. **凭据与隐私设计是本项目的强项**，明显超出个人项目水准：
   - 模型密钥走 Windows DPAPI vault（`src/security/credential-vault.js`）；
   - 日志默认脱敏（`src/core/component-logger.js`）；
   - 备份显式排除 vault 与微信账号目录（`src/services/backup-service.js:8-15`）；
   - 临时诊断需用户勾选同意、最长 15 分钟、24 小时自动删除、不进备份（`index.html:206-212`）；
   - Electron 安全基线完整：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、CSP、`setWindowOpenHandler` 一律 deny（`src/desktop/main.js:201-217`、`index.html:6`）；
   - 文件打开做目录逃逸校验（`main.js:623-629`）。
2. **状态机与降级策略扎实**：`hold`/`discard`/`archive` 三态决策、provider 失败退避 5s/30s/120s/600s、连续 3 次失败熔断、10 分钟内 3 次崩溃熔断且不自动重启（`runtime-supervisor.js:440-462`）。这类「不假装成功」的处理比多数个人项目成熟。
3. **首次设置引导做得完整**：3 步 onboarding 进度条 + 模型配置分步表单 + 新手 coach 浮层 + 完整配置指南 + 截图占位（`index.html:25-39,159-177,226-231`），并区分了「推荐路径」与「高级兼容选项」。
4. **测试意识强**：575 条测试覆盖了 codex auth、vision fallback、supervision policy、backup、report scheduler 等，且有专门的 acceptance skill 自检（`npm run verify:acceptance-skill` 通过）。

---

## 4. 建议的修复顺序

### 第一批（让产品「能被用」——建议优先）
1. **P0-1** 桌面加「新建提醒」入口 + 随机查岗区间可编辑。
2. **P1-1** 微信端全量中文化。
3. **P1-3** 默认区间改为 30–90 分钟，并把「查岗频率」纳入首次启动引导。
4. **P3-2** 修掉「监管计划」的误导性空态。

> 这一批做完，一个中文用户从安装到收到第一条「有用的提醒」的路径才真正闭合。

### 第二批（让产品「可信」）
5. **P1-4** 微信会话过期/掉线的可见告警 + 重新扫码入口。
6. **P1-2** 静默时段可配置 + 覆盖范围反转（默认保护所有来源）。
7. **P2-1** 入站 owner 闸门。
8. **P2-3** 队列改原子写 + 单写入者。

### 第三批（工程卫生与长期健康）
9. **P2-6** 清理 `dist-release-v0.1.0/`、提交或搁置未提交改动、重新出包并记录 hash。
10. **P2-4** tar 绝对路径 + 能力探测。
11. **P2-2** plan store 裁剪 + 读缓存。
12. **P2-5** TurnGate TTL。
13. **P3-1 / P3-3** 帮助文本分层、登录窗口产品化。

---

## 5. 需要你决策的开放问题

1. **随机查岗的默认密度应该是多少？** 这需要你自己做 N=1 实验：连续一周跑「30–90 分钟」，再一周跑「15–45 分钟」，记录哪一周你回应得更多、更少想关掉通知。这是本产品唯一不能用逻辑推导、只能实测的参数。
2. **「设定提醒」的默认入口应该是桌面还是微信？** 我建议桌面为主（可控、可编辑）、微信为辅（一句话顺手）。但如果你 90% 时间不开桌面，「一句话设定」就必须做到极高准确率，那 P0-1 的形态要重新设计。
3. **`reportEnabled=false` 与 6 天没写日记，是「你不想要」还是「它坏了」？** 9-07 审计已确认 packaged runtime 缺 Project Tools 接线。如果这是坏的，报表/日记这两块能力在修好前不应出现在首页承诺里；如果是你不要，建议直接从首页移除，减少噪音。
4. **是否要保留多用户/non-owner 场景？** 如果这个 bot 只服务你一个人，P2-1 就是三行代码的事。

---

## 6. 证据索引

**源码**
- `src/desktop/renderer/index.html`、`src/desktop/renderer/renderer.js`、`src/desktop/main.js`、`src/desktop/onboarding-state.js`
- `src/core/app.js`、`src/core/supervision-policy.js`、`src/core/supervision-plan-store.js`、`src/core/checkin-config-store.js`、`src/core/system-message-queue-store.js`、`src/core/atomic-json-store.js`、`src/core/desktop-state-store.js`、`src/core/turn-gate-store.js`、`src/core/command-registry.js`、`src/core/config.js`
- `src/desktop/supervision-dispatcher.js`、`src/desktop/runtime-supervisor.js`、`src/desktop/connection-diagnostics.js`
- `src/adapters/channel/weixin/message-utils.js`、`src/adapters/channel/weixin/api.js`
- `src/services/backup-service.js`、`src/services/reminder-service.js`
- `src/security/credential-vault.js`、`src/security/diagnostic-capture.js`
- `templates/weixin-operations.md`、`templates/personas/jiheng.md`

**运行态证据**
- `C:\Users\23159\.cyberboss\desktop-state.json`（`desiredState=running`、`randomCheckinsEnabled=true`、`reportEnabled=false`）
- `C:\Users\23159\.cyberboss\supervision-plan.json`（296 条 / 194 KB / random 266）
- `C:\Users\23159\.cyberboss\accounts\`（已扫码账号 `97b10c7063a3-im.bot`）
- `C:\Users\23159\.cyberboss\diary\`（最后 2026-08-25）、`reports\index.json`（全部 pending/running）
- `checkin-config.json` 不存在（→ 默认 3–60 分钟生效）

**构建与版本**
- `dist/win-unpacked/resources/app.asar`（SHA-256 `EB0D3E8D…B020A8B`，2026-09-04）
- `dist-release-v0.1.0/CyberBoss-Setup-v0.1.0.exe`（2026-08-30，品牌不一致）
- `git log`：`a57c706` / `474880e`（2026-09-08）晚于打包时间
- `docs/audits/2026-09-07-aidy-project-tools-capability-parity.md`（前次审计，含 hash 对照）

**测试**
- `node --test "test/**/*.test.js"` → 575 / 562 pass / 4 fail / 8 cancelled / 1 skipped
