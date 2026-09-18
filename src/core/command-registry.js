// Command registry.
//
// Two audiences, two help texts:
//   - weixin  : the person Aidy is supervising. Chinese, short, only the commands
//               a non-developer actually needs. Developer commands are hidden
//               behind "/help all".
//   - terminal: the developer running Aidy from source.
const AUDIENCE_USER = "user";
const AUDIENCE_DEVELOPER = "developer";

const COMMAND_GROUPS = [
  {
    id: "lifecycle",
    label: "运行与诊断",
    labelEn: "Lifecycle & Diagnostics",
    actions: [
      {
        action: "app.login",
        summary: "扫码登录微信并保存账号",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["login"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.accounts",
        summary: "列出本机已保存的账号",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["accounts"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.start",
        summary: "启动当前渠道与运行时主循环",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_start",
        summary: "启动共享 app-server 与共享微信桥接",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["shared start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_open",
        summary: "接入微信里当前绑定的共享会话",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["shared open"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_status",
        summary: "查看共享 app-server 与桥接状态",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["shared status"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.doctor",
        summary: "打印当前配置、边界与会话状态",
        audience: AUDIENCE_DEVELOPER,
        terminal: ["doctor"],
        weixin: [],
        status: "active",
      },
      // No entry point exposes these two; they used to appear in help anyway,
      // which told users about capabilities they could not reach.
      {
        action: "system.send",
        summary: "向内部系统队列写入一条不可见的触发消息",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "system.checkin_poller",
        summary: "按随机间隔产生主动查岗触发",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
    ],
  },
  {
    id: "workspace",
    label: "工作目录与会话",
    labelEn: "Workspace & Thread",
    actions: [
      {
        action: "workspace.bind",
        summary: "把当前聊天绑定到一个工作目录",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/bind"],
        status: "active",
      },
      {
        action: "workspace.status",
        summary: "查看当前目录、会话、模型与上下文用量",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/status"],
        status: "active",
      },
      {
        action: "thread.new",
        summary: "开一个全新的会话",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/new"],
        status: "active",
      },
      {
        action: "thread.reread",
        summary: "让当前会话重新读取最新指令",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/reread"],
        status: "active",
      },
      {
        action: "thread.compact",
        summary: "压缩当前会话上下文",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/compact"],
        status: "active",
      },
      {
        action: "thread.switch",
        summary: "切换到指定会话",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/switch <会话ID>"],
        status: "active",
      },
      {
        action: "thread.stop",
        summary: "停止当前会话里正在跑的任务",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/stop"],
        status: "active",
      },
      {
        action: "system.checkin_range",
        summary: "调整我多久来问你一次（三档：轻陪伴 / 标准 / 紧密，也可以写 15-45）",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/checkin"],
        status: "active",
      },
      {
        action: "channel.chunk_min",
        summary: "调整微信回复中短碎片的合并长度",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/chunk <数字>"],
        status: "active",
      },
    ],
  },
  {
    id: "approval",
    label: "授权与操控",
    labelEn: "Approvals & Control",
    actions: [
      {
        action: "approval.accept_once",
        summary: "这次允许执行",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/yes"],
        status: "active",
      },
      {
        action: "approval.accept_workspace",
        summary: "以后同类操作都直接允许",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/always"],
        status: "active",
      },
      {
        action: "approval.reject_once",
        summary: "拒绝这次执行",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/no"],
        status: "active",
      },
    ],
  },
  {
    id: "capabilities",
    label: "其他能力",
    labelEn: "Capabilities",
    actions: [
      {
        action: "model.inspect",
        summary: "查看当前使用中的模型（切换请到桌面控制中心）",
        audience: AUDIENCE_DEVELOPER,
        terminal: [],
        weixin: ["/model"],
        status: "active",
      },
      {
        action: "channel.send_file",
        summary: "把一个本地文件作为附件发回当前聊天",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.write",
        summary: "把当前上下文写入时间轴",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.build",
        summary: "构建静态时间轴站点",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.serve",
        summary: "启动静态时间轴站点服务",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.dev",
        summary: "启动热重载的时间轴开发服务",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "timeline.screenshot",
        summary: "截取时间轴截图",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "reminder.create",
        summary: "创建一个提醒并交给调度器",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "diary.append",
        summary: "追加一条日记",
        audience: AUDIENCE_DEVELOPER,
        hidden: true,
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "app.star",
        summary: "在 GitHub 上给这个项目点个星",
        audience: AUDIENCE_USER,
        terminal: [],
        weixin: ["/star"],
        status: "active",
      },
      {
        action: "app.help",
        summary: "查看我认得的命令",
        audience: AUDIENCE_USER,
        terminal: ["help"],
        weixin: ["/help"],
        status: "active",
      },
    ],
  },
];

function listCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    actions: group.actions.map((action) => ({ ...action })),
  }));
}

function buildTerminalHelpText() {
  const lines = [
    "Usage: cyberboss <command>",
    "",
    "Current terminal commands:",
    "  cyberboss start        start the WeChat bridge and runtime loop",
    "  cyberboss login        start WeChat QR login",
    "  cyberboss accounts     list locally saved accounts",
    "  cyberboss doctor       print current config and thread state",
    "  npm run shared:start   start the shared app-server and WeChat bridge",
    "  npm run shared:open    attach to the shared thread currently bound in WeChat",
    "  npm run shared:status  show shared bridge status",
  ];

  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => (
      action.status === "active" && !action.hidden && action.terminal.length
    ));
    if (!activeActions.length) {
      continue;
    }
    lines.push(`- ${group.labelEn || group.label}`);
    for (const action of activeActions) {
      lines.push(`  ${formatTerminalExamples(action)}  ${action.summary}`);
    }
  }

  lines.push("");
  lines.push("Cyberboss capability operations are exposed to models as project tools, not terminal subcommands.");
  return lines.join("\n");
}

/**
 * WeChat help text. Defaults to the user tier: only commands a supervised
 * person needs, phrased around what they want to happen. Pass
 * `{ includeDeveloper: true }` (or send "/help all") to see everything.
 */
function buildWeixinHelpText({ includeDeveloper = false } = {}) {
  const lines = ["💡 我认得的命令："];
  lines.push("");
  lines.push("其实不用记命令——直接说人话就行，比如：");
  lines.push("  “一小时后问我简历写了没”");
  lines.push("  “今晚十点提醒我吃药”");

  let hasUserGroup = false;
  for (const group of COMMAND_GROUPS) {
    const activeActions = selectHelpActions(group, { includeDeveloper, audience: AUDIENCE_USER });
    if (!activeActions.length) {
      continue;
    }
    hasUserGroup = true;
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${group.label}】`);
    for (const action of activeActions) {
      lines.push(`  ${actionEmoji(action)} ${action.weixin.join(", ")} — ${action.summary}`);
    }
  }
  if (!hasUserGroup) {
    return lines.join("\n");
  }

  if (!includeDeveloper) {
    lines.push("");
    lines.push("想看全部命令（含开发者选项），发 /help all");
    return lines.join("\n");
  }

  for (const group of COMMAND_GROUPS) {
    const activeActions = selectHelpActions(group, { includeDeveloper: true, audience: AUDIENCE_DEVELOPER });
    if (!activeActions.length) {
      continue;
    }
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${group.label} · 进阶】`);
    for (const action of activeActions) {
      lines.push(`  ${actionEmoji(action)} ${action.weixin.join(", ")} — ${action.summary}`);
    }
  }
  return lines.join("\n");
}

function selectHelpActions(group, { includeDeveloper = false, audience = AUDIENCE_USER } = {}) {
  return group.actions.filter((action) => {
    if (action.status !== "active" || action.hidden || !action.weixin.length) return false;
    if (includeDeveloper) return action.audience === audience;
    return action.audience === AUDIENCE_USER;
  });
}

function groupEmoji(groupId) {
  switch (groupId) {
    case "lifecycle": return "🔄";
    case "workspace": return "📁";
    case "approval": return "🔐";
    case "capabilities": return "⚡️";
    default: return "•";
  }
}

function actionEmoji(action) {
  switch (action.action) {
    case "workspace.bind": return "📍";
    case "workspace.status": return "📊";
    case "thread.new": return "🆕";
    case "thread.reread": return "🔄";
    case "thread.compact": return "🗜️";
    case "thread.switch": return "🔀";
    case "thread.stop": return "⏹️";
    case "system.checkin_range": return "⏰";
    case "approval.accept_once": return "✅";
    case "approval.accept_workspace": return "💡";
    case "approval.reject_once": return "❌";
    case "model.inspect": return "🤖";
    case "app.help": return "❓";
    case "app.star": return "⭐️";
    default: return "•";
  }
}

module.exports = {
  AUDIENCE_DEVELOPER,
  AUDIENCE_USER,
  buildTerminalHelpText,
  buildWeixinHelpText,
  listCommandGroups,
};

function formatTerminalExamples(action) {
  const terminal = Array.isArray(action?.terminal) ? action.terminal : [];
  if (!terminal.length) {
    return "";
  }
  return terminal.map((commandText) => toTerminalCommandExample(commandText)).join(", ");
}

function toTerminalCommandExample(commandText) {
  const normalized = typeof commandText === "string" ? commandText.trim() : "";
  switch (normalized) {
    case "login":
    case "accounts":
    case "start":
    case "doctor":
    case "help":
      return `cyberboss ${normalized}`;
    case "shared start":
    case "shared open":
    case "shared status":
      return `npm run ${normalized.replace(" ", ":")}`;
    case "start --checkin":
      return "cyberboss start --checkin";
    default:
      return normalized;
  }
}
