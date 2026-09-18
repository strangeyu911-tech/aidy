const fs = require("fs");
const path = require("path");

class AtomicJsonStore {
  constructor({ filePath, defaultValue, normalize = (value) => value, onCorrupt = null }) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.normalize = normalize;
    this.onCorrupt = onCorrupt;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Read cache keyed on mtime + size. Returns deep clones of `_cache.parsed`,
    // so callers may mutate freely without corrupting the shared cached object.
    this._cache = null;
  }

  _statSafe(filePath) {
    try {
      return fs.statSync(filePath);
    } catch {
      return null;
    }
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      this._cache = null;
      return clone(this.defaultValue);
    }
    const stat = this._statSafe(this.filePath);
    // Cache hit: the file is unchanged since the last read (same mtime and size),
    // so we skip readFileSync + JSON.parse entirely. This is how we keep the
    // per-second due() polling cheap even when the plan grows to thousands of entries.
    if (stat && this._cache && stat.mtimeMs === this._cache.mtimeMs && stat.size === this._cache.size) {
      return clone(this._cache.parsed);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const normalized = this.normalize(parsed);
      if (stat) this._cache = { mtimeMs: stat.mtimeMs, size: stat.size, parsed: normalized };
      return clone(normalized);
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
      } catch {
        // Preserve the original in place even if a diagnostic copy cannot be made.
      }
      this.onCorrupt?.({ error, filePath: this.filePath, backupPath });
      this._cache = null;
      return clone(this.defaultValue);
    }
  }

  write(value) {
    const normalized = this.normalize(value);
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Ignore cleanup failure and preserve the original error.
      }
      throw error;
    }
    this._invalidateCache();
    return clone(normalized);
  }

  _invalidateCache() {
    this._cache = null;
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(clone(current));
    return this.write(next === undefined ? current : next);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

module.exports = { AtomicJsonStore };
