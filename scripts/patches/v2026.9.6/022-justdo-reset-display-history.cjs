'use strict';

// Capability: preserve display history across context-clearing resets for JustDo sessions.
// Target: openclaw@2026.9.6 SQLite transcript history/reset-window projection.
// Scope: canonical agent:*:justdo:* session keys; model context still honors every reset.
// Safety: ordinary OpenClaw sessions retain native reset visibility semantics.
// Remove when: upstream supports a reset boundary that clears model context without hiding display history.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKERS = {
  history: 'JUSTDO_RESET_DISPLAY_HISTORY_V2026_9_6',
  window: 'JUSTDO_RESET_DISPLAY_WINDOW_V2026_9_6',
};
const JUSTDO_SESSION_KEY_PATTERN_SOURCE = '^agent:[^:]+:justdo:';

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 4 : 3;
}

function findNamedFunctionRange(content, functionName, filePath) {
  const signature = `function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  }
  const parametersStart = signatureIndex + signature.length - 1;
  const parametersEnd = findMatchingDelimiter(
    content,
    parametersStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  const parameters = content.slice(parametersStart + 1, parametersEnd).split(',');
  const firstParameter = parameters[0]?.trim();
  if (!firstParameter || !/^[A-Za-z_$][\w$]*$/u.test(firstParameter)) {
    throw new Error(`${filePath}: ${functionName} projection parameter is unsupported`);
  }
  let bodyStart = parametersEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return {
    firstParameter,
    bodyStart,
    bodyEnd,
    body: content.slice(bodyStart + 1, bodyEnd),
  };
}

function markerSuffix(filePath, marker) {
  return isGatewayBundlePath(filePath) ? '' : `/*${marker}*/`;
}

function transformHistoryProjection(content, filePath) {
  const range = findNamedFunctionRange(content, 'resolveVisibleHistoryProjection', filePath);
  const markerCount = countOccurrences(range.body, MARKERS.history);
  const capabilityCount = countOccurrences(range.body, '/^agent:[^:]+:justdo:/u.test(');
  if (capabilityCount === 1) {
    const expectedMarkers = isGatewayBundlePath(filePath) ? 0 : 1;
    if (markerCount === expectedMarkers) return content;
    throw new Error(`${filePath}: historical or partial reset display-history patch detected`);
  }
  if (capabilityCount > 0 || markerCount > 0 || range.body.includes('JUSTDO_RESET_DISPLAY')) {
    throw new Error(`${filePath}: historical or partial reset display-history patch detected`);
  }
  const originalPattern = /resolveTranscriptBoundaryWindow\((\w+)\)\?\.boundarySeq\s*\?\?\s*null/gu;
  const matches = [...range.body.matchAll(originalPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: reset history boundary target count is ${matches.length}, expected 1`,
    );
  }
  const updatedBody = range.body.replace(
    originalPattern,
    (_match, projection) =>
      `(/^agent:[^:]+:justdo:/u.test(${projection}.resolved.sessionKey ?? '') ? null : resolveTranscriptBoundaryWindow(${projection})?.boundarySeq ?? null)` + markerSuffix(filePath, MARKERS.history),
  );
  return `${content.slice(0, range.bodyStart + 1)}${updatedBody}${content.slice(range.bodyEnd)}`;
}

function transformResetWindow(content, filePath) {
  const range = findNamedFunctionRange(content, 'readLatestActiveBoundaryMetadata', filePath);
  const markerCount = countOccurrences(range.body, MARKERS.window);
  const capabilityCount = countOccurrences(range.body, '/^agent:[^:]+:justdo:/u.test(');
  if (capabilityCount === 1) {
    const expectedMarkers = isGatewayBundlePath(filePath) ? 0 : 1;
    if (markerCount === expectedMarkers) return content;
    throw new Error(`${filePath}: historical or partial reset display-window patch detected`);
  }
  if (capabilityCount > 0 || markerCount > 0 || range.body.includes('JUSTDO_RESET_DISPLAY')) {
    throw new Error(`${filePath}: historical or partial reset display-window patch detected`);
  }
  const originalPattern =
    /if\s*\(\s*([A-Za-z_$][\w$]*)\s*===\s*(?:"history"|'history'|\x60history\x60)\s*\)\s*return\s+([A-Za-z_$][\w$]*)\s*;?/gu;
  const matches = [...range.body.matchAll(originalPattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: reset display-window target count is ${matches.length}, expected 1`,
    );
  }
  const updatedBody = range.body.replace(
    originalPattern,
    (_match, scopeName, resetName) =>
      `if (${scopeName} === "history") return /^agent:[^:]+:justdo:/u.test(` +
      `${range.firstParameter}.resolved.sessionKey ?? '') ? undefined : ${resetName};` +
      markerSuffix(filePath, MARKERS.window),
  );
  return `${content.slice(0, range.bodyStart + 1)}${updatedBody}${content.slice(range.bodyEnd)}`;
}

function historyTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function resolveVisibleHistoryProjection(',
    'resolveTranscriptBoundaryWindow(',
  ]);
}

function windowTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function readLatestActiveBoundaryMetadata(',
    'function readLatestActiveBoundaryMetadataByType(',
  ]);
}

function transformFile(content, filePath) {
  let updated = content;
  if (content.includes('function resolveVisibleHistoryProjection(')) {
    updated = transformHistoryProjection(updated, filePath);
  }
  if (content.includes('function readLatestActiveBoundaryMetadata(')) {
    updated = transformResetWindow(updated, filePath);
  }
  return updated;
}

function applyPatch(runtimeDir) {
  const historyFiles = historyTargets(runtimeDir);
  const windowFiles = windowTargets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (historyFiles.length !== expected || windowFiles.length !== expected) {
    throw new Error(
      `reset display-history targets are history=${historyFiles.length}, window=${windowFiles.length}, expected ${expected}`,
    );
  }
  const files = [...new Set([...historyFiles, ...windowFiles])];
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transformFile(original, filePath);
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const historyFiles = historyTargets(runtimeDir);
  const windowFiles = windowTargets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (historyFiles.length !== expected || windowFiles.length !== expected) {
    throw new Error(
      `reset display-history targets are history=${historyFiles.length}, window=${windowFiles.length}, expected ${expected}`,
    );
  }
  for (const filePath of new Set([...historyFiles, ...windowFiles])) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transformFile(content, filePath) !== content) {
      throw new Error(`${filePath}: reset display-history patch is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    JUSTDO_SESSION_KEY_PATTERN_SOURCE,
    MARKERS,
    transformFile,
    transformHistoryProjection,
    transformResetWindow,
  },
};
