const { DEFAULT_QUIET_HOURS, isWithinQuietHours } = require("./supervision-policy");

// Chinese time expressions. This parser is the accuracy boundary for the whole
// "just tell Aidy what you want" flow, so it errs on the side of recognising
// more phrasings, and the reply always echoes back the exact date and time it
// recorded so a mis-parse is immediately visible to the user.
const LOCAL_TIME_ZONE = "Asia/Shanghai";

const DAY_QUALIFIER = "今天|今晚|今早|今儿|明天|明早|明晚|后天|大后天|上午|早上|早晨|中午|下午|傍晚|晚上|夜里|夜里|凌晨|半夜";

const CHINESE_DIGITS = Object.freeze({
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
});

const RELATIVE_UNIT_MINUTES = Object.freeze({
  分钟: 1,
  分: 1,
  小时: 60,
  钟头: 60,
  刻钟: 15,
});

function extractExplicitCheckpoint(text, { now = new Date(), quietHours = DEFAULT_QUIET_HOURS } = {}) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return null;

  let dueAt = null;
  let matchedText = "";
  let explicitClockTime = false;

  // Absolute clock times are parsed first: "8点30分后提醒我" mentions a real time
  // and would otherwise be misread as "30 minutes from now" by the relative rule.
  const absolute = parseAbsoluteClockTime(normalized, now);
  if (absolute) {
    dueAt = absolute.dueAt;
    matchedText = absolute.matchedText;
    explicitClockTime = true;
  }

  if (!dueAt) {
    const relative = parseRelativeOffset(normalized, now);
    if (relative) {
      dueAt = relative.dueAt;
      matchedText = relative.matchedText;
    }
  }

  if (!dueAt) return null;
  const taskText = normalizeTaskText(normalized.replace(matchedText, " "));
  const title = taskText ? truncate(taskText, 36) : "按约定时间跟进";
  const canonicalTaskId = `conversation:${normalizeCanonicalTitle(taskText || "follow-up")}`;

  // The user asked for this moment themselves, so it overrides the sleep window
  // instead of being deferred or dropped. Quiet hours only restrain Aidy's own
  // impulses, never an explicit request.
  const insideQuietHours = isWithinQuietHours(dueAt, LOCAL_TIME_ZONE, quietHours);
  const announcement = `好，我记下了，${formatDueTime(dueAt, now)}我来找你。`;

  return {
    canonicalTaskId,
    title,
    source: "conversation",
    dueAt: dueAt.toISOString(),
    timezone: LOCAL_TIME_ZONE,
    exemptQuietHours: true,
    explicitClockTime,
    prompt: `用户之前约定在这个时间跟进“${title}”。请结合最近对话自然地询问进展。`,
    announcement: insideQuietHours
      ? `${announcement}（这条落在你的静默时段里，是你自己定的，我照发，不会跳过。）`
      : announcement,
  };
}

function parseRelativeOffset(text, now) {
  const match = text.match(new RegExp(
    `(?:再|过|等)?\\s*([0-9]+(?:\\.[0-9]+)?|[零一二两三四五六七八九十半]+)\\s*(?:个)?\\s*(分钟|分|小时|钟头|刻钟)\\s*(?:后|以后|之后)`
  ));
  if (!match) return null;

  const amount = parseChineseNumber(match[1]);
  const unitMinutes = RELATIVE_UNIT_MINUTES[match[2]];
  if (amount === null || amount <= 0 || !unitMinutes) return null;

  const minutes = amount * unitMinutes;
  // A week is the practical horizon; beyond that a "reminder" is a calendar
  // entry and belongs in a different feature.
  if (minutes > 7 * 24 * 60) return null;

  return {
    dueAt: new Date(now.getTime() + minutes * 60_000),
    matchedText: match[0],
  };
}

function parseAbsoluteClockTime(text, now) {
  const qualifierMatch = text.match(new RegExp(`(${DAY_QUALIFIER})`));
  const qualifier = qualifierMatch ? qualifierMatch[1] : "";

  let hour = null;
  let minute = 0;
  let matchedText = "";

  const colonForm = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (colonForm) {
    hour = Number(colonForm[1]);
    minute = Number(colonForm[2]);
    matchedText = colonForm[0];
  } else {
    const pointForm = text.match(new RegExp(
      `([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})\\s*(?:点|时)\\s*(半|一刻|三刻|[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})?`
    ));
    if (pointForm) {
      hour = parseChineseNumber(pointForm[1]);
      const tail = pointForm[2];
      if (tail === "半") minute = 30;
      else if (tail === "一刻") minute = 15;
      else if (tail === "三刻") minute = 45;
      else if (tail) {
        const parsedTail = parseChineseNumber(tail);
        minute = parsedTail === null ? 0 : parsedTail;
      }
      matchedText = pointForm[0];
    }
  }

  if (hour === null || !Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

  if (/下午|晚上|今晚|明晚|傍晚|夜里|半夜/.test(qualifier) && hour < 12) hour += 12;
  if (/中午/.test(qualifier) && hour < 11) hour += 12;
  if (/凌晨|半夜/.test(qualifier) && hour === 12) hour = 0;
  if (hour > 23) return null;

  const dueAt = new Date(now);
  dueAt.setSeconds(0, 0);
  dueAt.setHours(hour, minute, 0, 0);

  const startsTomorrow = /明天|明早|明晚/.test(qualifier);
  if (startsTomorrow) {
    dueAt.setDate(dueAt.getDate() + 1);
  } else if (/后天/.test(qualifier) && !/大后天/.test(qualifier)) {
    dueAt.setDate(dueAt.getDate() + 2);
  } else if (/大后天/.test(qualifier)) {
    dueAt.setDate(dueAt.getDate() + 3);
  } else if (/今天|今晚|今早|今儿|上午|早上|早晨|中午|下午|傍晚|晚上|夜里|凌晨|半夜/.test(qualifier)) {
    // Anchored to today by the user's own words. If that moment already passed,
    // roll forward one day rather than firing in the past.
    if (dueAt <= now) dueAt.setDate(dueAt.getDate() + 1);
  } else if (dueAt <= now) {
    dueAt.setDate(dueAt.getDate() + 1);
  }

  return { dueAt, matchedText };
}

/** Parses Arabic or Chinese numerals, including 半 / 十 / 二十一 style forms. */
function parseChineseNumber(value) {
  const normalized = String(value === undefined || value === null ? "" : value).trim();
  if (!normalized) return null;
  if (/^[0-9]+$/.test(normalized)) return Number.parseInt(normalized, 10);
  if (normalized === "半") return 0.5;
  if (normalized === "十") return 10;

  const teens = normalized.match(/^十([零一二两三四五六七八九])$/);
  if (teens) return 10 + CHINESE_DIGITS[teens[1]];

  const tens = normalized.match(/^([一二两三四五六七八九])十([零一二两三四五六七八九])?$/);
  if (tens) return CHINESE_DIGITS[tens[1]] * 10 + (tens[2] ? CHINESE_DIGITS[tens[2]] : 0);

  const single = normalized.match(/^([零一二两三四五六七八九])$/);
  if (single) return CHINESE_DIGITS[single[1]];

  return null;
}

function normalizeTaskText(value) {
  return String(value || "")
    .replace(/^(那|那么|好|好的|可以|请|你)?\s*(到时候)?\s*(提醒我|叫我|喊我|查我|来找我|问我|监督我|催我|通知我)?/g, "")
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

module.exports = { extractExplicitCheckpoint, formatDueTime, normalizeCanonicalTitle, parseChineseNumber };
