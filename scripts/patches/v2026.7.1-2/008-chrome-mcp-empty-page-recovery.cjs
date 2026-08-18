'use strict';

// Capability: recover Chrome MCP sessions whose list_pages result is empty.
// Target: pristine openclaw@2026.7.1-2, which returns the empty list without creating a page.
// Scope: retries list_pages after creating one bounded about:blank page.
// Safety: replaces one named function and leaves non-empty/error results on the native path.
// Remove when: upstream creates or recovers a blank page for an empty browser session.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceNamedFunction, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'Chrome MCP empty-page recovery';
const REPLACEMENT = `async function listChromeMcpPages(profileName, profileOptions, options = {}) {
\tlet pages = extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
\tif (pages.length > 0) return pages;
\tconst created = await callTool(profileName, profileOptions, "new_page", {
\t\turl: "about:blank",
\t\ttimeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS
\t}, options);
\tpages = extractStructuredPages(created);
\tif (pages.length > 0) return pages;
\treturn extractStructuredPages(await callTool(profileName, profileOptions, "list_pages", {}, options));
}`;
function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'async function listChromeMcpPages');
  if (files.length !== 1)
    throw new Error(`Chrome MCP page target count is ${files.length}, expected 1`);
  const filePath = files[0];
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = original.includes(CONTRACT)
    ? original
    : replaceNamedFunction(
        original,
        'listChromeMcpPages',
        `${REPLACEMENT}\n// ${CONTRACT}`,
        CONTRACT,
      );
  return writeIfChanged(filePath, original, updated) ? [path.relative(runtimeDir, filePath)] : [];
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, CONTRACT);
  if (files.length !== 1) throw new Error('Chrome MCP empty-page recovery contract is missing');
  const content = fs.readFileSync(files[0], 'utf8');
  if (
    content.includes('async async function listChromeMcpPages') ||
    content.includes(`// ${CONTRACT}) {`)
  ) {
    throw new Error('Chrome MCP empty-page recovery contains a malformed function replacement');
  }
  for (const required of [
    'if (pages.length > 0) return pages;',
    '"new_page"',
    'url: "about:blank"',
  ]) {
    if (!content.includes(required))
      throw new Error(`missing Chrome MCP recovery behavior: ${required}`);
  }
}

module.exports = { applyPatch, verifyPatch, __testing: { CONTRACT, REPLACEMENT } };
