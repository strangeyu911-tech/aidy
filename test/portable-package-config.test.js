"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const packageJson = require("../package.json");
const {
  BROKEN_LOGIC,
  FIXED_LOGIC,
  patchPortableUnpackLogic,
} = require("../scripts/build-portable");

test("portable builds use a launch-unique extraction directory", () => {
  assert.equal(packageJson.build?.portable?.unpackDirName, false);
  assert.equal(
    packageJson.scripts?.["desktop:package:portable"],
    "node ./scripts/build-portable.js",
  );
});

test("portable build wrapper corrects electron-builder false handling", () => {
  assert.equal(patchPortableUnpackLogic(`before\n${BROKEN_LOGIC}\nafter`), `before\n${FIXED_LOGIC}\nafter`);
  assert.throws(
    () => patchPortableUnpackLogic("unknown implementation"),
    /refusing to patch an unknown version/,
  );
});
