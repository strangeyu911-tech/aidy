# CyberBoss local agent instructions

CyberBoss has no repository-native Skill loader. Treat the following file as the
project-local Debug / Release Acceptance Skill and read it before debugging,
changing, packaging, or declaring acceptance for the CodeBuddy / WorkBuddy
runtime or the Windows desktop release:

[`docs/skills/cyberboss-debug-release-acceptance/SKILL.md`](docs/skills/cyberboss-debug-release-acceptance/SKILL.md)

Run its structural self-check with:

```text
npm run verify:acceptance-skill
```

The skill is a runbook and evidence contract, not a replacement for runtime
tests. It must not be used to claim a packaged or real-chain pass without the
corresponding evidence gates described there.
