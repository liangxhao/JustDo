'use strict';

// Capability: snapshot and persist the direct parent's stable Gateway session UUID at spawn time.
// Target: pristine openclaw@2026.7.1-2, which persists spawnedBy but not the parent's UUID generation.
// Scope: direct sessions_spawn lineage only; agent request metadata consumes parentSessionId in patch 027.
// Safety: never rewrites parent/child sessionId and preserves native child-session patch fields.
// Remove when: upstream persists a stable direct-parent UUID on child session entries.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'justdo-parent-session-identity';

function transform(content, filePath) {
  if (content.includes('let justDoParentSessionId;')) {
    const parentCommits = content.match(/parentSessionId: justDoParentSessionId/g) ?? [];
    if (
      !content.includes('entry.parentSessionId = patch.parentSessionId.trim()') ||
      !content.includes('loadSessionStore(justDoParentTarget.storePath, { clone: false })') ||
      parentCommits.length !== 2
    ) {
      throw new Error(`${filePath}: partial parent session identity patch`);
    }
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /(if \(typeof patch\.spawnedBy === "string" && patch\.spawnedBy\.trim\(\)\) entry\.spawnedBy = patch\.spawnedBy\.trim\(\);)/,
    `$1
  if (typeof patch.parentSessionId === "string" && patch.parentSessionId.trim()) entry.parentSessionId = patch.parentSessionId.trim();`,
    `${filePath}: child session parent UUID whitelist`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const spawnedByKey = requesterInternalKey;)/,
    `$1
  // ${MARKER}: bind lineage to the parent generation visible at spawn admission.
  let justDoParentSessionId;
  try {
    const justDoParentTarget = resolveGatewaySessionStoreTarget({ cfg, key: spawnedByKey });
    const justDoParentEntry = resolveStoreEntryByKeys(
      loadSessionStore(justDoParentTarget.storePath, { clone: false }),
      justDoParentTarget.storeKeys
    );
    if (typeof justDoParentEntry?.sessionId === "string" && justDoParentEntry.sessionId.trim()) {
      justDoParentSessionId = justDoParentEntry.sessionId.trim();
    }
  } catch {}`,
    `${filePath}: parent UUID snapshot`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const initialPatchError = await patchChildSession\(\{\s*spawnDepth: childDepth,)/,
    '$1\n    ...(justDoParentSessionId ? { parentSessionId: justDoParentSessionId } : {}),',
    `${filePath}: initial child parent UUID commit`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const spawnLineagePatchError = await patchChildSession\(\{\s*spawnedBy: spawnedByKey,)/,
    '$1\n    ...(justDoParentSessionId ? { parentSessionId: justDoParentSessionId } : {}),',
    `${filePath}: lineage parent UUID commit`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function buildDirectChildSessionPatch(patch)',
    'const spawnedByKey = requesterInternalKey;',
    'const spawnLineagePatchError = await patchChildSession({',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) {
    throw new Error(
      `parent session identity target count is ${files.length}, expected ${expected}`,
    );
  }
  const staged = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, ['let justDoParentSessionId;']);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) throw new Error('parent session identity targets are incomplete');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      'entry.parentSessionId = patch.parentSessionId.trim()',
      'loadSessionStore(justDoParentTarget.storePath, { clone: false })',
      'parentSessionId: justDoParentSessionId',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: missing parent identity contract ${contract}`);
      }
    }
  }
}

module.exports = { applyPatch, transform, verifyPatch };
