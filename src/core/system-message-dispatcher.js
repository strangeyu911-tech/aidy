class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
      systemMessage: { ...message },
    };
  }
}

/*
 * The prose around the trigger is written as a short log entry rather than a
 * command body, and this is deliberate:
 *
 *  - proactive turns now share the user's session (route A), so this text stays
 *    in the transcript and is read back by every later turn. A short log entry
 *    is cheap to re-read and does not push the model into a command register,
 *    which is what made the old "SYSTEM ACTION MODE" frame leak into replies.
 *  - the JSON action contract itself is unchanged; `stream-delivery` still
 *    parses exactly one `{"action":...}` object.
 *  - the wording is kept free of mutation verbs because `action-evidence`
 *    derives `requiresEvidence` from this text by keyword. A stray 完成/修改
 *    here would silently switch the action-claim guard on for check-ins.
 */
function buildSystemInboundText(text, createdAt = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const sections = [
    ...(localTime ? [`[${localTime}]`] : []),
    "系统查岗（你自己的主动触达回合，用户没有说话）",
    "",
    "可以顺手做的后台工作：时间轴、日记、提醒、定位。",
    "收尾只输出一个 JSON 对象，用来决定要不要联系用户：",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<一条自然、简短的微信消息>\"}",
    "有动作就用 send_message 简短自然地说明你做了什么或有什么变化；什么都没做就用 silent。",
    "不要 markdown 代码块，不要推理，不要在 JSON 之外写任何文字。",
  ];
  if (body) {
    sections.push("", "背景：", body);
  }
  return sections.join("\n").trim();
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
