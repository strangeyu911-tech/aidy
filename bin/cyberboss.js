#!/usr/bin/env node

const { main } = require("../src/index");

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[cyberboss] ${message}`);
  process.exitCode = 1;
  // A fatal error must still end the process. The desktop supervisor only learns
  // about failures from the child `exit` event, so a bridge that has finished its
  // work but keeps the event loop alive — a leftover listening socket, a handle
  // nobody closed — is indistinguishable from a healthy one: the control center
  // keeps reporting "connected" while nothing polls WeChat. `process.exitCode`
  // alone cannot help while the loop is still held. Give stdout a moment to flush,
  // then leave regardless of what is keeping the process up.
  const exitGuard = setTimeout(() => process.exit(1), 3_000);
  exitGuard.unref();
});

