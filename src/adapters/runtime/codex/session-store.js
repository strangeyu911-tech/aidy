const fs = require("fs");
const path = require("path");
const { buildRuntimeScopeKey, normalizeRuntimeScope } = require("../api/conversation-store");
const { normalizeModelCatalog } = require("./model-catalog");
const { normalizeCommandTokens } = require("../shared/approval-command");
const { normalizeWorkspaceRoot } = require("../../../core/workspace-path");

class SessionStore {
  constructor({ filePath, runtimeId = "" }) {
    this.filePath = filePath;
    this.runtimeId = normalizeValue(runtimeId);
    this.state = createEmptyState();
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
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        const normalized = normalizeSessionState({
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          approvalPromptStateByThreadId: parsed.approvalPromptStateByThreadId || {},
          availableModelCatalog: parsed.availableModelCatalog || {
            models: [],
            updatedAt: "",
          },
        });
        this.state = normalized.state;
        if (normalized.changed) {
          this.save();
        }
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  listBindings() {
    return Object.entries(this.state.bindings || {}).map(([bindingKey, binding]) => ({
      bindingKey,
      ...(binding || {}),
    }));
  }

  getActiveWorkspaceRoot(bindingKey) {
    return normalizeWorkspaceRoot(this.state.bindings[bindingKey]?.activeWorkspaceRoot);
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...(this.state.bindings[bindingKey] || {}),
      ...(nextBinding || {}),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const binding = this.getBinding(bindingKey) || {};
    const scoped = getThreadMapForRuntime(binding, runtimeId);
    if (scoped[normalizedWorkspaceRoot]) {
      return scoped[normalizedWorkspaceRoot];
    }
    return "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const normalizedThreadId = normalizeThreadValue(threadId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      },
    };
    const nextBinding = {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRootByRuntime,
    };

    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      };
    }

    return this.updateBinding(bindingKey, nextBinding);
  }

  getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", modelProvider: "" };
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId);
    const entry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : null);
    return {
      model: normalizeValue(entry?.model),
      modelProvider: normalizeValue(entry?.modelProvider || entry?.model_provider),
    };
  }

  setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId) || "default";
    const previousEntry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : {})
      || {};
    const hasModel = Object.prototype.hasOwnProperty.call(params, "model");
    const hasModelProvider = Object.prototype.hasOwnProperty.call(params, "modelProvider");
    const nextEntry = {
      ...previousEntry,
      model: hasModel ? normalizeValue(params.model) : normalizeValue(previousEntry.model),
      modelProvider: hasModelProvider
        ? normalizeValue(params.modelProvider)
        : normalizeValue(previousEntry.modelProvider || previousEntry.model_provider),
    };
    const runtimeParamsByWorkspaceRootByRuntime = {
      ...getRuntimeParamsRuntimeMap(current),
      [runtimeId]: {
        ...getRuntimeParamsMapForRuntime(current, runtimeId),
        [normalizedWorkspaceRoot]: nextEntry,
      },
    };
    const nextBinding = {
      ...current,
      runtimeParamsByWorkspaceRootByRuntime,
    };
    if (runtimeId === "codex") {
      nextBinding.codexParamsByWorkspaceRoot = {
        ...getCodexParamsMap(current),
        [normalizedWorkspaceRoot]: {
          ...previousEntry,
          ...nextEntry,
        },
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: "",
      },
    };
    const nextBinding = {
      ...current,
      threadIdByWorkspaceRootByRuntime,
    };
    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: "",
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  getThreadIdForScope(bindingKey, workspaceRoot, scope) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) return "";
    const normalizedScope = normalizeRuntimeScope(scope);
    const scopeKey = buildRuntimeScopeKey(normalizedScope);
    const record = getThreadScopeMap(this.getBinding(bindingKey))[scopeKey];
    if (!record || !sameRuntimeScope(record.scope, normalizedScope)) return "";
    return normalizeThreadValue(record.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot]);
  }

  setThreadIdForScope(bindingKey, workspaceRoot, scope, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) return this.getBinding(bindingKey);
    const normalizedScope = normalizeRuntimeScope(scope);
    const scopeKey = buildRuntimeScopeKey(normalizedScope);
    const normalizedThreadId = normalizeThreadValue(threadId);
    const current = this.getBinding(bindingKey) || {};
    const currentScopes = getThreadScopeMap(current);
    const currentRecord = currentScopes[scopeKey] || {};
    return this.updateBinding(bindingKey, {
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadScopes: {
        ...currentScopes,
        [scopeKey]: {
          scope: normalizedScope,
          threadIdByWorkspaceRoot: {
            ...(currentRecord.threadIdByWorkspaceRoot || {}),
            [normalizedWorkspaceRoot]: normalizedThreadId,
          },
        },
      },
    });
  }

  clearThreadIdForScope(bindingKey, workspaceRoot, scope) {
    return this.setThreadIdForScope(bindingKey, workspaceRoot, scope, "");
  }

  listLegacyReadOnlySessions() {
    const sessions = [];
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      for (const session of collectLegacySessions({ bindingKey, ...(binding || {}) })) {
        if (isLegacySessionMigrated(binding, session)) continue;
        sessions.push(asReadOnlyLegacySession(session));
      }
    }
    return sessions;
  }

  migrateLegacyBindings(profiles, options = {}) {
    const results = [];
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      const result = migrateLegacyBinding({ bindingKey, ...(binding || {}) }, profiles, options);
      results.push(result);
      for (const migration of result.migrations) {
        this.setThreadIdForScope(
          bindingKey,
          migration.workspaceRoot,
          migration.scope,
          migration.threadId,
        );
        const current = this.getBinding(bindingKey) || {};
        this.updateBinding(bindingKey, {
          legacySessionMigrationByThreadId: {
            ...getLegacyMigrationMap(current),
            [legacySessionIdentity(migration)]: {
              scopeKey: buildRuntimeScopeKey(migration.scope),
              scope: migration.scope,
              workspaceRoot: migration.workspaceRoot,
            },
          },
        });
      }
    }
    return results;
  }

  /**
   * Re-login survival: a WeChat re-scan mints a new `ilink_bot_id`, so the
   * bindingKey (`default:<accountId>:<senderId>`) changes and the old binding —
   * with all of its threadIds — is orphaned. The transcripts themselves live in
   * the runtime's project directory keyed by threadId, independent of accountId,
   * so the memory is not lost; it is merely unreferenced.
   *
   * This walks every binding that belongs to the same senderId under a *different*
   * accountId and re-attaches its threadIds to the new account's bindings, so a
   * re-scan continues the same conversations instead of starting from zero.
   *
   * Rules:
   * - Only bindings whose `senderId` matches and whose `accountId` differs are
   *   considered. A re-login under the same accountId is a no-op.
   * - Target bindings are keyed by the source key with the accountId segment
   *   replaced, which preserves the `::system` scope split.
   * - A missing target binding is created wholesale from the source.
   * - When both sides have a thread for the same (runtime, workspaceRoot), the
   *   *prior* account's thread wins: it is the older, longer conversation, and
   *   the target's thread is usually the artifact of the reset being repaired.
   *   The displaced thread stays in the runtime's transcript store; only the
   *   pointer changes.
   * - Never removes anything. Idempotent: after the first run the prior bindings
   *   still exist but every threadId already matches, so nothing is written.
   */
  inheritThreadBindingsFromPriorAccounts({ accountId, senderId } = {}) {
    const normalizedAccountId = normalizeValue(accountId);
    const normalizedSenderId = normalizeValue(senderId);
    if (!normalizedAccountId || !normalizedSenderId) {
      return [];
    }
    const bindings = this.state.bindings || {};
    const changedKeys = new Set();
    for (const [sourceKey, source] of Object.entries(bindings)) {
      if (!source || typeof source !== "object") continue;
      if (normalizeValue(source.senderId) !== normalizedSenderId) continue;
      if (normalizeValue(source.accountId) === normalizedAccountId) continue;
      const parts = sourceKey.split(":");
      if (parts.length < 3) continue;
      parts[1] = normalizedAccountId;
      const targetKey = parts.join(":");
      if (targetKey === sourceKey) continue;
      const target = bindings[targetKey];
      if (!target) {
        const inherited = normalizeBinding({
          ...source,
          accountId: normalizedAccountId,
          legacyAccountIds: uniqueNonEmpty([
            ...(Array.isArray(source.legacyAccountIds) ? source.legacyAccountIds : []),
            normalizeValue(source.accountId),
          ]),
        });
        if (!inherited) continue;
        bindings[targetKey] = inherited;
        changedKeys.add(targetKey);
        continue;
      }
      if (mergeThreadBindings({ target, source, fromAccountId: normalizeValue(source.accountId) })) {
        changedKeys.add(targetKey);
      }
    }
    if (!changedKeys.size) {
      return [];
    }
    this.save();
    return [...changedKeys];
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    return this.updateBinding(bindingKey, {
      activeWorkspaceRoot: normalizedWorkspaceRoot,
    });
  }

  listWorkspaceRoots(bindingKey, runtimeId = this.runtimeId) {
    const current = this.getBinding(bindingKey) || {};
    return Object.keys(getThreadMapForRuntime(current, runtimeId));
  }

  findBindingForThreadId(threadId, runtimeId = this.runtimeId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const normalizedRuntimeId = normalizeValue(runtimeId);
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      for (const [workspaceRoot, candidateThreadId] of Object.entries(getThreadMapForRuntime(binding, normalizedRuntimeId))) {
        if (normalizeValue(candidateThreadId) === normalizedThreadId) {
          return {
            bindingKey,
          workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
          };
        }
      }
    }
    return null;
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const raw = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry) => Array.isArray(entry))
      .map((entry) => entry.map((part) => normalizeValue(part)).filter(Boolean))
      .filter((entry) => entry.length);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return this.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    }
    const current = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    if (!current.some((entry) => isSameTokenList(entry, normalizedTokens))) {
      current.push(normalizedTokens);
      this.state.approvalCommandAllowlistByWorkspaceRoot = {
        ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
        [normalizedWorkspaceRoot]: current,
      };
      this.save();
    }
    return current;
  }

  getApprovalPromptState(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const raw = this.state.approvalPromptStateByThreadId?.[normalizedThreadId];
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return {
      requestId: normalizeValue(raw.requestId),
      signature: normalizeValue(raw.signature),
      promptedAt: normalizeValue(raw.promptedAt),
    };
  }

  rememberApprovalPrompt(threadId, requestId, signature = "") {
    const normalizedThreadId = normalizeValue(threadId);
    const normalizedRequestId = normalizeValue(requestId);
    const normalizedSignature = normalizeValue(signature);
    if (!normalizedThreadId || !normalizedRequestId) {
      return null;
    }
    this.state.approvalPromptStateByThreadId = {
      ...(this.state.approvalPromptStateByThreadId || {}),
      [normalizedThreadId]: {
        requestId: normalizedRequestId,
        signature: normalizedSignature,
        promptedAt: new Date().toISOString(),
      },
    };
    this.save();
    return this.getApprovalPromptState(normalizedThreadId);
  }

  clearApprovalPrompt(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId || !this.state.approvalPromptStateByThreadId?.[normalizedThreadId]) {
      return;
    }
    const next = {
      ...(this.state.approvalPromptStateByThreadId || {}),
    };
    delete next[normalizedThreadId];
    this.state.approvalPromptStateByThreadId = next;
    this.save();
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return { models, updatedAt };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }
    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  buildBindingKey({ workspaceId, accountId, senderId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(accountId)}:${normalizeValue(senderId)}`;
  }
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function normalizeSessionState(state) {
  const before = JSON.stringify(state);
  const normalized = {
    ...state,
    bindings: Object.fromEntries(
      Object.entries(state.bindings || {}).map(([bindingKey, binding]) => [
        bindingKey,
        normalizeBinding(binding),
      ])
    ),
    approvalCommandAllowlistByWorkspaceRoot: normalizeWorkspaceMap(
      state.approvalCommandAllowlistByWorkspaceRoot,
      (value) => Array.isArray(value) ? value : []
    ),
  };
  return {
    state: normalized,
    changed: JSON.stringify(normalized) !== before,
  };
}

function normalizeBinding(binding) {
  const normalized = { ...(binding || {}) };
  if (Object.prototype.hasOwnProperty.call(normalized, "activeWorkspaceRoot")) {
    normalized.activeWorkspaceRoot = normalizeWorkspaceRoot(normalized.activeWorkspaceRoot);
  }
  if (normalized.threadIdByWorkspaceRootByRuntime && typeof normalized.threadIdByWorkspaceRootByRuntime === "object") {
    normalized.threadIdByWorkspaceRootByRuntime = normalizeRuntimeWorkspaceMap(
      normalized.threadIdByWorkspaceRootByRuntime,
      (value) => normalizeThreadValue(value)
    );
  }
  if (normalized.threadIdByWorkspaceRoot && typeof normalized.threadIdByWorkspaceRoot === "object") {
    normalized.threadIdByWorkspaceRoot = normalizeWorkspaceMap(
      normalized.threadIdByWorkspaceRoot,
      (value) => normalizeThreadValue(value)
    );
  }
  if (normalized.runtimeParamsByWorkspaceRootByRuntime && typeof normalized.runtimeParamsByWorkspaceRootByRuntime === "object") {
    normalized.runtimeParamsByWorkspaceRootByRuntime = normalizeRuntimeWorkspaceMap(
      normalized.runtimeParamsByWorkspaceRootByRuntime,
      (value) => value && typeof value === "object" ? { ...value } : {}
    );
  }
  if (normalized.codexParamsByWorkspaceRoot && typeof normalized.codexParamsByWorkspaceRoot === "object") {
    normalized.codexParamsByWorkspaceRoot = normalizeWorkspaceMap(
      normalized.codexParamsByWorkspaceRoot,
      (value) => value && typeof value === "object" ? { ...value } : {}
    );
  }
  normalized.threadScopes = normalizeThreadScopes(normalized.threadScopes);
  normalized.legacySessionMigrationByThreadId = normalizeLegacyMigrationMap(
    normalized.legacySessionMigrationByThreadId,
  );
  return normalized;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => normalizeValue(value)).filter(Boolean))];
}

/**
 * Re-attach the source (prior account) binding's threads onto the target binding.
 *
 * Conflict rule: the prior account's threadId wins for a (runtime, workspaceRoot)
 * the target also has — the prior thread is the older, longer conversation and the
 * target's is usually the artifact of the post-re-scan reset. Everything the target
 * already has and the source lacks is left untouched, so the operation is
 * idempotent once the pointer has been moved.
 */
function mergeThreadBindings({ target, source, fromAccountId }) {
  let changed = false;

  for (const [field, getMap, isByRuntime] of [
    ["threadIdByWorkspaceRootByRuntime", (current) => getThreadRuntimeMap(current), true],
    ["threadIdByWorkspaceRoot", (current) => getLegacyThreadMap(current), false],
  ]) {
    const sourceMap = getMap(source) || {};
    if (!Object.keys(sourceMap).length) continue;
    const targetMap = { ...getMap(target) };
    let fieldChanged = false;
    for (const [runtimeOrWorkspace, value] of Object.entries(sourceMap)) {
      if (isByRuntime) {
        const sourceWorkspaceMap = value && typeof value === "object" ? value : {};
        const targetWorkspaceMap = { ...(targetMap[runtimeOrWorkspace] || {}) };
        for (const [workspaceRoot, threadId] of Object.entries(sourceWorkspaceMap)) {
          if (!normalizeThreadValue(threadId)) continue;
          if (targetWorkspaceMap[workspaceRoot] === threadId) continue;
          targetWorkspaceMap[workspaceRoot] = threadId;
          fieldChanged = true;
        }
        if (fieldChanged) {
          targetMap[runtimeOrWorkspace] = targetWorkspaceMap;
        }
      } else if (normalizeThreadValue(value) && targetMap[runtimeOrWorkspace] !== value) {
        targetMap[runtimeOrWorkspace] = value;
        fieldChanged = true;
      }
    }
    if (fieldChanged) {
      target[field] = targetMap;
      changed = true;
    }
  }

  const sourceScopes = source.threadScopes || {};
  if (Object.keys(sourceScopes).length) {
    const targetScopes = { ...(target.threadScopes || {}) };
    let scopesChanged = false;
    for (const [scopeKey, record] of Object.entries(sourceScopes)) {
      if (targetScopes[scopeKey]) continue;
      targetScopes[scopeKey] = record;
      scopesChanged = true;
    }
    if (scopesChanged) {
      target.threadScopes = targetScopes;
      changed = true;
    }
  }

  for (const [field, getMap, isByRuntime] of [
    ["runtimeParamsByWorkspaceRootByRuntime", (current) => current?.runtimeParamsByWorkspaceRootByRuntime || {}, true],
    ["codexParamsByWorkspaceRoot", (current) => current?.codexParamsByWorkspaceRoot || {}, false],
  ]) {
    const sourceMap = getMap(source) || {};
    if (!Object.keys(sourceMap).length) continue;
    const targetMap = { ...getMap(target) };
    let paramsChanged = false;
    for (const [runtimeOrWorkspace, value] of Object.entries(sourceMap)) {
      if (targetMap[runtimeOrWorkspace]) continue;
      if (isByRuntime) {
        if (!value || typeof value !== "object") continue;
      } else if (!value || typeof value !== "object") {
        continue;
      }
      targetMap[runtimeOrWorkspace] = value;
      paramsChanged = true;
    }
    if (paramsChanged) {
      target[field] = targetMap;
      changed = true;
    }
  }

  if (changed) {
    const legacy = uniqueNonEmpty([
      ...(Array.isArray(target.legacyAccountIds) ? target.legacyAccountIds : []),
      fromAccountId,
    ]);
    if (legacy.length) {
      target.legacyAccountIds = legacy;
    }
  }
  return changed;
}

function normalizeThreadScopes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const record of Object.values(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    let scope;
    try {
      scope = normalizeRuntimeScope(record.scope);
    } catch {
      continue;
    }
    normalized[buildRuntimeScopeKey(scope)] = {
      scope,
      threadIdByWorkspaceRoot: normalizeWorkspaceMap(
        record.threadIdByWorkspaceRoot,
        (threadId) => normalizeThreadValue(threadId),
      ),
    };
  }
  return normalized;
}

function normalizeLegacyMigrationMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [identity, record] of Object.entries(value)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    let scope;
    try {
      scope = normalizeRuntimeScope(record.scope);
    } catch {
      continue;
    }
    const key = normalizeValue(identity);
    if (!key) continue;
    normalized[key] = {
      scopeKey: buildRuntimeScopeKey(scope),
      scope,
      workspaceRoot: normalizeWorkspaceRoot(record.workspaceRoot),
    };
  }
  return normalized;
}

function normalizeRuntimeWorkspaceMap(map, valueNormalizer) {
  return Object.fromEntries(
    Object.entries(map || {}).map(([runtimeId, workspaceMap]) => [
      runtimeId,
      normalizeWorkspaceMap(workspaceMap, valueNormalizer),
    ])
  );
}

function normalizeWorkspaceMap(map, valueNormalizer = (value) => value) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return {};
  }
  const entries = Object.entries(map);
  const ordered = [
    ...entries.filter(([key]) => normalizeWorkspaceRoot(key) === key.trim()),
    ...entries.filter(([key]) => normalizeWorkspaceRoot(key) !== key.trim()),
  ];
  const normalized = {};
  for (const [key, value] of ordered) {
    const normalizedKey = normalizeWorkspaceRoot(key);
    if (!normalizedKey || Object.prototype.hasOwnProperty.call(normalized, normalizedKey)) {
      continue;
    }
    normalized[normalizedKey] = valueNormalizer(value);
  }
  return normalized;
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadValue(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function getLegacyThreadMap(binding) {
  return binding?.threadIdByWorkspaceRoot && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
}

function getThreadRuntimeMap(binding) {
  return binding?.threadIdByWorkspaceRootByRuntime && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  const runtimeMap = getThreadRuntimeMap(binding);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function getThreadScopeMap(binding) {
  return binding?.threadScopes && typeof binding.threadScopes === "object" && !Array.isArray(binding.threadScopes)
    ? binding.threadScopes
    : {};
}

function getLegacyMigrationMap(binding) {
  return binding?.legacySessionMigrationByThreadId
    && typeof binding.legacySessionMigrationByThreadId === "object"
    && !Array.isArray(binding.legacySessionMigrationByThreadId)
    ? binding.legacySessionMigrationByThreadId
    : {};
}

function getCodexParamsMap(binding) {
  return binding?.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
}

function getRuntimeParamsRuntimeMap(binding) {
  return binding?.runtimeParamsByWorkspaceRootByRuntime && typeof binding.runtimeParamsByWorkspaceRootByRuntime === "object"
    ? binding.runtimeParamsByWorkspaceRootByRuntime
    : {};
}

function getRuntimeParamsMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = getRuntimeParamsRuntimeMap(binding)[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function isSameTokenList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function migrateLegacyBinding(binding, profiles, options = {}) {
  const legacySessions = collectLegacySessions(binding);
  const activeProfiles = resolveExplicitlyActiveProfiles(profiles, options.activeProfileId);
  const migrations = [];
  const readOnlySessions = [];

  for (const session of legacySessions) {
    const matches = activeProfiles.filter((profile) => isCompatibleLegacyProfile(profile, session));
    if (matches.length !== 1) {
      readOnlySessions.push(asReadOnlyLegacySession(session));
      continue;
    }
    const profile = matches[0];
    migrations.push({
      bindingKey: session.bindingKey,
      workspaceRoot: session.workspaceRoot,
      threadId: session.threadId,
      runtimeId: session.runtimeId,
      scope: normalizeRuntimeScope({
        runtimeId: profile.runtimeId,
        profileId: profile.id,
        modelId: profile.modelId,
        secretGeneration: profile.secretGeneration,
      }),
    });
  }

  return {
    scopedThreadId: migrations.length === 1 && legacySessions.length === 1 ? migrations[0].threadId : "",
    scope: migrations.length === 1 && legacySessions.length === 1 ? migrations[0].scope : null,
    migrations,
    legacySessions: readOnlySessions,
    startFreshScopedSession: readOnlySessions.length > 0,
  };
}

function collectLegacySessions(binding) {
  const source = binding && typeof binding === "object" ? binding : {};
  const bindingKey = normalizeValue(source.bindingKey);
  const sessions = [];
  for (const [workspaceRoot, rawThreadId] of Object.entries(getLegacyThreadMap(source))) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    const threadId = normalizeThreadValue(rawThreadId);
    if (!normalizedWorkspaceRoot || !threadId) continue;
    const runtimeId = inferLegacyRuntimeId(source, normalizedWorkspaceRoot);
    const params = getLegacyRuntimeParams(source, normalizedWorkspaceRoot, runtimeId);
    sessions.push({
      bindingKey,
      workspaceRoot: normalizedWorkspaceRoot,
      threadId,
      runtimeId,
      modelId: normalizeValue(params.model),
      providerId: normalizeValue(params.modelProvider || params.model_provider).toLowerCase(),
    });
  }
  return sessions;
}

function inferLegacyRuntimeId(binding, workspaceRoot) {
  const declared = normalizeValue(binding.legacyRuntimeId || binding.runtimeId).toLowerCase();
  if (declared === "codex" || declared === "claudecode") return declared;
  const runtimeParams = getRuntimeParamsRuntimeMap(binding);
  const matchingRuntimes = ["codex", "claudecode"].filter((runtimeId) => (
    Object.prototype.hasOwnProperty.call(runtimeParams[runtimeId] || {}, workspaceRoot)
  ));
  if (matchingRuntimes.length === 1) return matchingRuntimes[0];
  if (Object.prototype.hasOwnProperty.call(getCodexParamsMap(binding), workspaceRoot)) return "codex";
  return "";
}

function getLegacyRuntimeParams(binding, workspaceRoot, runtimeId) {
  const scoped = getRuntimeParamsMapForRuntime(binding, runtimeId)[workspaceRoot];
  if (scoped && typeof scoped === "object") return scoped;
  if (runtimeId === "codex") return getCodexParamsMap(binding)[workspaceRoot] || {};
  return {};
}

function resolveExplicitlyActiveProfiles(profiles, activeProfileId) {
  const candidates = Array.isArray(profiles) ? profiles.filter((profile) => profile && typeof profile === "object") : [];
  const normalizedActiveProfileId = normalizeValue(activeProfileId);
  if (normalizedActiveProfileId) {
    return candidates.filter((profile) => normalizeValue(profile.id) === normalizedActiveProfileId);
  }
  return candidates.filter((profile) => (
    profile.active === true || profile.isActive === true || profile.explicitlyActivated === true
  ));
}

function isCompatibleLegacyProfile(profile, session) {
  const runtimeId = normalizeValue(profile.runtimeId).toLowerCase();
  if (profile.status !== "verified" || (runtimeId !== "codex" && runtimeId !== "claudecode")) return false;
  if (!session.runtimeId || runtimeId !== session.runtimeId) return false;
  if (!normalizeValue(profile.id) || !normalizeValue(profile.modelId)) return false;
  const secretGeneration = Number(profile.secretGeneration);
  if (!Number.isSafeInteger(secretGeneration) || secretGeneration < 0) return false;

  const profileModelId = normalizeValue(profile.modelId);
  const profileProviderId = normalizeValue(profile.providerId).toLowerCase();
  if (runtimeId === "codex" && (!session.modelId || !session.providerId)) return false;
  if (session.modelId && profileModelId !== session.modelId) return false;
  if (session.providerId && profileProviderId !== session.providerId) return false;
  return true;
}

function asReadOnlyLegacySession(session) {
  return {
    bindingKey: session.bindingKey,
    workspaceRoot: session.workspaceRoot,
    threadId: session.threadId,
    runtimeId: session.runtimeId,
    readOnly: true,
    resumable: false,
    reason: "legacy_scope_ambiguous",
    label: "旧版兼容会话（只读）",
    explanation: "无法确认原始运行时、档案和模型身份；后续交互将在新的 scoped 会话中继续。",
  };
}

function isLegacySessionMigrated(binding, session) {
  const migration = getLegacyMigrationMap(binding)[legacySessionIdentity(session)];
  if (!migration) return false;
  const scopeRecord = getThreadScopeMap(binding)[migration.scopeKey];
  return Boolean(
    scopeRecord
    && sameRuntimeScope(scopeRecord.scope, migration.scope)
    && normalizeThreadValue(scopeRecord.threadIdByWorkspaceRoot?.[session.workspaceRoot]) === session.threadId
  );
}

function legacySessionIdentity(session) {
  return `${normalizeValue(session.runtimeId)}:${normalizeThreadValue(session.threadId)}`;
}

function sameRuntimeScope(left, right) {
  return Boolean(left && right)
    && left.runtimeId === right.runtimeId
    && left.profileId === right.profileId
    && left.modelId === right.modelId
    && left.secretGeneration === right.secretGeneration
    && left.runtimeIdentityFingerprint === right.runtimeIdentityFingerprint;
}

module.exports = { SessionStore, migrateLegacyBinding };
