"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { computeReferenceMs, evaluateFreshness, isPackagedPath, STALE_BRAND_PATTERN } = require("../scripts/check-release-artifacts");

// --- Stale-brand regex: must catch both pre-rebrand brands, never the new one ---

test("STALE_BRAND_PATTERN catches the bare pre-rebrand CyberBoss.exe", () => {
  assert.equal(STALE_BRAND_PATTERN.test("dist/win-unpacked-telemetry/win-unpacked/CyberBoss.exe"), true);
});

test("STALE_BRAND_PATTERN catches CyberBoss-Setup-v and CyberBoss-<ver>-x64", () => {
  assert.equal(STALE_BRAND_PATTERN.test("dist/CyberBoss-Setup-v0.1.0.exe"), true);
  assert.equal(STALE_BRAND_PATTERN.test("dist/CyberBoss-1.2.3-x64.exe"), true);
});

test("STALE_BRAND_PATTERN ignores the new Aidy brand", () => {
  assert.equal(STALE_BRAND_PATTERN.test("dist/Aidy.exe"), false);
  assert.equal(STALE_BRAND_PATTERN.test("dist/Aidy-Setup-v0.1.0.exe"), false);
  assert.equal(STALE_BRAND_PATTERN.test("dist/Aidy-0.1.0-x64.exe"), false);
});

// --- Packaged-path scoping predicate ---

test("isPackagedPath includes only what build.files ships", () => {
  assert.equal(isPackagedPath("package.json"), true);
  assert.equal(isPackagedPath("src/desktop/main.js"), true);
  assert.equal(isPackagedPath("bin/cyberboss.js"), true);
  assert.equal(isPackagedPath("templates/installer.nsi"), true);
  assert.equal(isPackagedPath("native/hook.dll"), true);
  // not packaged
  assert.equal(isPackagedPath("docs/audits/status.md"), false);
  assert.equal(isPackagedPath("README.md"), false);
  assert.equal(isPackagedPath("INSTALL.md"), false);
  assert.equal(isPackagedPath("test/foo.test.js"), false);
  assert.equal(isPackagedPath("dist/Aidy.exe"), false);
});

// --- Freshness reference ignores docs-only working-tree changes ---

function makeTempRepo(commitDate = "2026-01-01T00:00:00+00:00") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-ref-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "gate@example.com"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "gate"], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// packaged\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  // Pin the committer date to the past so a present working-tree change has a
  // clear, deterministic effect on the reference time (and we never need a
  // future timestamp, which some filesystems clamp).
  spawnSync("git", ["commit", "-q", "-m", "initial packaged source"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
  });
  return dir;
}

test("computeReferenceMs ignores a docs-only uncommitted change", () => {
  const dir = makeTempRepo();
  const headOut = spawnSync("git", ["log", "-1", "--format=%cI", "HEAD"], { cwd: dir, encoding: "utf8" });
  const headMs = Date.parse(headOut.stdout.trim());

  // A docs-only change with a deliberately FUTURE mtime. If the unscoped scan
  // (all of `git status --porcelain`) were used, this would push referenceMs
  // into the future and wrongly red-light a fresh package.
  const future = Date.now() + 60_000;
  const docsPath = path.join(dir, "docs", "audits", "status.md");
  fs.mkdirSync(path.dirname(docsPath), { recursive: true });
  fs.writeFileSync(docsPath, "status note\n");
  fs.utimesSync(docsPath, new Date(future), new Date(future));

  const ref = computeReferenceMs(dir);
  assert.ok(ref, "reference should resolve inside a git repo");

  // The docs change must not advance the reference time.
  assert.ok(ref.referenceMs < future - 5000, "docs-only change must not advance the reference time");
  // With only docs changed, reference should still reflect the committed packaged source (HEAD).
  assert.ok(Math.abs(ref.referenceMs - headMs) < 5000, "reference should be the HEAD commit date when only docs changed");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("computeReferenceMs: a packaged commit advances the reference, a docs commit does not", () => {
  const dir = makeTempRepo("2026-01-01T00:00:00+00:00"); // initial packaged source
  // A packaged change committed later.
  fs.writeFileSync(path.join(dir, "src", "index.js"), "// v2\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "-m", "packaged change"], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-03-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-03-01T00:00:00+00:00" },
  });
  // A docs-only commit AFTER the packaged change must not advance the reference.
  const docsPath = path.join(dir, "docs", "audits", "status.md");
  fs.mkdirSync(path.dirname(docsPath), { recursive: true });
  fs.writeFileSync(docsPath, "notes\n");
  spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["commit", "-q", "-m", "docs only"], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-04-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2026-04-01T00:00:00+00:00" },
  });

  const ref = computeReferenceMs(dir);
  assert.ok(ref, "reference should resolve inside a git repo");
  // The docs-only commit (2026-04-01) must NOT advance the reference; the last
  // packaged-touching commit (2026-03-01) should.
  assert.ok(ref.referenceMs > Date.parse("2026-02-01T00:00:00+00:00"), "reference should reflect the packaged change");
  assert.ok(ref.referenceMs < Date.parse("2026-03-15T00:00:00+00:00"), "docs-only commit must not advance the reference past the packaged change");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("evaluateFreshness: a fresh artifact passes, a stale one fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-eval-"));
  const referenceMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const fresh = path.join(dir, "Aidy-0.1.0-x64.exe");
  fs.writeFileSync(fresh, "x");
  fs.utimesSync(fresh, new Date(referenceMs + 60_000), new Date(referenceMs + 60_000));
  const stale = path.join(dir, "Aidy-Setup-v0.1.0.exe");
  fs.writeFileSync(stale, "x");
  fs.utimesSync(stale, new Date(referenceMs - 3_000_000), new Date(referenceMs - 3_000_000));

  const { failures } = evaluateFreshness({
    artifacts: [
      { path: fresh, label: "portable executable", rebuild: "desktop:package:portable" },
      { path: stale, label: "installer", rebuild: "desktop:package" },
    ],
    referenceMs,
    toleranceMs: 2000,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Aidy-Setup-v0\.1\.0\.exe/);
  assert.match(failures[0], /npm run desktop:package/);

  fs.rmSync(dir, { recursive: true, force: true });
});
