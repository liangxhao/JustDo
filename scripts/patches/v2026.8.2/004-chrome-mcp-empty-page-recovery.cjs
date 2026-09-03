'use strict';

// Capability: recover an auto-connected Chrome MCP session whose initial page list is empty.
// Target: pristine openclaw@2026.8.2, which refuses to call its bounded new_page recovery
// unless an explicit CDP endpoint was configured.
// Scope: removes only that refusal; the native bounded new_page and validation path remains.
// Safety: explicit endpoints, non-empty sessions, timeouts, and invalid results stay native.
// Remove when: upstream creates or recovers a blank page for an empty browser session.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_CHROME_MCP_EMPTY_PAGE_RECOVERY_V2026_8_2';
const NATIVE_REFUSAL =
  'Chrome MCP cannot safely open the first page without an explicit CDP endpoint.';
const NATIVE_REFUSAL_PATTERN =
  /if\s*\(\s*!([A-Za-z_$][\w$]*)\s*&&\s*!([A-Za-z_$][\w$]*)\.browserUrl\s*\)\s*throw\s+(?:new\s+)?Error\(\s*(["'`])Chrome MCP cannot safely open the first page without an explicit CDP endpoint\.\3\s*\);?/;
const RECOVERY = `/* ${CONTRACT}: native new_page remains bounded and validated. */`;

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function openChromeMcpTab(',
    'Chrome MCP did not return the created page.',
  ]);
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  // Chrome MCP stays in its lazy package chunk and worker companion; it is not
  // part of gateway-bundle.mjs.
  const expected = 2;
  if (files.length !== expected)
    throw new Error(`Chrome MCP page target count is ${files.length}, expected ${expected}`);
  return files.flatMap(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    if (updated.includes(NATIVE_REFUSAL)) {
      updated = replaceUniquePattern(updated, NATIVE_REFUSAL_PATTERN, RECOVERY, CONTRACT);
    } else if (!updated.includes(CONTRACT)) {
      throw new Error(`unknown Chrome MCP empty-page shape: ${filePath}`);
    }
    return writeIfChanged(filePath, original, updated) ? [path.relative(runtimeDir, filePath)] : [];
  });
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = 2;
  if (files.length !== expected)
    throw new Error('patched Chrome MCP empty-page targets are missing');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      CONTRACT,
      'new_page',
      'CHROME_MCP_NEW_PAGE_TIMEOUT_MS',
      'Chrome MCP did not return the created page.',
    ]) {
      if (!content.includes(required))
        throw new Error(`missing Chrome MCP recovery behavior in ${filePath}: ${required}`);
    }
    if (content.includes(NATIVE_REFUSAL))
      throw new Error(`Chrome MCP still refuses native empty-page recovery: ${filePath}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, NATIVE_REFUSAL, NATIVE_REFUSAL_PATTERN, RECOVERY },
};
