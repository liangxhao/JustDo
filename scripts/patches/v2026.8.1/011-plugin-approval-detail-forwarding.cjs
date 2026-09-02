'use strict';

// Capability: forward reviewer-only plugin approval detail from a trusted policy.
// Target: openclaw@2026.8.1 before-tool approval dispatch in source and bundled output.
// Scope: the existing `detail` field on embedded and Gateway approval requests.
// Safety: description remains channel-safe; Gateway bounds detail for approval reviewers.
// Remove when: upstream requestPluginToolApproval forwards PluginApprovalRequest.detail.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  isGatewayBundlePath,
  normalizeJustDoGatewayBundle,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_PLUGIN_APPROVAL_DETAIL_FORWARDING_V2026_8_1';
const DETAIL_FORWARDING_PATTERN =
  /(allowedDecisions\s*:\s*([A-Za-z_$][\w$]*)\.allowedDecisions\s*,\s*)(toolName\s*:)/g;
const PATCHED_DETAIL_FORWARDING_PATTERN = new RegExp(
  `(allowedDecisions\\s*:\\s*([A-Za-z_$][\\w$]*)\\.allowedDecisions\\s*,\\s*)\\.\\.\\.\\(\\2\\.detail\\s*\\?\\s*\\{\\s*detail\\s*:\\s*\\2\\.detail\\s*\\}\\s*:\\s*\\{\\s*\\}\\s*\\),\\/\\*${MARKER}\\*\\/(toolName\\s*:)`,
  'g',
);
const BUNDLE_DETAIL_FORWARDING_PATTERN =
  /allowedDecisions:([A-Za-z_$][\w$]*)\.allowedDecisions,\.\.\.\(?\1\.detail\?\{detail:\1\.detail\}:\{\}\)?,toolName:/g;

function transformApprovalDispatch(content, filePath) {
  if (isGatewayBundlePath(filePath)) {
    const normalized = normalizeJustDoGatewayBundle(content, filePath);
    const bundleCount = [...normalized.matchAll(BUNDLE_DETAIL_FORWARDING_PATTERN)].length;
    if (bundleCount === 2) return content;
    throw new Error(
      `${filePath}: historical or partial plugin approval detail bundle contract detected; ` +
        `target count is ${bundleCount}, expected 2`,
    );
  }
  const markerCount = countOccurrences(content, MARKER);
  const originalCount = [...content.matchAll(DETAIL_FORWARDING_PATTERN)].length;
  const patchedCount = [...content.matchAll(PATCHED_DETAIL_FORWARDING_PATTERN)].length;
  if (markerCount > 0 || patchedCount > 0) {
    if (markerCount === 2 && patchedCount === 2 && originalCount === 0) return content;
    throw new Error(`${filePath}: historical or partial plugin approval detail patch detected`);
  }
  if (originalCount !== 2) {
    throw new Error(
      `${filePath}: plugin approval detail target count is ${originalCount}, expected 2`,
    );
  }
  return content.replace(
    DETAIL_FORWARDING_PATTERN,
    `$1...($2.detail ? { detail: $2.detail } : {}),/*${MARKER}*/$3`,
  );
}

function expectedTargetCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function locateTargets(runtimeDir) {
  const targets = new Set(
    findFilesContaining(runtimeDir, [
      'async function requestPluginToolApproval',
      'allowedDecisions',
      'toolName',
    ]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [MARKER])) targets.add(filePath);
  const expected = expectedTargetCount(runtimeDir);
  if (targets.size !== expected) {
    throw new Error(
      `Plugin approval detail forwarding target count is ${targets.size}, expected ${expected}`,
    );
  }
  return [...targets];
}

function applyPatch(runtimeDir) {
  const changed = [];
  for (const filePath of locateTargets(runtimeDir)) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transformApprovalDispatch(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transformApprovalDispatch(content, filePath) !== content) {
      throw new Error(`${filePath}: plugin approval detail forwarding contract is incomplete`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    MARKER,
    transformApprovalDispatch,
  },
};
