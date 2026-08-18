'use strict';

// Capability: emit <think> content from OpenAI-compatible responses as reasoning deltas.
// Target: pristine openclaw@2026.7.1-2, which parses the thinking branch but drops it in transport.
// Scope: patches the two affected response transports without changing ordinary answer content.
// Safety: each transport anchor is unique, staged before writes, and verified independently.
// Remove when: both upstream transports preserve parsed thinking content natively.

const fs = require('fs');
const path = require('path');
const {
  assertSingleFile,
  findFilesContaining,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_V2026_7_1_2_OPENAI_CONTENT_REASONING';

function applyPatch(runtimeDir) {
  const candidates = findFilesContaining(
    runtimeDir,
    ['const appendPartitionedVisibleDelta = (delta) => {', 'reasoningTagTextPartitioner.flush()'],
    { includeBundle: false },
  );
  const alreadyPatched = candidates.filter(filePath =>
    fs.readFileSync(filePath, 'utf8').includes(MARKER),
  );
  if (alreadyPatched.length === 1 && candidates.length === 1) {
    verifyPatch(runtimeDir);
    return [];
  }
  const filePath = assertSingleFile(candidates, 'OpenAI content reasoning transport');
  const original = fs.readFileSync(filePath, 'utf8');
  const anchor = `\tconst appendPartitionedVisibleDelta = (delta) => {\n\t\tif (delta.kind === "text") appendFilteredVisibleTextDelta(delta.text);\n\t};`;
  const replacement = `\t// ${MARKER}\n\tconst appendPartitionedVisibleDelta = (delta) => {\n\t\tappendRoutedContentDelta(delta);\n\t};`;
  const updated = replaceUnique(original, anchor, replacement, 'OpenAI partition routing');
  writeIfChanged(filePath, original, updated);
  verifyPatch(runtimeDir);
  return [path.relative(runtimeDir, filePath)];
}

function verifyPatch(runtimeDir) {
  const sourceCandidates = findFilesContaining(
    runtimeDir,
    [MARKER, 'appendRoutedContentDelta(delta);', 'reasoningTagTextPartitioner.flush()'],
    { includeBundle: false },
  );
  assertSingleFile(sourceCandidates, 'patched OpenAI content reasoning transport');
  if (fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'))) {
    const bundleCandidates = findFilesContaining(runtimeDir, [
      'const appendPartitionedVisibleDelta = (delta) => {',
      'appendRoutedContentDelta(delta);',
      'reasoningTagTextPartitioner.flush()',
    ]).filter(candidate => candidate.endsWith('gateway-bundle.mjs'));
    assertSingleFile(bundleCandidates, 'bundled OpenAI content reasoning transport');
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
