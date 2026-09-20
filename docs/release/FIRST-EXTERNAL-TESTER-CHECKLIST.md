# First External Tester Release v0.1.0 验收清单

## 测试环境

- [ ] 全新 Windows 10/11 64 位用户环境
- [ ] 无 Git
- [ ] 无 Node.js / npm 开发环境
- [ ] 无 Python 开发环境
- [ ] 无代理
- [ ] WorkBuddy 已安装并已登录
- [ ] 手机微信可扫码
- [ ] 测试包和 `INSTALL.md` 已通过本地文件交给测试用户或 WorkBuddy

## 安装与配置

- [ ] 双击 `Aidy-Setup-v0.1.0.exe` 可完成安装
- [ ] 安装过程不要求 GitHub、Git、Node.js、npm、Python 或 `npm install`
- [ ] 开始菜单或桌面可启动 Aidy（艾迪）
- [ ] “AI 模型”中能发现 WorkBuddy / CodeBuddy
- [ ] WorkBuddy 模型检查通过并能保存、激活
- [ ] “微信”中能打开登录窗口
- [ ] 二维码直接显示在艾迪窗口里，**不出现黑色命令行窗口**，也不出现 `npm` 字样
- [ ] 关闭登录窗口后，后台不再继续轮询二维码
- [ ] 手机微信扫码并确认成功
- [ ] 回到艾迪后微信状态显示已登录

## 首次消息

- [ ] 点击“启动艾迪”成功
- [ ] 状态显示正在运行或等价的健康状态
- [ ] 微信发送一条普通文本消息
- [ ] 微信在合理时间内收到一条正常、非错误提示的回复
- [ ] 回复没有泄露服务密码、访问令牌、内部路径或调试输出

## 重启与退出

- [ ] 从托盘选择退出后，Aidy 进程和桥接进程均停止
- [ ] 再次从开始菜单或桌面启动成功
- [ ] 已保存的 WorkBuddy 配置仍然存在
- [ ] 已保存的微信登录状态仍然存在，或能明确提示重新扫码
- [ ] 再次点击启动后，微信消息仍可正常收发

## 微信掉线时的表现

这是最容易让用户误判「这个产品不 work」的场景，必须逐条验证。

- [ ] 在手机上退出微信登录后，控制中心不再显示「运行中」而应提示需要重新扫码
- [ ] 提示里的按钮能直接打开扫码窗口
- [ ] 打印机关掉网络 30 分钟以上，顶部出现「微信连接可能已经断开」提示
- [ ] 该提示里说明排队的消息条数（若队列为空则说明这段时间的提醒没有送出）
- [ ] 恢复网络后提示自动消失，不需要重启艾迪

## 发布前自动检查

以下命令必须在出包机器上全部通过，任何一条失败都不应发布：

- [ ] `npm run check` —— 全量语法检查
- [ ] `node --test "test/**/*.test.js"` —— 单元与集成测试
- [ ] `npm run verify:desktop-boot` —— 用临时数据目录真实启动一次桌面进程，捕获渲染端错误
- [ ] `npm run verify:release-names` —— 安装包文件名与本文档一致、产物比源码新、且没有旧品牌可执行文件残留
- [ ] `npm run verify:artifacts` —— 打包产物完整性（会在临时数据目录里真实启动一次打包后的 `Aidy.exe`）

### 关于「产物比源码新」

`verify:release-names` 除了校验文件名，还会检查每个产物是否比它所包含的源码更新 ——
基准取「最近一次触及**被打包路径**（`src/`、`bin/`、`native/`、`templates/`、`package.json`）
的提交时间」与「已改动但未提交的被打包文件 mtime」中的较大值。只改文档或脚本不会让产物变「旧」。

这条检查存在的原因是一个真实的坑：`npm run desktop:package` 只构建 `nsis` 目标，
而便携版走的是另一个脚本 `npm run desktop:package:portable`。
**两个都要跑**，否则会出现「安装包是新的、便携版是几个月前的」这种组合，
而它因为文件名正确一度能骗过校验。

### 关于过期产物的隔离

历史上出现过「仓库里同时存在多个互相不一致的构建目录，其中一个装着旧品牌可执行文件」。
旧品牌产物比缺少产物更危险 —— 它看起来是可以发的。因此过期产物被集中到
`dist-quarantine/`，目录里放一个 `STALE-DO-NOT-SHIP.md` 作为**显式豁免标记**：
`verify:release-names` 会跳过带该标记的目录，否则任何 `CyberBoss*.exe` 都会让检查失败。

豁免必须是有意做出的动作：把一个装着旧品牌却没有标记的目录留在仓库里，检查仍然会失败。
这些目录已在 `.gitignore` 中（`dist/`、`dist-release*/`、`dist-quarantine/`），不会入库。

`npm run desktop:package` 在这台机器上可能以退出码 1 结束而**产物其实已经完整生成** ——
失败点在产物写完之后的临时文件清理阶段（宿主的安全删除守卫）。判断依据是日志里
`⨯ [safe-delete]…` 之后没有其它错误，且 `dist/` 下的产物时间戳是新的。另外 `&&` 断链
会让末尾的 `desktop:sync-start-menu` 静默不执行，需要手动补跑 `npm run desktop:sync-start-menu`。

## 发布 Release 与上传附件

`gh release create` 的流程是「先建草稿 → 逐个上传附件 → 最后发布」，所以上传中途中断会留下一个
**正文完好、附件为空**的草稿。附件可以后补（`node ./scripts/upload-release-assets.js`），不必重建 Release。
草稿也不出现在 `GET /releases/tags/{tag}` 里（该端点对草稿返回 404），要取草稿得走列表接口。

仓库同时有 `origin`（个人 fork）和 `upstream`（原仓库）时，**`gh` 默认会解析到 upstream**。
所有 `gh` 命令都必须显式带 `--repo <owner>/<repo>`（或先一次性 `gh repo set-default`）。
`gh release create` 还应带 `--verify-tag` —— 否则万一解析到错误的仓库，就会**在别人的仓库上建标签和 Release**。

上传大附件请用 `node ./scripts/upload-release-assets.js <tag> <文件...>`，不要用 `gh release upload`：

- `gh` 的 Go 客户端 `TLSHandshakeTimeout` 默认 10s，而国内访问 GitHub 的新建 TLS 握手常达 10~25s，会直接失败；
- 握手成功但吞吐极低时，`gh` **没有超时保护**，会静默挂住且零产出（实测盲等 1.5 小时）；
- `gh` 上传**不打印任何进度**，无法区分「正在慢慢传」和「已经死了」。

`upload-release-assets.js` 对应的措施：每 10s 打印进度、进度停滞 3 分钟即判定卡死并重试（最多 3 次）、
上传前先对 `uploads.github.com` 预建连接把握手成本前置，并在结束后**用 API 复核服务端记录的大小**
而不采信上传器的自述。

两点硬约束：GitHub 的附件上传**不支持断点续传**（只有一个裸 `POST`，无 `Content-Range`），
中断就必须从零重来；**同名附件会导致 422**，所以脚本每次上传前会先删掉同名旧附件。

### 本机链路的实测上限（2026-09-20 测量，出包前先看）

这套数字比任何脚本优化都重要 —— 它决定了「能不能传上去」：

| 项目 | 实测值 |
| --- | --- |
| 下载（`codeload.github.com`） | 稳定 **~100 KB/s** |
| 上传单条 TCP 流（`uploads.github.com`） | **~6.7 KB/s**（长时间静止但连接不死） |
| 上传单条流（Cloudflare，用于对照） | **6.7 KB/s** → 说明**不是 GitHub 的问题，是国际上行整体被限** |
| 上传 4 条并行 | **27–44 KB/s**（≈4–6×） |
| 上传 12 条并行 | **44 KB/s，不再涨** → **总闸门 ≈44 KB/s** |

推论：**单个 POST 把 121 MB 的安装包传上去在本链路不可行**（单流约 5.7 小时，且中途中断要从零重来）。
可行的替代是**分块并行**：把文件切成若干块、每块作为一个独立附件并行上传（121 MB 约 75 分钟），
因为每块可独立重传，等于变相获得断点续传；该方案已在真实端点验证通过（4×1.5 MB 全部 HTTP 201、聚合 27 KB/s）。
若测试者就在国内，**直接本地发送安装包（微信/QQ 文件传输，可续传）是最快的路径**。

⚠️ **别忘了代理变量**：本机环境变量里有 `http(s)_proxy=http://127.0.0.1:56357`，那是 WorkBuddy 沙箱代理（`sandbox-cli.exe`），
**国内出口，连不上 GitHub**（对百度返回 200、对 github.com 超时）。
`gh`（Go）和 `curl` 会自动读取这些变量，所以跑上传/测速前必须 `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`
或加 `--noproxy '*'`；`upload-release-assets.js` 用的是 Node 的 `https`，默认直连、不受影响。

## 失败记录

- 安装包文件名和 SHA-256：
- `resources/app.asar` SHA-256 和构建时间（由 `npm run verify:release-names` 打印）：
- Windows 版本：
- WorkBuddy 版本：
- Aidy 版本：
- 首次回复耗时：
- 失败步骤及完整用户可见提示：
- 是否需要代理或 GitHub：
