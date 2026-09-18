"use strict";

// Release gate for audit item P2-6.
//
// The 2026-09-18 audit found two mutually inconsistent build directories and an
// installer filename that did not exist under the name INSTALL.md promised, so a
// first external tester would have installed a stale, differently-branded build
// and reported product bugs that were really packaging bugs. This turns the
// naming promises into a check that fails loudly instead of a paragraph nobody
// re-reads before shipping.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const pkg = require(path.join(rootDir, "package.json"));
const build = pkg.build || {};
const distDir = path.resolve(process.env.CYBERBOSS_ARTIFACT_DIST_DIR || path.join(rootDir, "dist"));
const STALE_BRAND_PATTERN = /CyberBoss-(?:Setup-v[\d.]+|\d[\d.]*-x64)\.exe$/i;
// A directory can opt out of the stale-brand scan by carrying this marker, which
// is how the 2026-08-30 pre-rebrand build is kept for comparison without being
// mistaken for a release. The marker has to be deliberate: an unmarked
// directory containing the old brand still fails the check.
const STALE_MARKER = "STALE-DO-NOT-SHIP.md";

function expand(pattern, values) {
  return String(pattern).replace(/\$\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

const version = pkg.version;
const arch = process.arch === "ia32" ? "ia32" : "x64";
const expectedInstaller = expand(build.nsis?.artifactName || "Aidy-Setup-v${version}.${ext}", { version, arch, ext: "exe" });
const expectedPortable = expand(build.artifactName || "Aidy-${version}-${arch}.${ext}", { version, arch, ext: "exe" });

const failures = [];
const notes = [];

function main() {
  checkDistExists();
  checkExpectedArtifacts();
  checkDocumentedNames();
  checkNoStaleBrand();
  checkFreshness({ failures, notes });

  const asar = readAsarDigest();
  if (asar) notes.push(`app.asar sha256=${asar.sha256} bytes=${asar.bytes} mtime=${asar.mtime}`);

  if (failures.length) {
    process.stderr.write(`[release-check] ${failures.length} problem(s) found:\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write("\nExpected installer name comes from build.nsis.artifactName; see INSTALL.md for what users are told.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write([
      "[release-check] ok",
      `version=${version}`,
      `installer=${expectedInstaller}`,
      `portable=${expectedPortable}`,
      ...notes,
    ].join("\n") + "\n");
  }
}

// Freshness gate: a shipped artifact must not predate the source it is supposed
// to contain. A developer can refresh the installer (`npm run desktop:package`)
// and leave a months-old portable executable next to it; this fails loudly.
function checkFreshness({ failures, notes }) {
  if (!fs.existsSync(distDir)) return;
  const reference = computeReferenceMs(rootDir);
  if (!reference) {
    notes.push("freshness gate skipped: git unavailable or not a repository");
    return;
  }
  const artifacts = [
    { path: path.join(distDir, expectedInstaller), label: "installer", rebuild: "desktop:package" },
    { path: path.join(distDir, expectedPortable), label: "portable executable", rebuild: "desktop:package:portable" },
    { path: path.join(distDir, "win-unpacked", "resources", "app.asar"), label: "app.asar", rebuild: "desktop:package" },
  ];
  const toleranceMs = 2000;
  const { failures: freshFailures } = evaluateFreshness({ artifacts, referenceMs: reference.referenceMs, toleranceMs });
  for (const failure of freshFailures) failures.push(failure);
}

// The reference time is the newest of the HEAD committer date and the newest
// mtime among tracked-and-modified working-tree files. Returns null when git is
// unavailable or the directory is not a repository, so callers can degrade
// gracefully instead of hard-failing the gate.
function computeReferenceMs(rootDir) {
  let headMs = null;
  try {
    const out = spawnSync("git", ["log", "-1", "--format=%cI", "HEAD"], { cwd: rootDir, encoding: "utf8" });
    if (out.status === 0 && out.stdout.trim()) {
      const parsed = Date.parse(out.stdout.trim());
      if (!Number.isNaN(parsed)) headMs = parsed;
    }
  } catch {
    // git not available
  }

  let modifiedMs = null;
  try {
    const out = spawnSync("git", ["status", "--porcelain"], { cwd: rootDir, encoding: "utf8" });
    if (out.status === 0) {
      let maxMs = 0;
      for (const rawLine of out.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("??")) continue; // untracked: not part of committed source
        const arrowIdx = line.indexOf(" -> ");
        const relPath = arrowIdx !== -1 ? line.slice(arrowIdx + 4).trim() : line.slice(3).trim();
        if (!relPath) continue;
        try {
          const mtimeMs = fs.statSync(path.join(rootDir, relPath)).mtimeMs;
          if (mtimeMs > maxMs) maxMs = mtimeMs;
        } catch {
          // ignore paths that cannot be stated
        }
      }
      if (maxMs > 0) modifiedMs = maxMs;
    }
  } catch {
    // git not available
  }

  if (headMs === null && modifiedMs === null) return null;
  return { referenceMs: Math.max(headMs ?? 0, modifiedMs ?? 0), headMs, modifiedMs };
}

// Pure freshness check. `artifacts` is an array of { path, label, rebuild }.
// An artifact is stale when its mtime is older than the source reference by more
// than the tolerance window. Returns { failures } (missing files are skipped:
// the name checks already report them).
function evaluateFreshness({ artifacts, referenceMs, toleranceMs }) {
  const failures = [];
  for (const artifact of artifacts) {
    let stat;
    try {
      stat = fs.statSync(artifact.path);
    } catch {
      continue;
    }
    if (stat.mtimeMs < referenceMs - toleranceMs) {
      const rel = path.relative(rootDir, artifact.path);
      failures.push(
        `stale ${artifact.label} ${rel} (mtime ${new Date(stat.mtimeMs).toISOString()}) predates source reference ` +
        `${new Date(referenceMs).toISOString()}; rebuild with \`npm run ${artifact.rebuild}\``
      );
    }
  }
  return { failures };
}

if (require.main === module) main();

module.exports = { computeReferenceMs, evaluateFreshness };

function checkDistExists() {
  if (!fs.existsSync(distDir)) {
    failures.push(`build output directory does not exist: ${distDir} (run \`npm run desktop:package\`)`);
  }
}

function checkExpectedArtifacts() {
  if (!fs.existsSync(distDir)) return;
  const installerPath = path.join(distDir, expectedInstaller);
  const portablePath = path.join(distDir, expectedPortable);
  assertNonEmptyFile(installerPath, "installer");
  assertNonEmptyFile(portablePath, "portable executable");
  const daemon = path.join(distDir, "win-unpacked", "resources", "app.asar");
  assertNonEmptyFile(daemon, "packaged app.asar");
}

function assertNonEmptyFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing ${label}: ${path.relative(rootDir, filePath)}`);
    return;
  }
  if (fs.statSync(filePath).size === 0) {
    failures.push(`empty ${label}: ${path.relative(rootDir, filePath)}`);
  }
}

// Every installer name written down in user-facing docs must be a file that
// actually gets produced, otherwise the instructions cannot be followed.
function checkDocumentedNames() {
  const docs = [
    "INSTALL.md",
    "README.md",
    "README.zh-CN.md",
    "docs/release/FIRST-EXTERNAL-TESTER-CHECKLIST.md",
  ];
  const allowed = new Set([expectedInstaller, expectedPortable]);
  for (const relative of docs) {
    const filePath = path.join(rootDir, relative);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    for (const match of text.matchAll(/([A-Za-z][A-Za-z0-9.]*-(?:Setup-v[0-9][^\s`'"()]*|[0-9][^\s`'"()]*-x64)\.exe)/g)) {
      const name = match[1];
      if (!allowed.has(name)) {
        failures.push(`${relative} tells the user to open "${name}", but the build produces "${expectedInstaller}"`);
      }
    }
  }
}

// A stale-branded installer is worse than a missing one: it looks shippable.
function checkNoStaleBrand() {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^dist(?:-|$)/.test(entry.name)) continue;
    const directory = path.join(rootDir, entry.name);
    if (fs.existsSync(path.join(directory, STALE_MARKER))) {
      notes.push(`skipped ${entry.name} (marked ${STALE_MARKER})`);
      continue;
    }
    for (const file of listFiles(directory)) {
      if (STALE_BRAND_PATTERN.test(file)) {
        failures.push(`stale pre-rebrand installer still present: ${path.relative(rootDir, file)} (remove it, or quarantine it in a directory with a ${STALE_MARKER} marker)`);
      }
    }
  }
}

function readAsarDigest() {
  const asarPath = path.join(distDir, "win-unpacked", "resources", "app.asar");
  if (!fs.existsSync(asarPath)) return null;
  const buffer = fs.readFileSync(asarPath);
  const stats = fs.statSync(asarPath);
  return {
    sha256: crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase(),
    bytes: buffer.length,
    mtime: stats.mtime.toISOString(),
  };
}

function listFiles(directory) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...listFiles(full));
    else results.push(full);
  }
  return results;
}
