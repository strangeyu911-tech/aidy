const USER_VISIBLE_KINDS = new Set(["assistant.final"]);
const USER_VISIBLE_SOURCES = new Set(["runtime.reply", "system.action"]);

class OutboundMessageBoundary {
  constructor({ channelAdapter }) {
    if (!channelAdapter || typeof channelAdapter.sendText !== "function") {
      throw new TypeError("OutboundMessageBoundary requires a channel adapter.");
    }
    this.channelAdapter = channelAdapter;
  }

  async send(envelope) {
    const normalized = normalizeEnvelope(envelope);
    if (!normalized) {
      throw Object.assign(new Error("Only final assistant messages may cross the user outbound boundary."), {
        code: "OUTBOUND_MESSAGE_REJECTED",
      });
    }
    return this.channelAdapter.sendText({
      userId: normalized.userId,
      text: normalized.text,
      contextToken: normalized.contextToken,
      ...(normalized.preserveBlock ? { preserveBlock: true } : {}),
    });
  }
}

function normalizeEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const audience = normalizeText(value.audience);
  const kind = normalizeText(value.kind);
  const source = normalizeText(value.source);
  const userId = normalizeText(value.userId);
  const contextToken = normalizeText(value.contextToken);
  const text = normalizeBody(value.text);
  if (audience !== "user" || !USER_VISIBLE_KINDS.has(kind) || !USER_VISIBLE_SOURCES.has(source)) return null;
  if (!userId || !contextToken || !text) return null;
  return { audience, kind, source, userId, contextToken, text, preserveBlock: value.preserveBlock === true };
}

function normalizeText(value) { return typeof value === "string" ? value.trim() : ""; }
function normalizeBody(value) { return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""; }

module.exports = { OutboundMessageBoundary, normalizeEnvelope };
