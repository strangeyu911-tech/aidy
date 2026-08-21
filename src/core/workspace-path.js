const path = require("path");

function normalizeWorkspaceRoot(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }

  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return path.win32.normalize(raw);
  }

  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return path.posix.normalize(raw);
  }

  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    return path.win32.normalize(raw);
  }

  return path.normalize(path.resolve(raw));
}

module.exports = { normalizeWorkspaceRoot };
