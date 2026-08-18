'use strict';

// Capability: include durable subagent taskName as taskTitle in sessions.list output.
// Target: pristine openclaw@2026.7.1-2, which stores taskName but omits the list projection.
// Scope: adds one read-only projection field; task creation and persistence remain native.
// Safety: requires the unique spawnedBy projection and verifies the new field independently.
// Remove when: native sessions.list exposes taskName/taskTitle.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const NATIVE = /([ \t]*)key,\r?\n\1spawnedBy: subagentOwner \|\| entry\?\.spawnedBy,/;

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, 'spawnedBy: subagentOwner || entry?.spawnedBy');
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(
      `subagent title projection target count is ${files.length}, expected ${expected}`,
    );
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    if (!updated.includes('taskName: subagentRun?.taskName ?? entry?.taskName')) {
      updated = replaceUniquePattern(
        updated,
        NATIVE,
        (_match, indent) =>
          `${indent}key,\n${indent}taskName: subagentRun?.taskName ?? entry?.taskName,\n${indent}task: subagentRun?.taskName ?? entry?.taskName,\n${indent}spawnedBy: subagentOwner || entry?.spawnedBy,`,
        'subagent task title projection',
      );
    }
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(
    runtimeDir,
    'taskName: subagentRun?.taskName ?? entry?.taskName',
  );
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) throw new Error('subagent task title projection is incomplete');
  for (const filePath of files) {
    if (
      !fs.readFileSync(filePath, 'utf8').includes('task: subagentRun?.taskName ?? entry?.taskName')
    )
      throw new Error(`legacy task projection is missing: ${filePath}`);
  }
}

module.exports = { applyPatch, verifyPatch, __testing: { NATIVE } };
