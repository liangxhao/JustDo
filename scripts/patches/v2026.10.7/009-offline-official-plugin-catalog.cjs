'use strict';

// Capability: keep plugin inventory reads local by disabling hosted official-catalog refreshes.
// Target: openclaw@2026.10.7 managed plugin catalog loading.
// Scope: plugins.list/inspect metadata; explicit marketplace CLI refresh remains unchanged.
// Safety: the bundled official catalog remains available as the offline fallback.
// Remove when: upstream exposes an offline plugin-management catalog setting.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'RUNTIME_OFFLINE_OFFICIAL_PLUGIN_CATALOG_V2026_10_7';
const PATCH_MARKER_PATTERN = /(?:RUNTIME|JUSTDO)_OFFLINE_OFFICIAL_PLUGIN_CATALOG_[A-Z0-9_]+/gu;
const ORIGINAL_CALL_PATTERN =
  /loadConfiguredHostedOfficialExternalPluginCatalogEntries(?:\$\d+|\d+)?\(\s*\)/gu;
const PATCHED_CALL_PATTERN =
  /loadConfiguredHostedOfficialExternalPluginCatalogEntries(?:\$\d+|\d+)?\(\s*\{\s*offline\s*:\s*true\s*\}\s*\)(?:\/\*RUNTIME_OFFLINE_OFFICIAL_PLUGIN_CATALOG_V2026_10_7\*\/)?/gu;

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function loadOfficialCatalog(',
    'loadConfiguredHostedOfficialExternalPluginCatalogEntries',
    'officialCatalog',
  ]);
}

function assertNoHistoricalMarkers(content, filePath) {
  if ([...content.matchAll(PATCH_MARKER_PATTERN)].some(match => match[0] !== MARKER)) {
    throw new Error(`${filePath}: historical offline plugin catalog patch detected`);
  }
}

function assertTargetMarkers(files) {
  for (const filePath of files) {
    assertNoHistoricalMarkers(fs.readFileSync(filePath, 'utf8'), filePath);
  }
}

function findLoadOfficialCatalogBody(content, filePath) {
  const signaturePattern = /async function\s+loadOfficialCatalog(?:\$\d+|\d+)?\s*\(/gu;
  const matches = [...content.matchAll(signaturePattern)];
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: loadOfficialCatalog target count is ${matches.length}, expected 1`,
    );
  }
  const parametersStart = matches[0].index + matches[0][0].lastIndexOf('(');
  const parametersEnd = findMatchingDelimiter(
    content,
    parametersStart,
    '(',
    ')',
    `${filePath}: loadOfficialCatalog parameters`,
  );
  let bodyStart = parametersEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: loadOfficialCatalog body`,
  );
  return { bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function transform(content, filePath) {
  assertNoHistoricalMarkers(content, filePath);
  const range = findLoadOfficialCatalogBody(content, filePath);
  const originalMatches = [...range.body.matchAll(ORIGINAL_CALL_PATTERN)];
  const patchedMatches = [...range.body.matchAll(PATCHED_CALL_PATTERN)];
  const markerCount = countOccurrences(range.body, MARKER);
  const historicalMarkerCount = [...content.matchAll(PATCH_MARKER_PATTERN)].filter(
    match => match[0] !== MARKER,
  ).length;
  const gatewayBundle = isGatewayBundlePath(filePath);
  const expectedMarkerCount = gatewayBundle ? 0 : 1;

  // esbuild can preserve the exact current source marker beside the already
  // patched call. Canonicalize that freshly generated bundle shape instead of
  // mistaking our own marker for a historical or partial patch.
  if (
    gatewayBundle &&
    originalMatches.length === 0 &&
    patchedMatches.length === 1 &&
    markerCount === 1 &&
    historicalMarkerCount === 0
  ) {
    const normalizedBody = range.body.replace(`/*${MARKER}*/`, '');
    return content.slice(0, range.bodyStart + 1) + normalizedBody + content.slice(range.bodyEnd);
  }

  if (
    originalMatches.length === 0 &&
    patchedMatches.length === 1 &&
    markerCount === expectedMarkerCount &&
    historicalMarkerCount === 0
  ) {
    return content;
  }
  if (
    originalMatches.length !== 1 ||
    patchedMatches.length > 0 ||
    markerCount > 0 ||
    historicalMarkerCount > 0
  ) {
    throw new Error(`${filePath}: historical or partial offline plugin catalog patch detected`);
  }

  const match = originalMatches[0];
  const replacement = match[0].replace(
    /\(\s*\)$/u,
    `({ offline: true })${gatewayBundle ? '' : `/*${MARKER}*/`}`,
  );
  const insertionIndex = range.bodyStart + 1 + match.index;
  return (
    content.slice(0, insertionIndex) + replacement + content.slice(insertionIndex + match[0].length)
  );
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`offline plugin catalog target count is ${files.length}, expected ${expected}`);
  }
  assertTargetMarkers(files);
  const plans = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    const current = updated === original || (isGatewayBundlePath(filePath) &&
      updated === original.replace(`/*${MARKER}*/`, ''));
    return { filePath, original, updated, current };
  });
  if (plans.some(plan => plan.current) && plans.some(plan => !plan.current))
    throw new Error('Mixed pristine and patched offline plugin catalog targets');
  return plans.filter(plan => writeIfChanged(plan.filePath, plan.original, plan.updated))
    .map(plan => path.relative(runtimeDir, plan.filePath));
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`offline plugin catalog target count is ${files.length}, expected ${expected}`);
  }
  assertTargetMarkers(files);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: offline plugin catalog guard is missing`);
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
