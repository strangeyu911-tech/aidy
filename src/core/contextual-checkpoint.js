const ACTIVITY_PATTERNS = [
  { key: "meal", title: "吃饭", pattern: /(去|要|准备|正在)?(吃饭|吃个饭|吃东西|用餐|午饭|晚饭|早饭)/ },
  { key: "shower", title: "洗澡", pattern: /(去|要|准备|正在)?(洗澡|冲澡|洗个澡)/ },
];

function inferContextualCheckpoint(text, { now = new Date(), durations = { meal: 30, shower: 30 } } = {}) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized || hasExplicitTime(normalized)) return null;
  const activity = ACTIVITY_PATTERNS.find((item) => item.pattern.test(normalized));
  if (!activity) return null;
  const minutes = normalizeMinutes(durations?.[activity.key], 30);
  const dueAt = new Date(now.getTime() + minutes * 60_000);
  return {
    canonicalTaskId: `context:${activity.key}`,
    title: `${activity.title}后跟进`,
    source: "context",
    dueAt: dueAt.toISOString(),
    timezone: "Asia/Shanghai",
    prompt: `用户之前说要${activity.title}，现在请自然地问一下进展。`,
    announcement: buildAnnouncement(minutes),
    activity: activity.key,
  };
}

function hasExplicitTime(text) {
  return /(\d+\s*(分钟|分|小时|个小时)后)|(\d{1,2}[:：点时]\d{0,2})|(今晚|明早|明天|下午|上午|中午|凌晨)/.test(text);
}

function buildAnnouncement(minutes) {
  if (minutes === 30) return "好，你先去吧，半小时后我来找你。";
  if (minutes % 60 === 0) return `好，你先去吧，${minutes / 60}小时后我来找你。`;
  return `好，你先去吧，${minutes}分钟后我来找你。`;
}

function normalizeMinutes(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = { ACTIVITY_PATTERNS, hasExplicitTime, inferContextualCheckpoint };
