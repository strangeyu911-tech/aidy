const fs = require("fs");
const path = require("path");

/**
 * How long a deferred proactive reply stays worth sending.
 *
 * A proactive check-in is only useful while it is still true. "8 点了，指尖时光
 * 还没动过" delivered at 15:00 is not a late reminder, it is a false statement —
 * the model rewrites the situation from scratch on the next turn anyway, so the
 * stale copy can only contradict it. Batching several of these together (the
 * pre-fix behaviour) produced replies whose own sentences disagreed about what
 * time it was.
 *
 * Ten minutes is deliberately short. The window is measured from `createdAt`
 * (when the model wrote it), not from when the send failed, so a message that
 * was already old when it entered the queue does not get a fresh lease.
 */
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

class DeferredSystemReplyStore {
  constructor({ filePath, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    this.filePath = filePath;
    this.maxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
    this.state = { replies: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const replies = Array.isArray(parsed?.replies) ? parsed.replies : [];
      this.state = {
        replies: replies
          .map(normalizeDeferredSystemReply)
          .filter(Boolean)
          .sort(compareDeferredReplies),
      };
    } catch {
      this.state = { replies: [] };
    }
  }

  /**
   * Expiry is decided only where a decision is actually being made — at
   * `drainForSender` (the one moment a reply could reach the user) and at
   * `pruneExpired` (called once at startup). Deliberately NOT inside `load()`:
   * load runs on every enqueue and drain, so pruning there would judge every
   * entry by wall time regardless of the caller's clock, and would silently
   * couple queue maintenance to whichever code path happened to read the file.
   */
  pruneExpired(nowMs = Date.now()) {
    this.load();
    const before = this.state.replies.length;
    this.state.replies = this.state.replies.filter((reply) => !this.isExpired(reply, nowMs));
    const removed = before - this.state.replies.length;
    if (removed) {
      this.save();
    }
    return removed;
  }

  isExpired(reply, nowMs = Date.now()) {
    const createdAtMs = Date.parse(normalizeText(reply?.createdAt));
    // An unparseable timestamp cannot be judged; treat it as expired rather
    // than giving it an unlimited lease. normalizeDeferredSystemReply always
    // stamps a valid createdAt, so this only guards hand-edited files.
    if (!Number.isFinite(createdAtMs)) {
      return true;
    }
    return nowMs - createdAtMs > this.maxAgeMs;
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(reply) {
    this.load();
    const normalized = normalizeDeferredSystemReply(reply);
    if (!normalized) {
      throw new Error("invalid deferred system reply");
    }
    this.state.replies.push(normalized);
    this.state.replies.sort(compareDeferredReplies);
    this.save();
    return normalized;
  }

  /**
   * Returns only the replies that are still worth sending, and drops both the
   * returned ones and the expired ones from the queue.
   *
   * Expired entries are discarded here (not returned, not kept) because this is
   * the single point where a deferred reply would otherwise become visible to
   * the user: everything in the queue has already failed to send once, and the
   * next inbound turn is its only remaining chance. Letting an expired reply
   * through does not "save" it, it delivers a stale statement as if it were
   * current.
   *
   * Side effect: `discardedCount` is set to the number of expired entries
   * dropped by THIS call, so the caller can log them. It is always written
   * (including to 0) so a previous drain cannot be mistaken for this one.
   */
  drainForSender(accountId, senderId, nowMs = Date.now()) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const normalizedSenderId = normalizeText(senderId);
    const drained = [];
    const pending = [];
    let discarded = 0;

    for (const reply of this.state.replies) {
      if (reply.accountId !== normalizedAccountId || reply.senderId !== normalizedSenderId) {
        pending.push(reply);
        continue;
      }
      if (this.isExpired(reply, nowMs)) {
        discarded += 1;
        continue;
      }
      drained.push(reply);
    }

    this.discardedCount = discarded;

    if (drained.length || discarded) {
      this.state.replies = pending;
      this.save();
    }

    return drained;
  }
}

function normalizeDeferredSystemReply(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }
  const id = normalizeText(reply.id);
  const accountId = normalizeText(reply.accountId);
  const senderId = normalizeText(reply.senderId);
  const threadId = normalizeText(reply.threadId);
  const text = normalizeText(reply.text);
  const kind = normalizeDeferredReplyKind(reply.kind);
  const createdAt = normalizeIsoTime(reply.createdAt);
  const failedAt = normalizeIsoTime(reply.failedAt);
  const lastError = normalizeText(reply.lastError);
  if (!id || !accountId || !senderId || !text) {
    return null;
  }
  // A reply whose createdAt cannot be parsed is rejected rather than stamped
  // with "now". Stamping would turn a corrupt record into a freshly-created
  // one and hand it a full new lease — exactly the opposite of what an
  // unreadable timestamp should mean (see isExpired, which treats it as stale).
  if (reply.createdAt && !createdAt) {
    return null;
  }
  return {
    id,
    accountId,
    senderId,
    threadId,
    text,
    kind,
    createdAt: createdAt || new Date().toISOString(),
    failedAt: failedAt || new Date().toISOString(),
    lastError,
  };
}

function compareDeferredReplies(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
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

function normalizeDeferredReplyKind(value) {
  const normalized = normalizeText(value);
  return normalized === "system_reply" ? normalized : "plain_reply";
}

module.exports = { DeferredSystemReplyStore };
