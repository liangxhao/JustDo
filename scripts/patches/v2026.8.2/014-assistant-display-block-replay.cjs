'use strict';

// Capability: exclude assistant display-only blocks from provider transcript replay.
// Target: openclaw@2026.8.2 provider-safe transport-message transformation.
// Scope: non-text/non-thinking assistant blocks that are not native tool calls.
// Safety: durable history and UI projection stay unchanged; only provider-bound replay is filtered.
// Remove when: upstream provider replay excludes OpenClaw display blocks before AI conversion.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_ASSISTANT_DISPLAY_BLOCK_REPLAY_V2026_8_2';
const DISPLAY_PASSTHROUGH_PATTERN =
  /if\s*\(\s*([A-Za-z_$][\w$]*)\.type\s*!==\s*(["'\x60])toolCall\2\s*\)\s*\{\s*([A-Za-z_$][\w$]*)\.push\(\s*\1\s*\)\s*;?\s*continue\s*;?\s*\}/gu;
const DISPLAY_SKIP_PATTERN =
  /if\s*\(\s*([A-Za-z_$][\w$]*)\.type\s*!==\s*(["'\x60])toolCall\2\s*\)\s*continue\s*;/gu;

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function transformTransportMessages(',
    'preserveCrossModelToolCallThoughtSignature',
    'normalizeSameModelToolCallIds',
  ]);
}

function findTransformBody(content, filePath) {
  const signaturePattern = /function\s+transformTransportMessages(?:\$\d+|\d+)?\s*\(/gu;
  const candidates = [...content.matchAll(signaturePattern)].map(match => {
    const parametersStart = match.index + match[0].lastIndexOf('(');
    const parametersEnd = findMatchingDelimiter(
      content,
      parametersStart,
      '(',
      ')',
      `${filePath}: transformTransportMessages parameters`,
    );
    let bodyStart = parametersEnd + 1;
    while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
    const bodyEnd = findMatchingDelimiter(
      content,
      bodyStart,
      '{',
      '}',
      `${filePath}: transformTransportMessages body`,
    );
    return { bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
  });
  const matches = candidates.filter(
    candidate =>
      candidate.body.includes('preserveCrossModelToolCallThoughtSignature') &&
      candidate.body.includes('normalizeSameModelToolCallIds'),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: provider-safe transformTransportMessages target count is ${matches.length}, expected 1`,
    );
  }
  return matches[0];
}

function transform(content, filePath) {
  const range = findTransformBody(content, filePath);
  const markerCount = countOccurrences(range.body, MARKER);
  const skipMatches = [...range.body.matchAll(DISPLAY_SKIP_PATTERN)];
  const expectedMarkerCount = isGatewayBundlePath(filePath) ? 0 : 1;

  if (skipMatches.length === 1) {
    const blockName = skipMatches[0][1];
    const exactGuard =
      `if (${blockName}.type !== "toolCall") continue;` +
      (isGatewayBundlePath(filePath) ? '' : `/*${MARKER}*/`);
    if (
      countOccurrences(range.body, exactGuard) === 1 &&
      markerCount === expectedMarkerCount &&
      [...range.body.matchAll(DISPLAY_PASSTHROUGH_PATTERN)].length === 0
    ) {
      return content;
    }
    throw new Error(
      `${filePath}: historical or partial assistant display-block replay patch detected`,
    );
  }
  if (
    skipMatches.length > 0 ||
    markerCount > 0 ||
    range.body.includes('JUSTDO_ASSISTANT_DISPLAY_BLOCK')
  ) {
    throw new Error(
      `${filePath}: historical or partial assistant display-block replay patch detected`,
    );
  }

  const passthroughMatches = [...range.body.matchAll(DISPLAY_PASSTHROUGH_PATTERN)];
  if (passthroughMatches.length !== 1) {
    throw new Error(
      `${filePath}: assistant display-block passthrough count is ${passthroughMatches.length}, expected 1`,
    );
  }
  const match = passthroughMatches[0];
  const blockName = match[1];
  const replacement =
    `if (${blockName}.type !== "toolCall") continue;` +
    (isGatewayBundlePath(filePath) ? '' : `/*${MARKER}*/`);
  const insertionIndex = range.bodyStart + 1 + match.index;
  return (
    content.slice(0, insertionIndex) + replacement + content.slice(insertionIndex + match[0].length)
  );
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(
      `assistant display-block replay target count is ${files.length}, expected ${expected}`,
    );
  }
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(
      `assistant display-block replay target count is ${files.length}, expected ${expected}`,
    );
  }
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: assistant display-block replay guard is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    MARKER,
    transform,
  },
};
