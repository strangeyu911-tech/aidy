# Aidy（艾迪）v0.1.0 安装说明

这份说明只面向 Windows 普通用户。安装包和本文件放在同一个本地目录即可；不需要 GitHub、Git、Node.js、npm、Python 或开发仓库。

## 开始前

请确认：

1. Windows 10/11 64 位。
2. 已安装并登录 WorkBuddy。WorkBuddy 必须带有可用的 CodeBuddy 命令行组件；艾迪会自动查找它。
3. 手机微信可用于扫描二维码。无需安装微信开发环境；不要求安装 Git、Node.js、npm 或 Python。

WorkBuddy 负责模型账号和模型服务，艾迪不会复制或读取 WorkBuddy 的登录凭据。

## 安装与启动

1. 双击 `Aidy-Setup-v0.1.0.exe`，按向导完成安装。
2. 从开始菜单或桌面打开 `Aidy`（艾迪）。
3. 在“AI 模型”步骤选择“WorkBuddy / CodeBuddy”，点击检查；看到版本和可用状态后保存并激活。
4. 在“微信”步骤点击“连接微信”，在弹出的窗口中用手机微信扫码并确认登录；完成后关闭登录窗口，回到艾迪点击检查。
5. 点击“启动艾迪”。
6. 用已登录微信向机器人发送一句简单消息，确认收到正常回复。

如果安装包由 WorkBuddy 辅助安装：把本地 `Aidy-Setup-v0.1.0.exe` 和本文件一起交给 WorkBuddy，并要求它只使用本地文件，不要读取 GitHub README，也不要执行 `git clone`、`npm install` 或构建命令。

## 需要联网的部分

安装器本身不需要联网。首次使用仍需要：

- WorkBuddy 登录、模型服务和 CodeBuddy 公共服务可访问；
- 微信二维码登录及消息收发可访问 `https://ilinkai.weixin.qq.com` 和 `https://novac2c.cdn.weixin.qq.com/c2c`；
- Windows 防火墙允许艾迪访问网络。艾迪与其子进程只使用本机回环地址进行控制通信。

网络异常时，先确认 WorkBuddy 已登录，再在艾迪中重新检查模型和微信状态。不要为了安装艾迪配置代理、Git 或开发环境。

## 退出与再次启动

关闭窗口后艾迪可能继续在系统托盘运行；需要完全停止时在托盘菜单选择“退出”。之后从开始菜单或桌面再次打开，已保存的模型和微信登录状态会继续使用。
