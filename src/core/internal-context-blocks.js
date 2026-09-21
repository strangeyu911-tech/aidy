"use strict";

/**
 * Single implementation of "strip the internal context blocks out of a text".
 *
 * Supervision appends machine-facing context to a turn's text before it reaches
 * the model, for example:
 *
 *   user text
 *
 *   [Zhijiantime daily supervision — verified data]
 *   {...}
 *
 * Those blocks must never reach a delivered message, the persisted session
 * transcript, or the user-turn digest that re-states what was already sent.
 * Every caller that needs to remove them uses this module: keeping one
 * implementation is a hard requirement, because a second one silently drifts
 * and leaks a block.
 *
 * Blocks are always appended as a suffix (`text + "\n\n" + context`), so the
 * strip cuts from the first recognized block header to the end of the text. A
 * header that appears mid-line keeps the safe prefix of that line and still
 * drops the rest.
 */

const INTERNAL_CONTEXT_PREFIXES = Object.freeze(["[Zhijiantime", "[CyberBoss"]);

function findInternalContextBlockIndex(value) {
  const line = String(value == null ? "" : value);
  let best = -1;
  for (const prefix of INTERNAL_CONTEXT_PREFIXES) {
    let from = 0;
    for (;;) {
      const index = line.indexOf(prefix, from);
      if (index < 0) {
        break;
      }
      const previous = index > 0 ? line[index - 1] : "";
      if (index === 0 || /\s|[(（]/.test(previous)) {
        if (best < 0 || index < best) {
          best = index;
        }
        break;
      }
      from = index + prefix.length;
    }
  }
  return best;
}

function stripInternalContextBlocks(text) {
  const normalized = normalizeLineEndings(String(text == null ? "" : text));
  if (!normalized.trim()) {
    return "";
  }
  const kept = [];
  for (const line of normalized.split("\n")) {
    const index = findInternalContextBlockIndex(line);
    if (index >= 0) {
      const head = line.slice(0, index).trimEnd();
      if (head) {
        kept.push(head);
      }
      break;
    }
    kept.push(line);
  }
  return trimOuterBlankLines(kept.join("\n"));
}

function containsInternalContextBlock(text) {
  return normalizeLineEndings(String(text == null ? "" : text))
    .split("\n")
    .some((line) => findInternalContextBlockIndex(line) >= 0);
}

function normalizeLineEndings(value) {
  return String(value).replace(/\r\n?/g, "\n");
}

function trimOuterBlankLines(value) {
  const lines = String(value).split("\n");
  while (lines.length && !lines[0].trim()) {
    lines.shift();
  }
  while (lines.length && !lines[lines.length - 1].trim()) {
    lines.pop();
  }
  return lines.join("\n");
}

module.exports = {
  INTERNAL_CONTEXT_PREFIXES,
  containsInternalContextBlock,
  findInternalContextBlockIndex,
  stripInternalContextBlocks,
};
