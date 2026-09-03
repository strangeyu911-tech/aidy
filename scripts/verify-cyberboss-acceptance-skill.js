'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skillPath = path.join(root, 'docs', 'skills', 'cyberboss-debug-release-acceptance', 'SKILL.md');
const agentsPath = path.join(root, 'AGENTS.md');
const packagePath = path.join(root, 'package.json');

function read(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing required file: ${path.relative(root, filePath)}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`missing ${label}: ${needle}`);
  }
}

const skill = read(skillPath);
const agents = read(agentsPath);
const packageJson = JSON.parse(read(packagePath));

for (const heading of [
  '## ACP / WorkBuddy protocol',
  '## Session / transport lifecycle',
  '## Evidence-first debugging',
  '## Observability',
  '## Source vs actual runtime',
  '## Windows packaged build',
  '## Launch surface',
  '## Real WeChat acceptance',
  '## PASS wording gate',
  '## Runbook cases: symptom → evidence → diagnosis → safe action',
]) {
  assertIncludes(skill, heading, `required section ${heading}`);
}

for (const phrase of [
  'Never infer an ACP contract from a WorkBuddy software version number',
  '`cwd` is verified to work with WorkBuddy 2.132.0',
  '`workingDirectory`',
  '`Invalid params`',
  'persisted session ID',
  'in-process attached session',
  'transport generation',
  'timeout',
  'connection loss',
  'app.asar',
  'source-mode',
  'Start Menu',
  'exactly once',
  'duplicate',
  'proactive flood',
  'FIXED',
  'AVAILABLE',
  'ACCEPTANCE PASS',
  'automated tests pass, real-chain unverified',
]) {
  assertIncludes(skill, phrase, `required rule ${phrase}`);
}

assertIncludes(agents, 'docs/skills/cyberboss-debug-release-acceptance/SKILL.md', 'AGENTS.md skill entry point');
if (packageJson.scripts?.['verify:acceptance-skill'] !== 'node ./scripts/verify-cyberboss-acceptance-skill.js') {
  throw new Error('package.json does not expose verify:acceptance-skill');
}

console.log('CyberBoss Debug / Release Acceptance Skill verification passed.');
