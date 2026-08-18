'use strict';

// Capability: let JustDo receive live Thinking output even without an optional callback.
// Target: pristine openclaw@2026.7.1-2, whose streamReasoning state is callback-gated.
// Scope: removes only the callback term from the native reasoning-mode eligibility expression.
// Safety: the existing mode/thinking gates and the callback guard at invocation remain intact.
// Remove when: upstream reasoning event publication no longer depends on callback presence.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const TARGET_CONTEXT = 'function subscribeEmbeddedAgentSession(params) {';
const PRISTINE_PATTERN =
  /streamReasoning:\s*\(params\.streamReasoningInNonStreamModes === true \? reasoningMode !== "on" : reasoningMode === "stream"\) && canShowReasoning && typeof params\.onReasoningStream === "function",/g;
const PATCHED_PATTERN =
  /streamReasoning:\s*\(params\.streamReasoningInNonStreamModes === true \? reasoningMode !== "on" : reasoningMode === "stream"\) && canShowReasoning,/g;
const CALLBACK_GUARD_PATTERN =
  /\bstate(?:\d+)?\.streamReasoning\s*&&[^\n]{0,240}\bparams\.onReasoningStream\b[^\n]{0,80}\bparams\.onReasoningStream\s*\(/g;

function countPattern(content, pattern) {
  pattern.lastIndex = 0;
  return [...content.matchAll(pattern)].length;
}

function locateTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [TARGET_CONTEXT, 'streamReasoning:']);
}

function applyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const targets = locateTargets(runtimeDir);
  if (targets.length !== expected) {
    throw new Error(`reasoning stream target count ${targets.length}, expected ${expected}`);
  }

  const staged = targets.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const pristineCount = countPattern(original, PRISTINE_PATTERN);
    const patchedCount = countPattern(original, PATCHED_PATTERN);
    if (pristineCount === 0 && patchedCount === 1) return { filePath, original, updated: original };
    if (pristineCount !== 1 || patchedCount !== 0) {
      throw new Error(
        `${filePath}: reasoning eligibility is neither pristine nor completely patched ` +
          `(pristine=${pristineCount}, patched=${patchedCount})`,
      );
    }
    const updated = replaceUniquePattern(
      original,
      PRISTINE_PATTERN,
      'streamReasoning: (params.streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && canShowReasoning,',
      `${filePath}: callback-independent reasoning eligibility`,
    );
    return { filePath, original, updated };
  });

  const changed = staged
    .filter(entry => writeIfChanged(entry.filePath, entry.original, entry.updated))
    .map(entry => path.relative(runtimeDir, entry.filePath));
  verifyPatch(runtimeDir);
  return changed;
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const targets = locateTargets(runtimeDir);
  if (targets.length !== expected) {
    throw new Error(
      `reasoning stream verification target count ${targets.length}, expected ${expected}`,
    );
  }
  for (const filePath of targets) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countPattern(content, PRISTINE_PATTERN) !== 0 ||
      countPattern(content, PATCHED_PATTERN) !== 1
    ) {
      throw new Error(`${filePath}: callback-independent reasoning eligibility is incomplete`);
    }
    if (countPattern(content, CALLBACK_GUARD_PATTERN) !== 1) {
      throw new Error(`${filePath}: optional reasoning callback invocation guard is missing`);
    }
    if (!content.includes('emitAgentEvent({') || !content.includes('stream: "thinking"')) {
      throw new Error(`${filePath}: native reasoning event publication is missing`);
    }
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
