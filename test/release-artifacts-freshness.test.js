"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { evaluateFreshness } = require("../scripts/check-release-artifacts");

const TOLERANCE_MS = 2000;

function makeArtifact(dir, name, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "build-output");
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
  return { path: filePath, label: name, rebuild: "desktop:package" };
}

test("fresh artifact (mtime after reference) passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-fresh-"));
  const referenceMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const artifact = makeArtifact(dir, "Aidy-0.1.0-x64.exe", referenceMs + 60_000);
  const { failures } = evaluateFreshness({ artifacts: [artifact], referenceMs, toleranceMs: TOLERANCE_MS });
  assert.equal(failures.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale artifact (mtime before reference) fails and names the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-stale-"));
  const referenceMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const artifact = makeArtifact(dir, "Aidy-0.1.0-x64.exe", referenceMs - 3_000_000);
  const { failures } = evaluateFreshness({ artifacts: [artifact], referenceMs, toleranceMs: TOLERANCE_MS });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Aidy-0\.1\.0-x64\.exe/);
  assert.match(failures[0], /predates source reference/);
  assert.match(failures[0], /npm run desktop:package/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tolerance window absorbs a couple seconds of skew", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tol-"));
  const referenceMs = Date.UTC(2026, 0, 1, 0, 0, 0);

  // Within tolerance: should pass.
  const inside = makeArtifact(dir, "inside.exe", referenceMs - 1500);
  const insideResult = evaluateFreshness({ artifacts: [inside], referenceMs, toleranceMs: TOLERANCE_MS });
  assert.equal(insideResult.failures.length, 0);

  // Outside tolerance: should fail.
  const outside = makeArtifact(dir, "outside.exe", referenceMs - 2500);
  const outsideResult = evaluateFreshness({ artifacts: [outside], referenceMs, toleranceMs: TOLERANCE_MS });
  assert.equal(outsideResult.failures.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("missing artifact is skipped (the name checks report it instead)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-missing-"));
  const referenceMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const artifact = { path: path.join(dir, "does-not-exist.exe"), label: "installer", rebuild: "desktop:package" };
  const { failures } = evaluateFreshness({ artifacts: [artifact], referenceMs, toleranceMs: TOLERANCE_MS });
  assert.equal(failures.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
