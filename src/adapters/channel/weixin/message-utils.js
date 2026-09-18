const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_ITEM_TEXT = 1;
const MESSAGE_ITEM_IMAGE = 2;
const MESSAGE_ITEM_VOICE = 3;
const MESSAGE_ITEM_FILE = 4;
const MESSAGE_ITEM_VIDEO = 5;
const DEDUP_TTL_MS = 5 * 60_000;

// Core inbound normalization, shared by the per-filter dedup path and the
// standalone `normalizeInboundMessage` entry point below. Returns the same
// `{ normalized, rejectionReason }` shape; it does NOT perform dedup. Dedup is
// filter-level state and is layered on top by `createInboundFilter`.
function normalizeInboundMessageDetailed(message, config, accountId) {
  if (!message || typeof message !== "object") {
    return { normalized: null, rejectionReason: "invalid_update" };
  }
  const messageType = Number(message.message_type);
  if (messageType === MESSAGE_TYPE_BOT) {
    return { normalized: null, rejectionReason: "bot_message" };
  }
  if (messageType !== 0 && messageType !== MESSAGE_TYPE_USER) {
    return { normalized: null, rejectionReason: "unsupported_message_type" };
  }

  const senderId = normalizeText(message.from_user_id);
  if (!senderId) {
    return { normalized: null, rejectionReason: "missing_sender" };
  }

  const createdAtMs = normalizeMessageTimestampMs(message);

  const itemList = Array.isArray(message.item_list) ? message.item_list : [];
  const text = bodyFromItemList(itemList);
  const attachments = extractAttachmentItems(itemList);
  if (!text && !attachments.length) {
    return { normalized: null, rejectionReason: "empty_message" };
  }

  return { normalized: {
    provider: "weixin",
    accountId,
    workspaceId: config ? config.workspaceId : undefined,
    senderId,
    chatId: senderId,
    messageId: normalizeMessageId(message),
    threadKey: normalizeText(message.session_id),
    text,
    attachments,
    contextToken: normalizeText(message.context_token),
    receivedAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date().toISOString(),
  }, rejectionReason: null };
}

function createInboundFilter() {
  const seen = new Map();

  return {
    normalize(message, config, accountId) {
      return this.normalizeDetailed(message, config, accountId).normalized;
    },
    normalizeDetailed(message, config, accountId) {
      const result = normalizeInboundMessageDetailed(message, config, accountId);
      if (!result.normalized) {
        return result;
      }

      const createdAtMs = normalizeMessageTimestampMs(message);
      const dedupKey = buildDedupKey(message, result.normalized.senderId, createdAtMs);
      pruneSeen(seen);
      if (dedupKey && seen.has(dedupKey)) {
        return { normalized: null, rejectionReason: "duplicate" };
      }
      if (dedupKey) {
        seen.set(dedupKey, Date.now());
      }

      return { normalized: result.normalized, rejectionReason: null };
    },
  };
}

// Resolve which user id should be treated as the owner of this single-user
// assistant. The product serves exactly one person, so ownership is derived
// from the most specific configuration available:
//   1. an explicit `config.ownerUserId`
//   2. otherwise the first id in `allowedUserIds`
//   3. otherwise an empty string (no ownership info configured yet)
function resolveOwnerUserId({ config, allowedUserIds = [], accountId = "" } = {}) {
  const configured = config && typeof config === "object" ? normalizeText(config.ownerUserId) : "";
  if (configured) {
    return configured;
  }
  const candidates = Array.isArray(allowedUserIds)
    ? allowedUserIds.map((id) => normalizeText(id)).filter(Boolean)
    : [];
  if (candidates.length) {
    return candidates[0];
  }
  return "";
}

// Classify whether an inbound message originates from the owner.
// Returns `{ allowed, verified, reason }`.
//   - `verified: false` means we had no ownership information to compare
//     against (fail-open: allowed, but not verified).
//   - `verified: true` means an ownership comparison was actually performed.
// Sender ids and allowed ids are trimmed before comparison; empty allowed ids
// are ignored. The returned `reason` never contains message content.
function classifyInboundOwnership(message, { ownerId = "", allowedUserIds = [] } = {}) {
  const senderId = normalizeText(message?.from_user_id) || normalizeText(message?.senderId);
  if (!senderId) {
    return { allowed: false, verified: false, reason: "missing_sender" };
  }

  const resolvedOwnerId = normalizeText(ownerId);
  const allowedSet = (Array.isArray(allowedUserIds) ? allowedUserIds : [])
    .map((id) => normalizeText(id))
    .filter(Boolean);

  const hasOwnershipInfo = Boolean(resolvedOwnerId) || allowedSet.length > 0;
  if (!hasOwnershipInfo) {
    // No ownership information configured: fail open but mark as unverified so
    // the caller can decide whether to warn the operator.
    return { allowed: true, verified: false, reason: "no_ownership_configured" };
  }

  const isAllowed = (resolvedOwnerId && senderId === resolvedOwnerId) || allowedSet.includes(senderId);
  if (isAllowed) {
    return { allowed: true, verified: true, reason: "sender_matches_owner" };
  }
  return { allowed: false, verified: true, reason: "sender_not_owner" };
}

// Convenience boolean wrapper around `classifyInboundOwnership`.
function isOwnerInboundMessage(message, { ownerId = "", allowedUserIds = [] } = {}) {
  return classifyInboundOwnership(message, { ownerId, allowedUserIds }).allowed;
}

// Standalone normalization entry point with an optional owner gate.
// `owner`, when provided, is `{ ownerUserId, allowedUserIds, accountId }`.
// When the gate is enabled and the message is not from the owner, this returns
// `null` (the message is dropped). To avoid leaking private message bodies, no
// message content is included in the return value or any diagnostic field.
function normalizeInboundMessage(message, { config = null, accountId = "", owner = null } = {}) {
  const { normalized } = normalizeInboundMessageDetailed(message, config, accountId);
  if (!normalized) {
    return null;
  }
  if (owner) {
    const resolvedOwnerId = resolveOwnerUserId({
      config: { ownerUserId: normalizeText(owner.ownerUserId) },
      allowedUserIds: owner.allowedUserIds || [],
      accountId: normalizeText(owner.accountId) || accountId,
    });
    const ownership = classifyInboundOwnership(message, {
      ownerId: resolvedOwnerId,
      allowedUserIds: owner.allowedUserIds || [],
    });
    if (!ownership.allowed) {
      return null;
    }
  }
  return normalized;
}

function bodyFromItemList(items) {
  if (!Array.isArray(items) || !items.length) {
    return "";
  }
  for (const item of items) {
    const itemType = Number(item?.type);
    if (itemType === MESSAGE_ITEM_TEXT) {
      const text = normalizeText(item?.text_item?.text);
      if (!text) {
        continue;
      }
      const ref = item?.ref_msg;
      if (!ref || !ref.message_item || isMediaItemType(Number(ref.message_item.type))) {
        return text;
      }
      const parts = [];
      const refTitle = normalizeText(ref.title);
      if (refTitle) {
        parts.push(refTitle);
      }
      const refBody = bodyFromItemList([ref.message_item]);
      if (refBody) {
        parts.push(refBody);
      }
      if (!parts.length) {
        return text;
      }
      return `[Quoted: ${parts.join(" | ")}]\n${text}`;
    }
    if (itemType === MESSAGE_ITEM_VOICE) {
      const voiceText = normalizeText(item?.voice_item?.text);
      if (voiceText) {
        return voiceText;
      }
    }
  }
  return "";
}

function isMediaItemType(type) {
  return type === MESSAGE_ITEM_IMAGE || type === MESSAGE_ITEM_VOICE || type === MESSAGE_ITEM_FILE || type === MESSAGE_ITEM_VIDEO;
}

function extractAttachmentItems(itemList) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return [];
  }

  const attachments = [];
  for (let index = 0; index < itemList.length; index += 1) {
    const normalized = normalizeAttachmentItem(itemList[index], index);
    if (normalized) {
      attachments.push(normalized);
    }
  }
  return attachments;
}

function normalizeAttachmentItem(item, index) {
  const itemType = Number(item?.type);
  const payload = resolveAttachmentPayload(itemType, item);
  if (!payload) {
    return null;
  }

  const media = payload.media && typeof payload.media === "object"
    ? payload.media
    : {};

  return {
    kind: payload.kind,
    itemType,
    index,
    fileName: normalizeText(
      payload.body?.file_name
      || payload.body?.filename
      || item?.file_name
      || item?.filename
    ),
    sizeBytes: parseOptionalInt(
      payload.body?.len
      || payload.body?.file_size
      || payload.body?.size
      || payload.body?.video_size
      || item?.len
    ),
    directUrls: collectStringValues([
      payload.body?.url,
      payload.body?.download_url,
      payload.body?.cdn_url,
      media?.url,
      media?.download_url,
      media?.cdn_url,
    ]),
    mediaRef: {
      encryptQueryParam: normalizeText(
        media?.encrypt_query_param
        || media?.encrypted_query_param
        || payload.body?.encrypt_query_param
        || payload.body?.encrypted_query_param
        || item?.encrypt_query_param
        || item?.encrypted_query_param
      ),
      aesKey: normalizeText(
        media?.aes_key
        || payload.body?.aes_key
        || item?.aes_key
      ),
      aesKeyHex: normalizeText(
        payload.body?.aeskey
        || payload.body?.aes_key_hex
        || item?.aeskey
      ),
      encryptType: Number(
        media?.encrypt_type
        ?? payload.body?.encrypt_type
        ?? item?.encrypt_type
        ?? 1
      ),
      fileKey: normalizeText(
        media?.filekey
        || payload.body?.filekey
        || item?.filekey
      ),
    },
    rawItem: item,
  };
}

function resolveAttachmentPayload(itemType, item) {
  if (itemType === MESSAGE_ITEM_IMAGE && item?.image_item && typeof item.image_item === "object") {
    return { kind: "image", body: item.image_item, media: item.image_item.media };
  }
  if (itemType === MESSAGE_ITEM_FILE && item?.file_item && typeof item.file_item === "object") {
    return { kind: "file", body: item.file_item, media: item.file_item.media };
  }
  if (itemType === MESSAGE_ITEM_VIDEO && item?.video_item && typeof item.video_item === "object") {
    return { kind: "video", body: item.video_item, media: item.video_item.media };
  }
  return null;
}

function collectStringValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseOptionalInt(value) {
  if (value == null || value === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeMessageId(message) {
  const raw = message?.message_id;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string") {
    return raw.trim();
  }
  return "";
}

function normalizeMessageTimestampMs(message) {
  const rawMs = Number(message?.create_time_ms);
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return rawMs;
  }
  const rawSeconds = Number(message?.create_time);
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    return rawSeconds * 1000;
  }
  return 0;
}

function buildDedupKey(message, senderId, createdAtMs) {
  const seq = normalizeNumeric(message?.seq);
  const messageId = normalizeNumeric(message?.message_id);
  const clientId = normalizeText(message?.client_id);
  const parts = [senderId, messageId, seq, createdAtMs || 0, clientId];
  return parts.join("|");
}

function normalizeNumeric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "0";
}

function pruneSeen(seen) {
  const now = Date.now();
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) {
      seen.delete(key);
    }
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createInboundFilter,
  normalizeInboundMessageDetailed,
  normalizeInboundMessage,
  resolveOwnerUserId,
  classifyInboundOwnership,
  isOwnerInboundMessage,
  bodyFromItemList,
};
