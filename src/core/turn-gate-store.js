const TURN_GATE_TTL_MS = 10 * 60 * 1000;

class TurnGateStore {
  constructor({ turnGateTtlMs = TURN_GATE_TTL_MS } = {}) {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Set();
    // scopeKey -> epoch ms when the pending turn began, used for TTL expiry.
    this.scopeStartedAt = new Map();
    this.turnGateTtlMs = turnGateTtlMs;
  }

  begin(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(scopeKey);
    this.scopeStartedAt.set(scopeKey, Date.now());
    return scopeKey;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
    this.scopeStartedAt.delete(scopeKey);
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey) {
      this.pendingScopeKeys.delete(scopeKey);
      this.scopeStartedAt.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }

  // Release pending scopes that have been held longer than the TTL. Returns the list
  // of released scope keys. For every released scope, `onExpire` (a callback or logger)
  // is invoked with the event code TURN_GATE_TIMEOUT so the desktop layer can surface
  // "Aidy stopped replying" diagnostics and recover without a full restart.
  expireStale({ now = Date.now(), onExpire } = {}) {
    const released = [];
    for (const scopeKey of [...this.pendingScopeKeys]) {
      const startedAt = this.scopeStartedAt.get(scopeKey);
      if (startedAt === undefined) continue;
      if (now - startedAt > this.turnGateTtlMs) {
        released.push(scopeKey);
        this.pendingScopeKeys.delete(scopeKey);
        this.scopeStartedAt.delete(scopeKey);
        for (const [threadId, boundScope] of this.scopeByThreadId) {
          if (boundScope === scopeKey) this.scopeByThreadId.delete(threadId);
        }
        if (typeof onExpire === "function") {
          onExpire({ code: "TURN_GATE_TIMEOUT", scopeKey, startedAt, expiredAt: now });
        }
      }
    }
    return released;
  }

  // Diagnostics for the desktop UI: how many scopes are currently pending and the
  // longest time any of them has been waiting (ms).
  pendingDiagnostics({ now = Date.now() } = {}) {
    let longestWaitMs = 0;
    for (const scopeKey of this.pendingScopeKeys) {
      const startedAt = this.scopeStartedAt.get(scopeKey);
      if (startedAt === undefined) continue;
      const wait = now - startedAt;
      if (wait > longestWaitMs) longestWaitMs = wait;
    }
    return { pendingCount: this.pendingScopeKeys.size, longestWaitMs };
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
