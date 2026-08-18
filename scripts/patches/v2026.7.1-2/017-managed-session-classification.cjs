'use strict';

// Capability: classify only session trees whose ancestry root is agent:*:justdo:* as managed.
// Target: pristine openclaw@2026.7.1-2, which has no JustDo ancestry classification contract.
// Scope: one cycle/depth-bounded classifier beside sessions_yield; it does not change tool behavior.
// Safety: missing parents, cycles, excessive depth, cron and non-JustDo roots all fail closed.
// Remove when: upstream exposes an equivalent durable root-ancestry classifier.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

function isJustDoManagedSessionFromRuns(runs, sessionKey) {
  let current = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const visited = new Set();
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    const parents = new Set();
    for (const entry of runs.values()) {
      if (entry?.childSessionKey !== current) continue;
      const candidate =
        (typeof entry.controllerSessionKey === 'string' && entry.controllerSessionKey.trim()) ||
        (typeof entry.requesterSessionKey === 'string' && entry.requesterSessionKey.trim()) ||
        '';
      if (candidate) parents.add(candidate);
    }
    if (parents.size > 1) return false;
    const parent = parents.values().next().value ?? '';
    if (!parent) return /^agent:[^:]+:justdo:[^:]+$/i.test(current);
    current = parent;
  }
  return false;
}

const HELPER = `${isJustDoManagedSessionFromRuns.toString()}\n`;

function transform(content, filePath) {
  if (content.includes('function isJustDoManagedSessionFromRuns(runs, sessionKey)')) return content;
  return replaceUnique(
    content,
    '//#region src/agents/tools/sessions-yield-tool.ts',
    `${HELPER}//#region src/agents/tools/sessions-yield-tool.ts`,
    `${filePath}: managed root ancestry classifier`,
  );
}

function locateTarget(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function createSessionsYieldTool(opts)',
    'function createOpenClawTools(options)',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`managed classification target count is ${files.length}, expected ${expected}`);
  return files;
}

function applyPatch(runtimeDir) {
  const staged = locateTarget(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  const changed = [];
  for (const { filePath, original, updated } of staged)
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTarget(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const expected of [
      'function isJustDoManagedSessionFromRuns(runs, sessionKey)',
      'depth < 32',
      'return /^agent:[^:]+:justdo:[^:]+$/i.test(current);',
    ])
      if (!content.includes(expected))
        throw new Error(`managed classification contract is missing from ${filePath}: ${expected}`);
    if (!/if \(visited\d*\.has\(current\)\) return false;/.test(content))
      throw new Error(`managed classification contract is missing from ${filePath}: cycle guard`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { isJustDoManagedSessionFromRuns },
};
