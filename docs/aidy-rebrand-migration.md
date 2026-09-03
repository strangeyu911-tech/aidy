# Aidy（艾迪）品牌与兼容迁移说明

Originally forked from [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss). 本项目经过较大幅度二次开发，以 Aidy（艾迪）这一新产品名继续维护。

## 用户可见变化

- Windows 产品名、窗口标题、托盘菜单、设置和引导文案使用 Aidy / 艾迪。
- 安装包、portable 包、解包目录中的 executable 和 Start Menu 快捷方式使用 `Aidy`。
- GitHub 仓库地址为 `https://github.com/strangeyu911-tech/aidy`。

## 保留的兼容标识

以下标识刻意保留，不代表品牌遗漏：

- `package.json` 的 npm name `cyberboss` 与 `bin/cyberboss*` CLI 入口；
- `com.cyberboss.desktop`、`CyberBoss.Desktop` 及现有内部 IPC / MCP / serialized key；
- `CYBERBOSS_*` 环境变量；
- `%USERPROFILE%\\.cyberboss` 业务状态目录和 `%APPDATA%\\CyberBoss` Electron userData 目录；
- `cyberboss-backup` 备份格式、历史 migration ID、upstream attribution 与历史设计记录。

这次迁移没有改名或删除这些路径和变量，因此不需要把现有用户数据“move then hope”。新版本显式把 Electron userData 继续固定到旧目录，既有微信状态、WorkBuddy 配置、凭据、队列和 scheduler 状态继续由原路径读取。

## Windows shortcut / task

新版本生成 `Aidy.lnk`，目标为 `Aidy.exe`；同步脚本会在确认新快捷方式已写入后删除同一 Start Menu 目录中旧的 `CyberBoss.lnk`。Windows 自动启动任务使用 `\\Aidy\\Aidy 桌面控制中心`，并在迁移时清理旧的 CyberBoss 任务名。

如果迁移失败，脚本不会删除旧业务数据；旧的 `~/.cyberboss` 目录和兼容标识仍保留。
