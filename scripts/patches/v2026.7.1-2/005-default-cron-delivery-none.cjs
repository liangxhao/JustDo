'use strict';

// Capability: default targetless cron agent/command jobs to delivery mode "none".
// Target: pristine openclaw@2026.7.1-2, which still defaults detached jobs to "announce".
// Scope: changes only an omitted delivery value; explicit delivery configuration is untouched.
// Safety: native default and schema text are independently located and verified after replacement.
// Remove when: upstream uses "none" for targetless cron turns by default.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUniquePattern,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const DEFAULT_ANNOUNCE =
  'if (!("delivery" in next && next.delivery !== void 0) && isDetachedDeliveryJob && (payloadKind === "agentTurn" || payloadKind === "command")) next.delivery = { mode: "announce" };';
const DEFAULT_NONE =
  'if (!("delivery" in next && next.delivery !== void 0) && isDetachedDeliveryJob && (payloadKind === "agentTurn" || payloadKind === "command")) next.delivery = { mode: "none" };';
const HELP_ANNOUNCE = '  - isolated agentTurn default when omitted: "announce"';
const HELP_NONE = '  - isolated agentTurn default when omitted: "none"';
const INFERRED_BRANCH = `                if (inferred) job.delivery = {
                  ...inferred,
                  ...delivery
                };`;
const INFERRED_OR_NONE_BRANCH = `                if (inferred) job.delivery = {
                  ...inferred,
                  ...delivery
                };
                else job.delivery = { mode: "none" };`;
const INFERRED_PATTERN =
  /([ \t]*)if \(inferred\) job\.delivery = \{\r?\n\1[ \t]+\.\.\.inferred,\r?\n\1[ \t]+\.\.\.delivery\r?\n\1\};/;

function collectTargets(runtimeDir) {
  const targets = new Map();
  for (const filePath of findFilesContaining(runtimeDir, 'isDetachedDeliveryJob')) {
    targets.set(filePath, 'normalize');
  }
  for (const filePath of findFilesContaining(runtimeDir, HELP_ANNOUNCE)) {
    targets.set(filePath, targets.has(filePath) ? 'both' : 'tool');
  }
  for (const filePath of findFilesContaining(runtimeDir, HELP_NONE)) {
    if (!targets.has(filePath)) targets.set(filePath, 'patched-tool');
  }
  return targets;
}

function transform(filePath, kind) {
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  if (kind === 'normalize' || kind === 'both') {
    if (updated.includes(DEFAULT_ANNOUNCE)) {
      updated = replaceUnique(updated, DEFAULT_ANNOUNCE, DEFAULT_NONE, 'cron default delivery');
    } else if (!updated.includes(DEFAULT_NONE)) {
      throw new Error(`cron default delivery shape is unknown: ${filePath}`);
    }
  }
  if (kind === 'tool' || kind === 'both') {
    updated = replaceUnique(updated, HELP_ANNOUNCE, HELP_NONE, 'cron delivery help');
    if (INFERRED_PATTERN.test(updated)) {
      updated = replaceUniquePattern(
        updated,
        INFERRED_PATTERN,
        (_match, indent) =>
          `${indent}if (inferred) job.delivery = {\n${indent}  ...inferred,\n${indent}  ...delivery\n${indent}};\n${indent}else job.delivery = { mode: "none" };`,
        'cron targetless announce fallback',
      );
    } else if (!updated.includes('else job.delivery = { mode: "none" };')) {
      throw new Error(`cron inference branch shape is unknown: ${filePath}`);
    }
  }
  return { filePath, original, updated };
}

function applyPatch(runtimeDir) {
  const targets = collectTargets(runtimeDir);
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const expected = fs.existsSync(bundlePath) ? 3 : 2;
  if (targets.size !== expected) {
    throw new Error(`cron delivery target count is ${targets.size}, expected ${expected}`);
  }
  const changes = [...targets].map(([filePath, kind]) => transform(filePath, kind));
  return changes
    .filter(({ filePath, original, updated }) => writeIfChanged(filePath, original, updated))
    .map(({ filePath }) => path.relative(runtimeDir, filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, HELP_NONE).filter(filePath =>
    filePath.endsWith('gateway-bundle.mjs'),
  );
  if (files.length !== 1) {
    throw new Error('patched cron delivery contract is missing from gateway bundle');
  }
  const content = fs.readFileSync(files[0], 'utf8');
  for (const required of [DEFAULT_NONE, 'else job.delivery = { mode: "none" };']) {
    if (!content.includes(required))
      throw new Error(`missing cron delivery verification: ${required}`);
  }
  if (content.includes(HELP_ANNOUNCE) || content.includes(DEFAULT_ANNOUNCE)) {
    throw new Error('native announce default remains after cron patch');
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    DEFAULT_ANNOUNCE,
    DEFAULT_NONE,
    HELP_ANNOUNCE,
    HELP_NONE,
    INFERRED_BRANCH,
    INFERRED_OR_NONE_BRANCH,
  },
};
