"use strict";

const crypto = require("node:crypto");

const { AtomicJsonStore } = require("./atomic-json-store");
const { stripInternalContextBlocks } = require("./internal-context-blocks");

const SCHEMA_VERSION = 1;
/** Hard cap on retained entries; the day query is the real filter. */
const MAX_ENTRIES = 200;
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** The same text re-sent inside this window (retry, duplicate send) is one entry. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_DIGEST_MAX_ENTRIES = 6;
const DEFAULT_DIGEST_MAX_CHARS = 700;
const DEFAULT_DIGEST_ENTRY_MAX_CHARS = 160;

const LOCAL_TIME_ZONE = "Asia/Shanghai";

/**
 * Record of the proactive (assistant-initiated) messages that actually reached
 * the user, so a later user turn can be told what was already said.
 *
 * The recorded text is the model's final delivered text, never the queued
 * message: a queued message carries the internal context blocks that were
 * appended for the model and must not be echoed back into a user turn.
 *
 * This is the RC1 mitigation only. It does not merge the system scope into the
 * user scope; it makes the split scope visible to the user turn.
 */
class ProactiveDeliveryLog {
  constructor({ filePath, now = () => new Date() } = {}) {
    this.now = now;
    this.store = new AtomicJsonStore({
      filePath,
      defaultValue: { schemaVersion: SCHEMA_VERSION, entries: [] },
      normalize: normalizeLogState,
    });
  }

  record({ senderId, text, deliveredAt = "", sourceId = "" } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedText = stripInternalContextBlocks(text);
    if (!normalizedSenderId || !normalizedText) {
      return null;
    }
    const at = normalizeIso(deliveredAt) || this.now().toISOString();
    const state = this.store.read();
    const retained = pruneEntries(state.entries, this.now());

    const duplicate = retained.find((entry) => entry.senderId === normalizedSenderId
      && entry.text === normalizedText
      && Math.abs(Date.parse(entry.deliveredAt) - Date.parse(at)) <= DUPLICATE_WINDOW_MS);
    if (duplicate) {
      return duplicate;
    }

    const entry = {
      id: crypto.randomUUID(),
      senderId: normalizedSenderId,
      text: normalizedText,
      sourceId: normalizeText(sourceId),
      deliveredAt: at,
    };
    this.store.write({
      schemaVersion: SCHEMA_VERSION,
      entries: [...retained, entry].slice(-MAX_ENTRIES),
    });
    return entry;
  }

  /** Proactive messages delivered to `senderId` on the local day of `now`. */
  listDeliveredForDay({ senderId, now = this.now() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedSenderId) {
      return [];
    }
    const day = formatLocalDate(now);
    return this.store.read().entries
      .filter((entry) => entry.senderId === normalizedSenderId
        && formatLocalDate(new Date(entry.deliveredAt)) === day)
      .sort(compareByDeliveredAt);
  }

  /**
   * Digest text for a user turn, or null when there is nothing to report.
   * Returns `{ text, entryCount, charLength }` so the caller can log sizes
   * without logging message bodies.
   */
  buildUserTurnDigest({ senderId, now = this.now(), ...options } = {}) {
    const entries = this.listDeliveredForDay({ senderId, now });
    return buildProactiveDeliveryDigest(entries, { now, ...options });
  }
}

/**
 * Format the digest. `entries` are already delivered assistant messages; the
 * result is deliberately phrased as a note about the assistant's own outbound
 * messages so the model does not read it as something the user said.
 */
function buildProactiveDeliveryDigest(entries, {
  now = new Date(),
  maxEntries = DEFAULT_DIGEST_MAX_ENTRIES,
  maxChars = DEFAULT_DIGEST_MAX_CHARS,
  entryMaxChars = DEFAULT_DIGEST_ENTRY_MAX_CHARS,
} = {}) {
  const usable = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const deliveredAt = normalizeIso(entry?.deliveredAt);
      const text = stripInternalContextBlocks(entry?.text).replace(/\s*\n+\s*/g, " ").trim();
      if (!deliveredAt || !text) {
        return null;
      }
      return { deliveredAt, text: text.slice(0, entryMaxChars) };
    })
    .filter(Boolean)
    .sort(compareByDeliveredAt);
  if (!usable.length) {
    return null;
  }

  const header = [
    "===== 本日已发出的主动消息（系统记录，非用户发言）=====",
    "下面是你今天已经通过微信主动发给该用户的消息，用户已经看过了。",
    "不要把本轮当成初次接触，不要重复、也不要重新宣布下面已经说过的内容；顺着已有进展往下说。",
  ];
  const headerText = header.join("\n");
  const budget = Math.max(0, Number(maxChars) - headerText.length);

  const lines = [];
  let used = 0;
  for (const entry of usable.slice(-Math.max(1, Number(maxEntries) || 1)).reverse()) {
    const line = `- ${formatClock(entry.deliveredAt, now)} ${entry.text}`;
    if (used + line.length + 1 > budget) {
      break;
    }
    lines.unshift(line);
    used += line.length + 1;
  }
  if (!lines.length) {
    return null;
  }

  const text = [...header, ...lines].join("\n");
  return { text, entryCount: lines.length, charLength: text.length };
}

function pruneEntries(entries, now) {
  const cutoff = now.getTime() - RETENTION_MS;
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => Date.parse(entry?.deliveredAt || "") >= cutoff)
    .slice(-MAX_ENTRIES);
}

function normalizeLogState(value) {
  const entries = (Array.isArray(value?.entries) ? value.entries : [])
    .map(normalizeEntry)
    .filter(Boolean);
  return { schemaVersion: SCHEMA_VERSION, entries };
}

function normalizeEntry(value) {
  const senderId = normalizeText(value?.senderId);
  const text = normalizeText(value?.text);
  const deliveredAt = normalizeIso(value?.deliveredAt);
  if (!senderId || !text || !deliveredAt) {
    return null;
  }
  return {
    id: normalizeText(value?.id),
    senderId,
    text,
    sourceId: normalizeText(value?.sourceId),
    deliveredAt,
  };
}

function compareByDeliveredAt(left, right) {
  return Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt);
}

function formatClock(value, now = new Date()) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: LOCAL_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
  return formatLocalDate(parsed) === formatLocalDate(now) ? time : `${formatLocalDate(parsed)} ${time}`;
}

function formatLocalDate(date) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function normalizeIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_DIGEST_ENTRY_MAX_CHARS,
  DEFAULT_DIGEST_MAX_CHARS,
  DEFAULT_DIGEST_MAX_ENTRIES,
  MAX_ENTRIES,
  ProactiveDeliveryLog,
  buildProactiveDeliveryDigest,
};
