'use strict';

// Capability: compare the admitted session database path with node:sqlite's
// Windows namespaced filename without widening database or creation ownership.
// Target: v2026.9.8 native creation publication guard (4 source copies + bundle).
// Scope: only creation publication path membership; both sides use native path normalization.
// Safety: no case folding or filesystem lookup; preserve exact agent, key and current-owner checks.
// Remove when: upstream canonicalizes both spellings before this exact comparison.
const fs = require('node:fs');
const path = require('node:path');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const CONTRACT = 'JUSTDO_WINDOWS_SESSION_CREATION_PATH_V2026_9_8';
const NAME = 'assertSessionEntryCreationPublication';
const ORIGINAL = /!([\w$]+)\.paths\.has\(([\w$]+)\.resolve\(([\w$]+)\)\)/g;
const PATCHED =
  /!\[\.\.\.([\w$]+)\.paths\]\s*\.some\(\(?justDoCreationPath\)?\s*=>\s*([\w$]+)\.toNamespacedPath\(\2\.resolve\(justDoCreationPath\)\)\s*===\s*\2\.toNamespacedPath\(\2\.resolve\(([\w$]+)\)\)\)/g;
function transform(content, file = '<runtime>') {
  assertCurrentPatchContract(content, CONTRACT, file, false);
  const signature = `function ${NAME}(`;
  const start = content.indexOf(signature);
  if (start < 0 || content.indexOf(signature, start + 1) >= 0)
    throw new Error(`${file}: creation guard count changed`);
  const open = content.indexOf('{', start);
  const end = findMatchingDelimiter(content, open, '{', '}', `${file}: creation guard`);
  const body = content.slice(start, end + 1);
  if (
    !/assertCreationCurrent\([\w$]+\)/.test(body) ||
    !/([\w$]+)\.agentId\s*!==\s*([\w$]+)\.agentId\s*\|\|\s*\1\.sessionKey\s*!==\s*\2\.sessionKey\s*\|\|/.test(
      body,
    )
  )
    throw new Error(`${file}: native creation ownership guards changed`);
  if (body.includes('justDoCreationPath')) {
    if ([...body.matchAll(PATCHED)].length !== 1)
      throw new Error(`${file}: partial creation path patch`);
    assertCurrentPatchContract(content, CONTRACT, file, !isGatewayBundlePath(file));
    return content;
  }
  if (content.includes(CONTRACT)) throw new Error(`${file}: partial creation path marker`);
  if ([...body.matchAll(ORIGINAL)].length !== 1)
    throw new Error(`${file}: native creation path guard changed`);
  const patched = body.replace(
    ORIGINAL,
    (_match, target, module, source) =>
      `![...${target}.paths].some(justDoCreationPath => ${module}.toNamespacedPath(${module}.resolve(justDoCreationPath)) === ${module}.toNamespacedPath(${module}.resolve(${source})))`,
  );
  return content.slice(0, start) + `// ${CONTRACT}\n` + patched + content.slice(end + 1);
}
function processTargets(root, verify) {
  const files = findFilesContaining(root, `function ${NAME}(`);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 5 : 4;
  if (files.length !== expected)
    throw new Error(`Creation path guard target count ${files.length}, expected ${expected}`);
  return files.flatMap(file => {
    const original = fs.readFileSync(file, 'utf8');
    const patched = transform(original, file);
    if (verify && original !== patched)
      throw new Error(`${file}: creation path guard patch missing`);
    return !verify && writeIfChanged(file, original, patched) ? [path.relative(root, file)] : [];
  });
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform },
};
