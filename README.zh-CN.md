# Aidy（艾迪）

**Aidy 是一个会主动来找你的 AI 监督陪伴 Agent，尤其适合 ADHD、执行功能困难、容易拖延或分心的场景。** 它通过主动提醒、随机查岗和 checkpoint 跟进任务，并在微信里主动触达你。

普通 AI 等你打开、提问；Aidy 的重点是主动出现。对「知道该做什么，却很难开始、容易跑偏或忘记回来」的人来说，微信不是一个普通聊天机器人入口，而是让 Aidy 能在日常生活中找到你的触达渠道。

## 核心体验

- **主动提醒**：在约定时间回来提醒或问进展。
- **随机查岗**：在设定区间内随机 check-in，询问你此刻在做什么，降低机械应付提醒的可能。
- **Checkpoint 跟进**：围绕任务的关键时间点主动追问，并处理静默时段、过期、合并与队列边界。
- **微信主动触达**：不用持续打开另一个 AI App；Aidy 把提醒、查岗和跟进送到你本来就会看到的地方。
- **WorkBuddy runtime**：默认推荐的 Agent / 模型能力来源；也可按需要配置其他兼容 runtime 或自定义 API。

> Aidy 不是医疗工具，不提供 ADHD 诊断、治疗或疗效承诺。

workspace / thread、diary / timeline、MCP、文件或媒体等属于底层或高级兼容能力，不是当前首页宣称已经验证的核心用户体验。

完整的产品说明、安装步骤、使用与隐私边界请见 [README.md](./README.md) 和 [INSTALL.md](./INSTALL.md)。

## Upstream、Credits 与 License

Aidy 是 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss) 的 derivative work。感谢原项目提供核心架构、微信 Agent bridge 与主动监督设计基础；本仓库保留 [AGPLv3 License](./LICENSE)，使用、修改或再发布时请保留许可证与 upstream attribution。
