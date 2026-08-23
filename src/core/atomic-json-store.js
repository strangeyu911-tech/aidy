const fs = require("fs");
const path = require("path");

class AtomicJsonStore {
  constructor({ filePath, defaultValue, normalize = (value) => value, onCorrupt = null }) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
    this.normalize = normalize;
    this.onCorrupt = onCorrupt;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return clone(this.defaultValue);
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return this.normalize(parsed);
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
      } catch {
        // Preserve the original in place even if a diagnostic copy cannot be made.
      }
      this.onCorrupt?.({ error, filePath: this.filePath, backupPath });
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
    return clone(normalized);
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
