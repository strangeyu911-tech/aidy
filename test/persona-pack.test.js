const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  PersonaPackStore,
  normalizePackId,
} = require("../src/core/persona-pack-store");
const {
  loadWechatInstructions,
  loadPersonaPackInstructions,
  stripFrontMatter,
} = require("../src/adapters/runtime/shared-instructions");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILTIN_PACKS_DIR = path.join(REPO_ROOT, "templates", "personas");

function makeTempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "persona-pack-"));
}

function makeConfig(stateDir) {
  return {
    stateDir,
    weixinInstructionsFile: path.join(REPO_ROOT, "templates", "weixin-instructions.md"),
    weixinOperationsFile: path.join(REPO_ROOT, "templates", "weixin-operations.md"),
    personaPackFile: path.join(stateDir, "persona-pack.json"),
    personaPacksDir: BUILTIN_PACKS_DIR,
    personaPacksUserDir: path.join(stateDir, "personas"),
    userName: "测试用户",
    userGender: "male",
  };
}

function makeStore(config) {
  return new PersonaPackStore({
    stateDir: config.stateDir,
    filePath: config.personaPackFile,
    packsDirs: [config.personaPacksDir, config.personaPacksUserDir],
  });
}

test("persona packs are off by default and leave the instructions untouched", () => {
  const config = makeConfig(makeTempStateDir());
  const instructions = loadWechatInstructions(config);

  assert.equal(loadPersonaPackInstructions(config), "");
  assert.doesNotMatch(instructions, /主线督导层/);
  assert.match(instructions, /写给未来的自己/);
  assert.match(instructions, /Execution Rules/);
});

test("activating a persona pack injects it after the base persona and before operations", () => {
  const config = makeConfig(makeTempStateDir());
  makeStore(config).setActiveId("jiheng");

  const instructions = loadWechatInstructions(config);
  const baseIndex = instructions.indexOf("写给未来的自己");
  const packIndex = instructions.indexOf("主线督导层");
  const operationsIndex = instructions.indexOf("Execution Rules");

  assert.ok(baseIndex >= 0, "base persona should be present");
  assert.ok(packIndex > baseIndex, "persona pack should follow the base persona");
  assert.ok(operationsIndex > packIndex, "operations should follow the persona pack");
  assert.match(instructions, /承认漂移的成本必须低/);
  assert.match(instructions, /这对本周的投递或面试有直接帮助吗/);
});

test("clearing the persona pack restores the default instructions", () => {
  const config = makeConfig(makeTempStateDir());
  const store = makeStore(config);

  store.setActiveId("jiheng");
  assert.match(loadWechatInstructions(config), /主线督导层/);

  store.setActiveId("");
  assert.doesNotMatch(loadWechatInstructions(config), /主线督导层/);
  assert.equal(store.getActiveId(), "");
});

test("unknown and malformed persona pack ids are rejected", () => {
  const store = makeStore(makeConfig(makeTempStateDir()));

  assert.throws(() => store.setActiveId("does-not-exist"), { code: "PERSONA_PACK_UNKNOWN" });
  assert.throws(() => store.setActiveId("../escape"), { code: "PERSONA_PACK_INVALID" });
  assert.throws(() => store.setActiveId("nested/jiheng"), { code: "PERSONA_PACK_INVALID" });
  assert.equal(store.getActiveId(), "");
  assert.equal(normalizePackId("../../etc/passwd"), "");
});

test("user persona packs override built-in packs that share an id", () => {
  const stateDir = makeTempStateDir();
  const config = makeConfig(stateDir);
  const userDir = config.personaPacksUserDir;
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "jiheng.md"), "# 覆盖版\n\n用户自定义内容。\n", "utf8");

  const store = makeStore(config);
  const pack = store.listPackages().find((item) => item.id === "jiheng");

  assert.ok(pack, "jiheng pack should be listed");
  assert.equal(pack.name, "覆盖版");
  assert.equal(path.dirname(pack.filePath), userDir);

  store.setActiveId("jiheng");
  assert.match(loadWechatInstructions(config), /用户自定义内容/);
  assert.doesNotMatch(loadWechatInstructions(config), /承认漂移的成本必须低/);
});

test("persona pack front matter is metadata only and is never injected", () => {
  const raw = "---\nname: 测试\ndescription: 说明\n---\n\n# 标题\n\n正文\n";
  assert.equal(stripFrontMatter(raw), "\n# 标题\n\n正文\n");
  assert.equal(stripFrontMatter("# 没有前置\n"), "# 没有前置\n");

  const config = makeConfig(makeTempStateDir());
  makeStore(config).setActiveId("jiheng");
  const instructions = loadWechatInstructions(config);

  assert.doesNotMatch(instructions, /^---/m);
  assert.doesNotMatch(instructions, /^name: /m);
  assert.doesNotMatch(instructions, /^description: /m);
});

test("activating a pack does not corrupt its text through pronoun substitution", () => {
  const config = makeConfig(makeTempStateDir());
  makeStore(config).setActiveId("jiheng");

  const instructions = loadPersonaPackInstructions(config);
  assert.doesNotMatch(instructions, /她/);
  assert.match(instructions, /纪衡/);
});

test("the UI snapshot exposes registered packs with an empty default", () => {
  const snapshot = makeStore(makeConfig(makeTempStateDir())).snapshot();

  assert.equal(snapshot.activeId, "");
  const ids = snapshot.packages.map((item) => item.id);
  assert.ok(ids.includes("jiheng"), "built-in jiheng pack should be discoverable");
  const jiheng = snapshot.packages.find((item) => item.id === "jiheng");
  assert.equal(jiheng.name, "纪衡 · 主线督导");
});
