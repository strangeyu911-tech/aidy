const fs = require("fs");
const path = require("path");

const LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 });
const COMPONENTS = new Set(["desktop", "bridge", "runtime", "integrations", "reports"]);
const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|message|body|diary|command|args|api[-_]?key|ciphertext|wechat.*id|sender.*id)/i;
const HEADER_CONTAINER_KEY = /headers$/i;

class ComponentLogger {
  constructor({ logDir, component = "desktop", level = "INFO", maxBytes = 10 * 1024 * 1024, maxRotated = 5, maxAgeDays = 14, totalMaxBytes = 200 * 1024 * 1024 } = {}) {
    this.logDir = logDir;
    this.component = COMPONENTS.has(component) ? component : "desktop";
    this.level = LEVELS[level] ? level : "INFO";
    this.maxBytes = maxBytes;
    this.maxRotated = maxRotated;
    this.maxAgeDays = maxAgeDays;
    this.totalMaxBytes = totalMaxBytes;
    this.debugUntil = 0;
    this.lastCleanupAt = 0;
    fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, `${this.component}.jsonl`);
  }

  debug(event, data) { return this.write("DEBUG", event, data); }
  info(event, data) { return this.write("INFO", event, data); }
  warn(event, data) { return this.write("WARN", event, data); }
  error(event, data) { return this.write("ERROR", event, data); }

  write(level, event, data = {}) {
    const effectiveLevel = this.debugUntil > Date.now() ? "DEBUG" : this.level;
    if ((LEVELS[level] || LEVELS.INFO) < (LEVELS[effectiveLevel] || LEVELS.INFO)) {
      return false;
    }
    try {
      this.rotateIfNeeded();
      if (Date.now() - this.lastCleanupAt >= 24 * 60 * 60_000) this.cleanupRetention();
      const record = {
        timestamp: new Date().toISOString(),
        level,
        component: this.component,
        event: normalizeEvent(event),
        data: redact(data),
      };
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
      return true;
    } catch {
      if (level === "DEBUG") {
        this.level = "INFO";
      }
      return false;
    }
  }

  rotateIfNeeded() {
    if (!fs.existsSync(this.filePath) || fs.statSync(this.filePath).size < this.maxBytes) {
      return;
    }
    for (let index = this.maxRotated; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const target = `${this.filePath}.${index}`;
      if (!fs.existsSync(source)) {
        continue;
      }
      if (index === this.maxRotated) {
        fs.rmSync(target, { force: true });
      }
      fs.renameSync(source, target);
    }
  }

  enableDebug(durationMs = 30 * 60_000) {
    this.debugUntil = Date.now() + Math.max(1_000, durationMs);
    return new Date(this.debugUntil).toISOString();
  }

  disableDebug() {
    this.debugUntil = 0;
  }

  cleanupRetention(now = Date.now()) {
    this.lastCleanupAt = now;
    if (!fs.existsSync(this.logDir)) return [];
    const rotated = fs.readdirSync(this.logDir)
      .filter((name) => /\.jsonl\.\d+$/.test(name))
      .map((name) => {
        const filePath = path.join(this.logDir, name);
        const stat = fs.statSync(filePath);
        return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
    const removed = [];
    const ageBoundary = now - this.maxAgeDays * 24 * 60 * 60_000;
    for (const item of rotated.filter((entry) => entry.mtimeMs < ageBoundary)) {
      fs.rmSync(item.filePath, { force: true });
      item.removed = true;
      removed.push(item.filePath);
    }
    let total = directorySize(this.logDir);
    for (const item of rotated) {
      if (total <= this.totalMaxBytes) break;
      if (item.removed || !fs.existsSync(item.filePath)) continue;
      fs.rmSync(item.filePath, { force: true });
      total -= item.size;
      removed.push(item.filePath);
    }
    return removed;
  }
}

function redact(value, key = "") {
  if (SENSITIVE_KEY.test(key) || HEADER_CONTAINER_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:token|api[_-]?key|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  }
  return value;
}

function queryLogs({ logDir, component = "", level = "", text = "", limit = 200 } = {}) {
  const components = component && COMPONENTS.has(component) ? [component] : [...COMPONENTS];
  const result = [];
  for (const name of components) {
    const files = fs.existsSync(logDir)
      ? fs.readdirSync(logDir).filter((file) => file === `${name}.jsonl` || file.startsWith(`${name}.jsonl.`))
      : [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(logDir, file), "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (level && record.level !== level) continue;
          if (text && !line.toLowerCase().includes(text.toLowerCase())) continue;
          result.push(record);
        } catch {
          // Ignore a partial final line after an interrupted append.
        }
      }
    }
  }
  return result.sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp))).slice(0, limit);
}

function normalizeEvent(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || "event";
}

function directorySize(directory) {
  return fs.readdirSync(directory).reduce((total, name) => {
    const filePath = path.join(directory, name);
    try { const stat = fs.statSync(filePath); return total + (stat.isFile() ? stat.size : 0); } catch { return total; }
  }, 0);
}

module.exports = { ComponentLogger, LEVELS, queryLogs, redact };
