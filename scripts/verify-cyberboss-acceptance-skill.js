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

function assertPattern(text, pattern, label) {
  if (!pattern.test(text)) {
    throw new Error(`missing ${label}: ${pattern}`);
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
  '## Incident Scene Preservation',
  '### Phase A — Live Incident RCA',
  '### Phase B — Future Observability Hardening',
  '## Destructive Diagnostic Gate',
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

for (const [pattern, label] of [
  [/Incident Scene Preservation|live incident/i, 'live incident preservation'],
  [/destructive diagnostic action/i, 'destructive diagnostic action'],
  [/A\s+restarted\s+or\s+replaced\s+instance\s+cannot\s+prove\s+the\s+root\s+cause\s+of\s+the\s+previous\s+live\s+incident/i,
    'restart does not prove the previous root cause'],
  [/Phase A[\s\S]*?Live Incident RCA/i, 'Live Incident RCA phase'],
  [/Phase B[\s\S]*?Future Observability Hardening/i, 'future observability-hardening phase'],
  [/Live Incident\s+Evidence Snapshot[\s\S]*?Before any destructive diagnostic action/i,
    'evidence snapshot before destructive action'],
  [/RECOVERED_BUT_ROOT_CAUSE_NOT_PROVEN/i, 'recovery-without-proof verdict'],
  [/availability-first[\s\S]*?exception|Exception[\s\S]*?availability-first/i,
    'availability-first exception'],
]) {
  assertPattern(skill, pattern, label);
}

for (const [pattern, label] of [
  [/Has\s+enough\s+evidence/i, 'Has enough evidence'],
  [/destroy\s+or\s+change\s+the\s+failure\s+state/i, 'destroy or change the failure state'],
  [/non-destructive/i, 'non-destructive'],
  [/old\s+root\s+cause[\s\S]*?proven/i, 'old root cause still be proven'],
  [/RECOVERED_BUT_ROOT_CAUSE_NOT_PROVEN/i, 'RECOVERED_BUT_ROOT_CAUSE_NOT_PROVEN'],
]) {
  assertPattern(skill, pattern, `destructive diagnostic gate question ${label}`);
}

assertIncludes(agents, 'docs/skills/cyberboss-debug-release-acceptance/SKILL.md', 'AGENTS.md skill entry point');
if (packageJson.scripts?.['verify:acceptance-skill'] !== 'node ./scripts/verify-cyberboss-acceptance-skill.js') {
  throw new Error('package.json does not expose verify:acceptance-skill');
}

console.log('CyberBoss Debug / Release Acceptance Skill verification passed.');
