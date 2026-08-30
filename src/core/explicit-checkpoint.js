function extractExplicitCheckpoint(text, { now = new Date() } = {}) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return null;

  const relative = normalized.match(/(?:再|过)?\s*(\d+(?:\.\d+)?)\s*(分钟|分|小时|个小时)后/);
  let dueAt = null;
  let matchedText = "";
  if (relative) {
    const amount = Number(relative[1]);
    const minutes = /小时/.test(relative[2]) ? amount * 60 : amount;
    if (minutes > 0 && minutes <= 7 * 24 * 60) {
      dueAt = new Date(now.getTime() + minutes * 60_000);
      matchedText = relative[0];
    }
  }

  if (!dueAt) {
    const absolute = normalized.match(/(?:(今天|今晚|明天|明早|明晚|上午|下午|中午|晚上|凌晨)\s*)?(\d{1,2})(?:点(半)|[:：点时](\d{1,2})?)/);
    if (absolute) {
      const qualifier = absolute[1] || "";
      let hour = Number(absolute[2]);
      const minute = absolute[3] === "半" ? 30 : Number(absolute[4] || 0);
      if (/下午|晚上|今晚|明晚/.test(qualifier) && hour < 12) hour += 12;
      if (/凌晨/.test(qualifier) && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        dueAt = new Date(now);
        dueAt.setSeconds(0, 0);
        dueAt.setHours(hour, minute, 0, 0);
        if (/明天|明早|明晚/.test(qualifier)) dueAt.setDate(dueAt.getDate() + 1);
        else if (!/今天|今晚|上午|下午|中午|晚上|凌晨/.test(qualifier) && dueAt <= now) dueAt.setDate(dueAt.getDate() + 1);
        matchedText = absolute[0];
      }
    }
  }

  if (!dueAt) return null;
  const taskText = normalizeTaskText(normalized.replace(matchedText, " "));
  const title = taskText ? truncate(taskText, 36) : "按约定时间跟进";
  const canonicalTaskId = `conversation:${normalizeCanonicalTitle(taskText || "follow-up")}`;
  return {
    canonicalTaskId,
    title,
    source: "conversation",
    dueAt: dueAt.toISOString(),
    timezone: "Asia/Shanghai",
    prompt: `用户之前约定在这个时间跟进“${title}”。请结合最近对话自然地询问进展。`,
    announcement: `好，我记下了，${formatDueTime(dueAt, now)}我来找你。`,
  };
}

function normalizeTaskText(value) {
  return String(value || "")
    .replace(/^(那|那么|好|好的|可以|请|你)?\s*(到时候)?\s*(提醒我|叫我|查我|来找我|问我|监督我)?/g, "")
    .replace(/[，。！？,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCanonicalTitle(value) {
  const normalized = String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 48);
  return normalized || "follow-up";
}

function formatDueTime(dueAt, now) {
  const sameDate = dueAt.getFullYear() === now.getFullYear() && dueAt.getMonth() === now.getMonth() && dueAt.getDate() === now.getDate();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = dueAt.getFullYear() === tomorrow.getFullYear() && dueAt.getMonth() === tomorrow.getMonth() && dueAt.getDate() === tomorrow.getDate();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);
  return `${sameDate ? "今天" : isTomorrow ? "明天" : `${dueAt.getMonth() + 1}月${dueAt.getDate()}日`}${time}`;
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

module.exports = { extractExplicitCheckpoint, formatDueTime, normalizeCanonicalTitle };
