'use strict';

// Capability: keep JustDo interactive approvals pending without an expiry timer.
// Target: pristine openclaw@2026.7.1-2, whose manager assigns every approval a fixed timeout.
// Scope: affects only ancestry rooted at agent:*:justdo:*; cron and native channels keep timeouts.
// Safety: explicit null timeout semantics stay native and both record expiry/timer branches are verified.
// Remove when: upstream supports channel/session-specific infinite interactive approval lifetime.

const fs = require('fs');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils');

const CAPABILITY = 'justdo-persistent-approval-lifetime';

function transform(content, filePath) {
  if (content.includes('function isJustDoInteractiveApproval(')) return content;

  let updated = replaceUnique(
    content,
    'import { C as resolveExpiresAtMsFromDurationMs, j as resolveTimerTimeoutMs } from "./number-coercion-CJQ8TR--.js";',
    `import { C as resolveExpiresAtMsFromDurationMs, j as resolveTimerTimeoutMs } from "./number-coercion-CJQ8TR--.js";
import { S as loadSessionStore } from "./store-BJJhlPrk.js";
import { p as resolveAgentIdFromSessionKey } from "./session-key-VWT_xzM9.js";
import { d as resolveStorePath } from "./paths-C2C4lJH6.js";`,
    `${filePath}: persisted ancestry imports`,
  );

  updated = replaceUniquePattern(
    updated,
    /function resolveApprovalTimeoutMs\(timeoutMs\) \{\s*return resolveTimerTimeoutMs\(timeoutMs, 1\);?\s*\}/,
    `function isJustDoInteractiveApproval(request, timeoutMs) {
  if (timeoutMs === null) return false;
  let sessionKey = normalizeOptionalString(request?.sessionKey);
  const visited = new Set();
  for (let depth = 0; sessionKey && depth < 32; depth += 1) {
    if (visited.has(sessionKey)) return false;
    visited.add(sessionKey);
    if (/^agent:[^:]+:justdo:/.test(sessionKey)) return true;
    try {
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const store = loadSessionStore(resolveStorePath(void 0, { agentId }));
      sessionKey = normalizeOptionalString(store?.[sessionKey]?.spawnedBy);
    } catch {
      return false;
    }
  }
  return false;
}
// ${CAPABILITY}
function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}`,
    `${filePath}: approval helper`,
  );

  updated = replaceUniquePattern(
    updated,
    /const expiresAtMs = resolveExpiresAtMsFromDurationMs\(resolveApprovalTimeoutMs\(timeoutMs\), \{ nowMs: now \}\);/,
    'const expiresAtMs = isJustDoInteractiveApproval(request, timeoutMs)\n' +
      '  ? Number.MAX_SAFE_INTEGER\n' +
      '  : resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });',
    `${filePath}: persistent expiry`,
  );

  updated = replaceUniquePattern(
    updated,
    /const timerDelayMs = resolveApprovalTimeoutMs\(timeoutMs\);\s*entry\.timer = setTimeout\(\(\) => \{\s*this\.expire\((record\w*)\.id\);\s*\}, timerDelayMs\);/,
    (_match, recordName) =>
      `if (!isJustDoInteractiveApproval(${recordName}.request, timeoutMs)) {
          const timerDelayMs = resolveApprovalTimeoutMs(timeoutMs);
          entry.timer = setTimeout(() => {
            this.expire(${recordName}.id);
          }, timerDelayMs);
        }`,
    `${filePath}: persistent timer`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'approval expiry is unavailable',
    'resolveApprovalTimeoutMs(timeoutMs)',
  ]);
  const expected = fs.existsSync(require('path').join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) {
    throw new Error(`approval manager target count is ${files.length}, expected ${expected}`);
  }
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) changed.push(filePath);
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, ['approval expiry is unavailable']);
  const expected = fs.existsSync(require('path').join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`approval manager target count is ${files.length}, expected ${expected}`);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('function isJustDoInteractiveApproval(')) {
      throw new Error(`${filePath}: approval classifier is missing`);
    }
    if (!content.includes('Number.MAX_SAFE_INTEGER'))
      throw new Error(`${filePath}: persistent expiry is missing`);
    if (!content.includes('if (!isJustDoInteractiveApproval(')) {
      throw new Error(`${filePath}: persistent timer guard is missing`);
    }
    if (!content.includes('/^agent:[^:]+:justdo:/.test(sessionKey)')) {
      throw new Error(`${filePath}: persisted JustDo ancestry classification is missing`);
    }
    if (!/\w+\?\.\[sessionKey\]\?\.spawnedBy/.test(content)) {
      throw new Error(`${filePath}: spawnedBy ancestry traversal is missing`);
    }
    if (!content.includes('if (timeoutMs === null) return false')) {
      throw new Error(`${filePath}: explicit null timeout semantics were changed`);
    }
  }
}

module.exports = { applyPatch, transform, verifyPatch };
