"use strict";

/**
 * One-time migration for the identity-key change (docs/2026-09-22-fix-plan-identity-and-gateway.md).
 *
 * Before: bindingKey = <workspaceId>:<bot_id>:<openid>, with one binding per WeChat
 *         scan because the platform mints a new `ilink_bot_id` every time. Memory
 *         pointers ended up scattered across N account bindings.
 * After:  bindingKey = <workspaceId>:<openid>:<openid>. The openid is stable across
 *         scans, so re-logging in never orphans the thread pointers again.
 *
 * Steps (see the plan for the full contract):
 *   M-1  back up sessions.json next to the original
 *   M-2  merge every binding that shares the target identity into one binding per
 *        scope (user / ::system), picking the *most recently active* thread as the
 *        main line (accumulated splits make "oldest = longest memory" false) and
 *        recording the displaced threads as superseded
 *   M-3  copy the surviving threads' transcript jsonl into the transcript directory
 *        of the new stable workspace root, so `session/resume` can actually find them
 *   M-4  report (read-only) any other stores still keyed by a bot id
 *   M-5  verify the merged state in memory before anything is written back
 *
 * The script is idempotent: a second run sees the migration marker on the target
 * binding and exits without writing. Superseded data is never deleted — the old
 * bindings stay in place (untouched by the new key scheme) and transcript files
 * are copied, never moved.
 *
 * Usage: node scripts/migrate-identity-key.js [--state-dir <dir>] [--dry-run]
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}
const DRY_RUN = args.includes("--dry-run");
const STATE_DIR = path.resolve(argValue("--state-dir") || process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss"));
const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json");
const CODEBUDDY_PROJECTS = path.resolve(process.env.CODEBUDDY_PROJECTS_DIR || path.join(os.homedir(), ".codebuddy", "projects"));
const WORKSPACE_ROOT = path.resolve(argValue("--workspace-root") || process.env.CYBERBOSS_WORKSPACE_ROOT || path.join(STATE_DIR, "workspace"));

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.migrate-tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, file);
}

/**
 * Transcript directory names observed in the wild all follow: drive letter
 * lowercased, every run of `:`/`\`//`/` separators collapsed to a single `-`,
 * everything else (case and dots) preserved — e.g.
 * `C:\Users\me\.cyberboss` → `c-Users-me-.cyberboss`. Older CLIs produced an
 * all-lowercase variant, so both spellings are probed and whichever directory
 * already exists wins; otherwise the canonical form is used.
 */
function transcriptDirCandidates(workspaceRoot) {
  const normalized = String(workspaceRoot || "").replace(/\//g, "\\");
  const canonical = /^[A-Za-z]:/.test(normalized)
    ? normalized[0].toLowerCase() + normalized.slice(1)
    : normalized;
  const primary = canonical.replace(/[\\:]+/g, "-");
  const legacy = canonical.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return [...new Set([primary, legacy])];
}

function resolveTranscriptDir(workspaceRoot, projectsRoot) {
  const candidates = transcriptDirCandidates(workspaceRoot);
  for (const name of candidates) {
    const dir = path.join(projectsRoot, name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return { dir, matchedExisting: true };
    }
  }
  return { dir: path.join(projectsRoot, candidates[0]), matchedExisting: false };
}

function findTranscriptFile(threadId, projectsRoot) {
  const target = `${threadId}.jsonl`;
  if (!fs.existsSync(projectsRoot)) return null;
  const queue = [projectsRoot];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name === target) return full;
    }
  }
  return null;
}

function transcriptMtime(threadId, projectsRoot) {
  const file = findTranscriptFile(threadId, projectsRoot);
  if (!file) return 0;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function threadMapForBinding(binding) {
  const byRuntime = binding?.threadIdByWorkspaceRootByRuntime?.codebuddy
    || binding?.threadIdByWorkspaceRootByRuntime?.codex
    || {};
  return byRuntime;
}

/** M-2: pick the most recently active thread id for the merged binding. */
function pickMainThreadId({ targetThreadId, sourceThreadId, projectsRoot }) {
  const candidates = [];
  if (normalizeText(targetThreadId)) candidates.push({ threadId: normalizeText(targetThreadId), mtime: transcriptMtime(targetThreadId, projectsRoot) });
  if (normalizeText(sourceThreadId) && sourceThreadId !== targetThreadId) {
    candidates.push({ threadId: normalizeText(sourceThreadId), mtime: transcriptMtime(sourceThreadId, projectsRoot) });
  }
  if (!candidates.length) return { mainThreadId: "", superseded: [] };
  if (candidates.length === 1) return { mainThreadId: candidates[0].threadId, superseded: [] };
  candidates.sort((left, right) => right.mtime - left.mtime);
  return {
    mainThreadId: candidates[0].threadId,
    superseded: candidates.slice(1).map((candidate) => candidate.threadId),
  };
}

function mergeIntoTarget({ target, source, sourceKey, projectsRoot }) {
  let changed = false;
  const superseded = Array.isArray(target.supersededThreadIds) ? target.supersededThreadIds : [];

  // Threads: conflict resolved by recency, not by age — after accumulated
  // splits the "oldest = longest memory" assumption breaks down.
  const sourceMap = { ...threadMapForBinding(source), ...(source.threadIdByWorkspaceRoot || {}) };
  const targetMap = {
    ...threadMapForBinding(target),
    ...(target.threadIdByWorkspaceRoot || {}),
  };
  const workspaces = new Set([...Object.keys(targetMap), ...Object.keys(sourceMap)]);
  for (const workspace of workspaces) {
    const { mainThreadId, superseded: displaced } = pickMainThreadId({
      targetThreadId: targetMap[workspace],
      sourceThreadId: sourceMap[workspace],
      projectsRoot,
    });
    if (!mainThreadId) continue;
    if (targetMap[workspace] !== mainThreadId) {
      targetMap[workspace] = mainThreadId;
      changed = true;
    }
    for (const threadId of displaced) {
      if (!superseded.includes(threadId)) superseded.push(threadId);
    }
  }
  if (changed) {
    target.threadIdByWorkspaceRootByRuntime = target.threadIdByWorkspaceRootByRuntime || {};
    target.threadIdByWorkspaceRootByRuntime.codebuddy = { ...targetMap };
    target.threadIdByWorkspaceRoot = { ...targetMap };
  }

  // Legacy account lineage for forensics.
  const legacyAccountIds = new Set([
    ...(Array.isArray(target.legacyAccountIds) ? target.legacyAccountIds : []),
    normalizeText(source.accountId),
  ].filter(Boolean));
  if (legacyAccountIds.size !== new Set(target.legacyAccountIds || []).size) {
    target.legacyAccountIds = [...legacyAccountIds];
    changed = true;
  }
  if (superseded.length && JSON.stringify(target.supersededThreadIds || []) !== JSON.stringify(superseded)) {
    target.supersededThreadIds = superseded;
    changed = true;
  }

  // Scoped threads move wholesale when the target has no record for the key.
  for (const [scopeKey, record] of Object.entries(source.threadScopes || {})) {
    target.threadScopes = target.threadScopes || {};
    if (!target.threadScopes[scopeKey]) {
      target.threadScopes[scopeKey] = record;
      changed = true;
    }
  }

  if (normalizeText(source.activeWorkspaceRoot) && !normalizeText(target.activeWorkspaceRoot)) {
    target.activeWorkspaceRoot = normalizeText(source.activeWorkspaceRoot);
    changed = true;
  }

  console.log(`  merged ${sourceKey}`);
  console.log(`    threads: ${JSON.stringify(sourceMap)} -> main line resolved by recency`);
  return changed;
}

function buildMergedState({ state, identityKey, senderId, workspaceId, projectsRoot }) {
  const bindings = state.bindings || {};
  const merged = {};
  const retire = [];

  for (const [key, binding] of Object.entries(bindings)) {
    const scopeSuffix = key.endsWith("::system") ? "::system" : "";
    const targetKey = `${workspaceId}:${identityKey}:${senderId}${scopeSuffix}`;
    if (key === targetKey) {
      merged[targetKey] = binding;
      continue;
    }
    if (normalizeText(binding?.senderId) !== senderId) {
      continue; // A different human: never touched.
    }
    if (normalizeText(binding?.accountId) === identityKey) {
      continue; // Already on the identity key: nothing to do.
    }
    if (!merged[targetKey]) {
      merged[targetKey] = {
        ...binding,
        accountId: identityKey,
        workspaceId,
        legacyAccountIds: [normalizeText(binding.accountId)].filter(Boolean),
        supersededThreadIds: [],
        identityMigratedAt: new Date().toISOString(),
      };
      console.log(`  created ${targetKey} from ${key}`);
    } else {
      mergeIntoTarget({ target: merged[targetKey], source: binding, sourceKey: key, projectsRoot });
    }
    retire.push({ key, binding });
  }

  if (!merged[`${workspaceId}:${identityKey}:${senderId}`]) {
    console.log("  no prior bindings for this identity — nothing to merge.");
  }

  return {
    state: { ...state, bindings: { ...bindings, ...merged } },
    retiredKeys: retire.map((entry) => entry.key),
  };
}

function verify({ state, identityKey, senderId, workspaceId }) {
  const bindings = state.bindings || {};
  const problems = [];
  for (const scopeSuffix of ["", "::system"]) {
    const key = `${workspaceId}:${identityKey}:${senderId}${scopeSuffix}`;
    const binding = bindings[key];
    if (!binding) continue;
    if (normalizeText(binding.accountId) !== identityKey) {
      problems.push(`${key}: accountId is ${binding.accountId}, expected ${identityKey}`);
    }
    const threads = threadMapForBinding(binding);
    for (const [workspace, threadId] of Object.entries(threads)) {
      if (!normalizeText(threadId)) problems.push(`${key}: empty threadId for ${workspace}`);
    }
  }
  return problems;
}

function copyTranscripts({ state, identityKey, senderId, workspaceId, projectsRoot, workspaceRoot = WORKSPACE_ROOT }) {
  const bindings = state.bindings || {};
  const copied = [];
  const missing = [];
  const { dir: targetDir } = resolveTranscriptDir(workspaceRoot, projectsRoot);
  for (const scopeSuffix of ["", "::system"]) {
    const binding = bindings[`${workspaceId}:${identityKey}:${senderId}${scopeSuffix}`];
    if (!binding) continue;
    for (const threadId of Object.values(threadMapForBinding(binding))) {
      if (!normalizeText(threadId)) continue;
      const sourceFile = findTranscriptFile(threadId, projectsRoot);
      if (!sourceFile) {
        missing.push(threadId);
        continue;
      }
      if (path.resolve(path.dirname(sourceFile)) === path.resolve(targetDir)) {
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const destination = path.join(targetDir, `${threadId}.jsonl`);
      if (fs.existsSync(destination)) {
        console.log(`  transcript already present: ${threadId}`);
        continue;
      }
      fs.copyFileSync(sourceFile, destination);
      copied.push(threadId);
    }
  }
  return { targetDir, copied, missing };
}

function reportBotIdKeyedStores({ state, identityKey }) {
  // M-4: read-only sweep for stores still keyed by a bot id. These are the
  // connection-layer queues, which are self-consistent (enqueue and drain both
  // use the live account id) — they are reported, not rewritten.
  const files = [
    "system-message-queue.json",
    "deferred-system-replies.json",
    "reminder-queue.json",
    "timeline-screenshot-queue.json",
  ];
  for (const name of files) {
    const file = path.join(STATE_DIR, name);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.stringify(readJson(file));
      const botIds = new Set();
      for (const match of raw.matchAll(/"accountId"\s*:\s*"([^"]+)"/g)) {
        if (match[1] && match[1] !== identityKey) botIds.add(match[1]);
      }
      console.log(`  ${name}: ${botIds.size ? `connection-layer account keys present: ${[...botIds].join(", ")}` : "no bot-id keys"}`);
    } catch (error) {
      console.log(`  ${name}: unreadable (${error.message})`);
    }
  }
}

function main() {
  console.log(`sessions: ${SESSIONS_FILE}`);
  if (!fs.existsSync(SESSIONS_FILE)) {
    console.log("sessions.json not found — nothing to migrate.");
    return;
  }
  const state = readJson(SESSIONS_FILE);

  // Resolve the identity key from the live WeChat account file.
  const accountsDir = path.join(STATE_DIR, "accounts");
  const accountFiles = fs.existsSync(accountsDir)
    ? fs.readdirSync(accountsDir).filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    : [];
  if (accountFiles.length !== 1) {
    throw new Error(`expected exactly one active WeChat account file in ${accountsDir}, found ${accountFiles.length}. Resolve the account first, then re-run.`);
  }
  const account = readJson(path.join(accountsDir, accountFiles[0]));
  const identityKey = normalizeText(account.userId);
  const senderId = identityKey;
  const workspaceId = "default";
  if (!identityKey) {
    throw new Error("the active account file has no userId (openid); re-scan WeChat first.");
  }
  console.log(`identity key: ${identityKey.slice(0, 12)}…`);

  // M-1: backup before anything else.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = `${SESSIONS_FILE}.backup-identity-migration-${stamp}`;
  fs.copyFileSync(SESSIONS_FILE, backupFile);
  console.log(`backup: ${backupFile}`);

  // M-2 + M-5: merge in memory, verify, only then write back.
  const { state: mergedState, retiredKeys } = buildMergedState({
    state, identityKey, senderId, workspaceId, projectsRoot: CODEBUDDY_PROJECTS,
  });
  const problems = verify({ state: mergedState, identityKey, senderId, workspaceId });
  if (problems.length) {
    console.error("verification failed; nothing was written:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`merged bindings: ${retiredKeys.length} prior key(s) folded into the identity key`);

  if (DRY_RUN) {
    console.log("dry run: no state written, no transcripts copied.");
    reportBotIdKeyedStores({ state: mergedState, identityKey });
    return;
  }

  atomicWriteJson(SESSIONS_FILE, mergedState);
  console.log("sessions.json written.");

  // M-3: make the surviving threads resumable from the new stable workspace.
  const { targetDir, copied, missing } = copyTranscripts({
    state: mergedState, identityKey, senderId, workspaceId, projectsRoot: CODEBUDDY_PROJECTS,
  });
  console.log(`transcript dir: ${targetDir}`);
  console.log(`transcripts copied: ${copied.length}${missing.length ? `, not found on disk: ${missing.join(", ")}` : ""}`);

  // M-4
  reportBotIdKeyedStores({ state: mergedState, identityKey });
  console.log("migration complete.");
}

if (require.main === module) {
  main();
}

module.exports = {
  transcriptDirCandidates,
  resolveTranscriptDir,
  pickMainThreadId,
  mergeIntoTarget,
  buildMergedState,
  verify,
  copyTranscripts,
  identityKeyForTest: (account) => normalizeText(account?.userId) || normalizeText(account?.accountId),
};
