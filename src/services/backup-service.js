const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { normalizeProviderProfiles } = require("../core/provider-profile-store");

const DATA_CLASSES = Object.freeze({
  settings: ["desktop-state.json", "supervision-plan.json", "provider-profiles.json"],
  diary: ["diary"],
  reports: ["reports", "timeline"],
});
const ALLOWED_TOP_LEVEL = new Set(Object.values(DATA_CLASSES).flat());
const ALLOWED_EXTENSIONS = new Set([".json", ".md", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".html", ".css", ".js", ".map", ".woff", ".woff2", ".ttf", ".ico"]);
const FORBIDDEN_ARCHIVE_ENTRY = /(?:^|\/)(?:credential-vault|diagnostic-capture)(?:\.|\/|$)|(?:^|\/)opencode(?:\/|$)/i;
const FORBIDDEN_PROFILE_KEY = /^(?:api.?key|provider.?key|authorization|proxy.?authorization|password|service.?password|secret|secret.?refs|secret.?generation|token|ciphertext|headers?|sensitive.?headers|request(?:body|raw)?|response(?:body|raw)?|raw(?:request|response)|raw|body)$/i;

class BackupService {
  constructor({ stateDir, logger } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.backupDir = path.join(this.stateDir, "backups");
    this.logger = logger;
  }

  async createBackup({ targetPath, classes = ["settings", "diary", "reports"], kind = "manual" } = {}) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const resolvedTarget = path.resolve(targetPath || path.join(this.backupDir, `${kind}-${timestampName()}.zip`));
    const staging = fs.mkdtempSync(path.join(this.backupDir, ".staging-backup-"));
    try {
      const selected = normalizeClasses(classes);
      for (const dataClass of selected) {
        for (const relativePath of DATA_CLASSES[dataClass]) {
          copySafe(path.join(this.stateDir, relativePath), path.join(staging, relativePath));
        }
      }
      const files = listFiles(staging).map((filePath) => ({
        path: toPosix(path.relative(staging, filePath)),
        sha256: hashFile(filePath),
        size: fs.statSync(filePath).size,
      }));
      const manifest = {
        format: "cyberboss-backup",
        version: 1,
        createdAt: new Date().toISOString(),
        kind,
        dataClasses: selected,
        files,
      };
      fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
      await runHidden(resolveTarExecutable(), ["-a", "-c", "-f", resolvedTarget, "."], { cwd: staging });
      this.logger?.info("backup.created", { kind, fileCount: files.length });
      return { filePath: resolvedTarget, manifest };
    } finally {
      removeVerifiedTemporary(staging, this.backupDir);
    }
  }

  async restore({ archivePath, createPreRestoreBackup = true } = {}) {
    const resolvedArchive = path.resolve(String(archivePath || ""));
    if (!fs.existsSync(resolvedArchive)) throw backupError("BACKUP_NOT_FOUND", "找不到所选备份文件。");
    fs.mkdirSync(this.backupDir, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.backupDir, ".staging-restore-"));
    const rollback = fs.mkdtempSync(path.join(this.backupDir, ".rollback-restore-"));
    try {
      const entries = await listArchive(resolvedArchive);
      validateArchiveEntries(entries);
      await runHidden(resolveTarExecutable(), ["-x", "-f", resolvedArchive, "-C", staging]);
      const manifestPath = path.join(staging, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      validateManifest(manifest, staging);
      prepareRestoredProviderProfiles(staging);
      if (createPreRestoreBackup) await this.createBackup({ kind: "pre-restore" });
      const targets = manifest.dataClasses.flatMap((name) => DATA_CLASSES[name] || []);
      const movedExisting = [];
      const installed = [];
      try {
        for (const relativePath of targets) {
          const source = path.join(staging, relativePath);
          if (!fs.existsSync(source)) continue;
          const destination = assertChildPath(this.stateDir, relativePath);
          const rollbackPath = assertChildPath(rollback, relativePath);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.mkdirSync(path.dirname(rollbackPath), { recursive: true });
          if (fs.existsSync(destination)) {
            fs.renameSync(destination, rollbackPath);
            movedExisting.push({ destination, rollbackPath });
          }
          fs.renameSync(source, destination);
          installed.push(destination);
        }
      } catch (error) {
        for (const destination of installed.reverse()) removePath(destination);
        for (const item of movedExisting.reverse()) {
          if (fs.existsSync(item.rollbackPath)) fs.renameSync(item.rollbackPath, item.destination);
        }
        throw error;
      }
      this.logger?.info("backup.restored", { dataClasses: manifest.dataClasses });
      return { restored: true, dataClasses: manifest.dataClasses };
    } finally {
      removeVerifiedTemporary(staging, this.backupDir);
      removeVerifiedTemporary(rollback, this.backupDir);
    }
  }

  cleanupAutomaticBackups({ daily = 7, weekly = 4 } = {}) {
    if (!fs.existsSync(this.backupDir)) return [];
    const removed = [];
    for (const [prefix, keep] of [["daily-", daily], ["weekly-", weekly]]) {
      const files = fs.readdirSync(this.backupDir)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".zip"))
        .sort().reverse();
      for (const name of files.slice(keep)) {
        const target = assertChildPath(this.backupDir, name);
        fs.rmSync(target, { force: true });
        removed.push(target);
      }
    }
    return removed;
  }
}

function normalizeClasses(classes) {
  const selected = [...new Set(Array.isArray(classes) ? classes : [])].filter((name) => DATA_CLASSES[name]);
  if (!selected.length) throw backupError("NO_DATA_CLASSES", "没有选择要备份的数据。");
  return selected;
}

function copySafe(source, destination) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copySafe(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!stat.isFile()) return;
  if (!ALLOWED_EXTENSIONS.has(path.extname(source).toLowerCase())) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (path.basename(source).toLowerCase() === "provider-profiles.json") {
    const portable = preparePortableProviderProfiles(JSON.parse(fs.readFileSync(source, "utf8")));
    fs.writeFileSync(destination, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
    return;
  }
  fs.copyFileSync(source, destination);
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const name of fs.readdirSync(root)) {
    const fullPath = path.join(root, name);
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) files.push(...listFiles(fullPath));
    else if (stat.isFile()) files.push(fullPath);
  }
  return files;
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function listArchive(archivePath) {
  const result = await runHidden(resolveTarExecutable(), ["-t", "-f", archivePath]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function validateArchiveEntries(entries) {
  if (!entries.length) throw backupError("EMPTY_BACKUP", "备份文件是空的。");
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/^\.\//, "").replace(/\\/g, "/");
    if (!entry || entry === ".") continue;
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.split("/").includes("..")) {
      throw backupError("UNSAFE_BACKUP_PATH", "备份中包含不安全的文件路径。");
    }
    if (FORBIDDEN_ARCHIVE_ENTRY.test(entry)) {
      throw backupError("FORBIDDEN_BACKUP_ENTRY", "备份中包含禁止导入的敏感数据。");
    }
    const topLevel = entry.split("/")[0];
    if (topLevel !== "manifest.json" && !ALLOWED_TOP_LEVEL.has(topLevel)) {
      throw backupError("UNEXPECTED_BACKUP_ENTRY", "备份中包含 CyberBoss 不认识的数据类型。");
    }
  }
}

function prepareRestoredProviderProfiles(staging) {
  const profilePath = path.join(staging, "provider-profiles.json");
  if (!fs.existsSync(profilePath)) return;
  const portable = preparePortableProviderProfiles(JSON.parse(fs.readFileSync(profilePath, "utf8")));
  fs.writeFileSync(profilePath, `${JSON.stringify(portable, null, 2)}\n`, "utf8");
}

function preparePortableProviderProfiles(value) {
  const normalized = normalizeProviderProfiles(value);
  return {
    schemaVersion: normalized.schemaVersion,
    activeProfileId: "",
    profiles: normalized.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      runtimeId: profile.runtimeId,
      ownershipMode: profile.ownershipMode,
      providerId: profile.providerId,
      protocolId: profile.protocolId,
      baseUrl: sanitizeBaseUrl(profile.baseUrl),
      options: sanitizeProfileValue(profile.options),
      modelId: profile.modelId,
      modelVariant: profile.modelVariant,
      visionProfileId: profile.visionProfileId,
      secretRefs: { apiKey: "", servicePassword: "", sensitiveHeaders: {} },
      secretGeneration: 0,
      status: "draft",
      verifiedFingerprint: "",
      capabilities: {},
      verificationError: "",
      catalogMetadata: sanitizeProfileValue(profile.catalogMetadata),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      verifiedAt: "",
    })),
  };
}

function sanitizeProfileValue(value, key = "") {
  if (FORBIDDEN_PROFILE_KEY.test(String(key).replace(/[-_\s]/g, ""))) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeProfileValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, childValue]) => [childKey, sanitizeProfileValue(childValue, childKey)])
      .filter(([, childValue]) => childValue !== undefined));
  }
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  return undefined;
}

function sanitizeBaseUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return "";
    return parsed.toString().replace(/\/$/, text.endsWith("/") ? "/" : "");
  } catch {
    return "";
  }
}

function validateManifest(manifest, staging) {
  if (manifest?.format !== "cyberboss-backup" || manifest?.version !== 1) throw backupError("UNSUPPORTED_BACKUP", "备份格式或版本不受支持。");
  const classes = normalizeClasses(manifest.dataClasses);
  if (!Array.isArray(manifest.files)) throw backupError("INVALID_MANIFEST", "备份清单不完整。");
  for (const entry of manifest.files) {
    const relativePath = String(entry?.path || "").replace(/\\/g, "/");
    const filePath = assertChildPath(staging, relativePath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw backupError("MISSING_BACKUP_FILE", "备份中的文件不完整。");
    if (hashFile(filePath) !== entry.sha256) throw backupError("BACKUP_CHECKSUM_FAILED", "备份校验失败，文件可能已经损坏。");
  }
  manifest.dataClasses = classes;
  return manifest;
}

function assertChildPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw backupError("UNSAFE_PATH", "文件路径不安全。");
  return resolved;
}

function removeVerifiedTemporary(target, backupDir) {
  const resolved = path.resolve(target);
  const root = path.resolve(backupDir);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith(".")) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function runHidden(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(backupError("ARCHIVE_COMMAND_FAILED", stderr.trim() || `Archive command exited with ${code}`)));
  });
}

// Prefer the Windows-bundled tar.exe in System32 so that a Unix tar (e.g. GNU tar
// shipped with Git for Windows) on the user's PATH cannot hijack the call and
// misinterpret Windows-style archive paths as remote hosts ("Cannot connect to C:").
function resolveTarExecutable() {
  const candidate = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  if (fs.existsSync(candidate)) return candidate;
  return "tar.exe";
}

// Probe whether a usable tar is reachable. Safe to call anywhere: it never throws,
// always resolves, and uses a short timeout so callers (including tests) cannot block.
function probeTarCapability({ timeout = 5000 } = {}) {
  const executable = resolveTarExecutable();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, ["--version"], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ available: false, executable, error: "timeout" });
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", () => finish({ available: false, executable, error: "spawn-failed" }));
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0
        ? { available: true, executable, version: (stdout || stderr).trim() || "unknown" }
        : { available: false, executable, error: (stderr || stdout).trim() || `exit ${code}` });
    });
  });
}

function timestampName() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function toPosix(value) { return value.replace(/\\/g, "/"); }
function backupError(code, message) { const error = new Error(message); error.code = code; return error; }

module.exports = {
  ALLOWED_TOP_LEVEL,
  BackupService,
  DATA_CLASSES,
  assertChildPath,
  normalizeClasses,
  preparePortableProviderProfiles,
  probeTarCapability,
  resolveTarExecutable,
  validateArchiveEntries,
  validateManifest,
};
