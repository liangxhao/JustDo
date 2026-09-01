'use strict';

// Capability: let a host-authorized forced memory rebuild recompute cached embeddings.
// Target: openclaw@2026.8.1 builtin memory manager source.
// Scope: copying the old embedding cache into the shadow reindex database only.
// Safety: exact env opt-in; the original database stays intact until the atomic publish succeeds.
// Remove when: upstream memory index exposes an equivalent no-cache or re-embed CLI option.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_MEMORY_FORCE_REEMBED_OPT_IN_V2026_8_1';
const FUNCTION_SIGNATURE = 'async runInPlaceReindex(params) {';
const CACHE_SEED = 'await this.seedEmbeddingCache(originalDb);';
const OPT_IN_ENV = 'JUSTDO_MEMORY_REINDEX_NO_CACHE';
const PATCHED_CACHE_SEED = `if (process.env.${OPT_IN_ENV} !== "1") ${CACHE_SEED} // ${MARKER}`;

function transformMemoryManager(content, filePath) {
  const signatureCount = countOccurrences(content, FUNCTION_SIGNATURE);
  const cacheSeedCount = countOccurrences(content, CACHE_SEED);
  const markerCount = countOccurrences(content, MARKER);
  const patchedCount = countOccurrences(content, PATCHED_CACHE_SEED);
  if (signatureCount === 1 && cacheSeedCount === 1 && markerCount === 1 && patchedCount === 1) {
    return content;
  }
  if (patchedCount !== 0 || markerCount !== 0) {
    throw new Error(
      `${filePath}: partial memory force-reembed opt-in patch detected ` +
        `(signature=${signatureCount}, cacheSeed=${cacheSeedCount}, ` +
        `marker=${markerCount}, patched=${patchedCount})`,
    );
  }
  if (signatureCount !== 1 || cacheSeedCount !== 1) {
    throw new Error(
      `${filePath}: memory reindex cache-seed contract is ambiguous ` +
        `(signature=${signatureCount}, cacheSeed=${cacheSeedCount})`,
    );
  }

  return replaceUniquePattern(
    content,
    /^([ \t]*)await this\.seedEmbeddingCache\(originalDb\);[ \t]*$/m,
    `$1${PATCHED_CACHE_SEED}`,
    `${filePath}: memory reindex cache seed`,
  );
}

function locateTargets(runtimeDir) {
  const targets = new Set(findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, CACHE_SEED]));
  for (const filePath of findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, MARKER])) {
    targets.add(filePath);
  }
  if (targets.size !== 1) {
    throw new Error(`Memory force-reembed opt-in target count is ${targets.size}, expected 1`);
  }
  return [...targets];
}

function applyPatch(runtimeDir) {
  const staged = locateTargets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transformMemoryManager(original, filePath);
    return { filePath, original, updated };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countOccurrences(content, FUNCTION_SIGNATURE) !== 1 ||
      countOccurrences(content, CACHE_SEED) !== 1 ||
      countOccurrences(content, MARKER) !== 1 ||
      countOccurrences(content, PATCHED_CACHE_SEED) !== 1
    ) {
      throw new Error(`${filePath}: memory force-reembed opt-in contract is incomplete`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    CACHE_SEED,
    FUNCTION_SIGNATURE,
    MARKER,
    OPT_IN_ENV,
    PATCHED_CACHE_SEED,
    transformMemoryManager,
  },
};
