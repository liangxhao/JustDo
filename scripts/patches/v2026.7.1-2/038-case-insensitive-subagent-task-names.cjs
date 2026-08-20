'use strict';

// Capability: accept uppercase letters in sessions_spawn taskName aliases.
// Target: pristine openclaw@2026.7.1-2, whose taskName validator accepts lowercase only.
// Scope: the validator and its matching user/model guidance.
// Safety: all existing length, character, prefix and reserved-name restrictions remain.
// Remove when: upstream accepts uppercase taskName aliases.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const REPLACEMENTS = [
  [
    'SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;',
    'SUBAGENT_TASK_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;',
  ],
  [
    'RESERVED_SUBAGENT_TASK_NAMES.has(taskName)',
    'RESERVED_SUBAGENT_TASK_NAMES.has(taskName.toLowerCase())',
  ],
  ['Use 1-64 chars matching [a-z][a-z0-9_-]*.', 'Use 1-64 chars matching [A-Za-z][A-Za-z0-9_-]*.'],
  [
    'Stable alias for later targeting; lowercase letters/digits/underscores/hyphens, starts letter.',
    'Stable alias for later targeting; ASCII letters/digits/underscores/hyphens, starts letter.',
  ],
  [
    'keep it lowercase with underscores or hyphens.',
    'use ASCII letters, digits, underscores, or hyphens.',
  ],
];

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function applyPatch(runtimeDir) {
  const expected = expectedCopies(runtimeDir);
  const staged = new Map();
  const states = [];
  for (const [native, patched] of REPLACEMENTS) {
    const nativeFiles = findFilesContaining(runtimeDir, native);
    const patchedFiles = findFilesContaining(runtimeDir, patched);
    if (nativeFiles.length + patchedFiles.length !== expected) {
      throw new Error(`taskName uppercase patch target count is invalid for: ${native}`);
    }
    if (nativeFiles.length > 0 && patchedFiles.length > 0) {
      throw new Error(`taskName uppercase patch rejected a partial artifact for: ${native}`);
    }
    states.push(nativeFiles.length === expected ? 'native' : 'patched');
    for (const filePath of nativeFiles) {
      const original = fs.readFileSync(filePath, 'utf8');
      const entry = staged.get(filePath) ?? { original, updated: original };
      entry.updated = replaceUnique(entry.updated, native, patched, 'taskName uppercase support');
      staged.set(filePath, entry);
    }
  }
  if (new Set(states).size > 1)
    throw new Error('taskName uppercase patch rejected a partial artifact');

  const changed = [];
  for (const [filePath, { original, updated }] of staged) {
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed.sort();
}

function verifyPatch(runtimeDir) {
  const expected = expectedCopies(runtimeDir);
  for (const [native, patched] of REPLACEMENTS) {
    const files = findFilesContaining(runtimeDir, patched);
    if (files.length !== expected || findFilesContaining(runtimeDir, native).length !== 0) {
      throw new Error(`taskName uppercase patch is incomplete for: ${patched}`);
    }
    if (
      files.some(filePath => countOccurrences(fs.readFileSync(filePath, 'utf8'), patched) !== 1)
    ) {
      throw new Error(`taskName uppercase patch anchor is ambiguous for: ${patched}`);
    }
  }
}

module.exports = { applyPatch, verifyPatch };
