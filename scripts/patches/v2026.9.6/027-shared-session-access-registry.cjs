'use strict';

// Capability: share scoped-session access grants across OpenClaw module instances.
// Target: openclaw@2026.9.6 scoped session-access registry source/bundle.
// Scope: registry storage only; no visibility rule or grant scope is changed.
// Safety: the exact registry anchor must occur once and partial markers fail closed.
// Remove when: upstream packages the Gateway and dynamically loaded SDK modules with one registry.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
const MARKER = 'JUSTDO_SCOPED_SESSION_ACCESS_V2026_9_6';
const replacement = `scopedSessionAccessProviders = globalThis[Symbol.for("${MARKER}")] ??= new Map();`;
function transform(content) {
  if (content.includes(MARKER)) {
    if (content.split(MARKER).length !== 2 || !/scopedSessionAccessProviders = globalThis\[(?:\/\* @__PURE__ \*\/ )?Symbol\.for\("JUSTDO_SCOPED_SESSION_ACCESS_V2026_9_6"\)\] \?\?= (?:\/\* @__PURE__ \*\/ )?new Map\(\);/.test(content)) throw new Error('Partial scoped access registry patch; rebuild pristine runtime.');
    return content;
  }
  const pattern = /scopedSessionAccessProviders = (?:\/\* @__PURE__ \*\/ )?new Map\(\);/g;
  if ([...content.matchAll(pattern)].length !== 1) throw new Error('Scoped access registry anchor must occur exactly once.');
  return content.replace(pattern, replacement);
}
function targets(root) {
  const files = findFilesContaining(root, ['scopedSessionAccessProviders =']);
  if (!files.length) throw new Error('Missing scoped session access registry.');
  return files;
}
function applyPatch(root) {
  return targets(root).filter(file => { const original = fs.readFileSync(file, 'utf8'); return writeIfChanged(file, original, transform(original)); }).map(file => path.relative(root, file));
}
function verifyPatch(root) {
  for (const file of targets(root)) { const source = fs.readFileSync(file, 'utf8'); if (!source.includes(MARKER) || transform(source) !== source) throw new Error('Missing scoped access registry patch.'); }
}
module.exports = { applyPatch, verifyPatch, __testing: { transform } };
