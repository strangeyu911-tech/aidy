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

- [ ] 双击 `CyberBoss-Setup-v0.1.0.exe` 可完成安装
- [ ] 安装过程不要求 GitHub、Git、Node.js、npm、Python 或 `npm install`
- [ ] 开始菜单或桌面可启动 CyberBoss
- [ ] “AI 模型”中能发现 WorkBuddy / CodeBuddy
- [ ] WorkBuddy 模型检查通过并能保存、激活
- [ ] “微信”中能打开登录窗口
- [ ] 手机微信扫码并确认成功
- [ ] 回到 CyberBoss 后微信状态显示已登录

## 首次消息

- [ ] 点击“启动 CyberBoss”成功
- [ ] 状态显示正在运行或等价的健康状态
- [ ] 微信发送一条普通文本消息
- [ ] 微信在合理时间内收到一条正常、非错误提示的回复
- [ ] 回复没有泄露服务密码、访问令牌、内部路径或调试输出

## 重启与退出

- [ ] 从托盘选择退出后，CyberBoss 进程和桥接进程均停止
- [ ] 再次从开始菜单或桌面启动成功
- [ ] 已保存的 WorkBuddy 配置仍然存在
- [ ] 已保存的微信登录状态仍然存在，或能明确提示重新扫码
- [ ] 再次点击启动后，微信消息仍可正常收发

## 失败记录

- 安装包文件名和 SHA-256：
- Windows 版本：
- WorkBuddy 版本：
- CyberBoss 版本：
- 首次回复耗时：
- 失败步骤及完整用户可见提示：
- 是否需要代理或 GitHub：
