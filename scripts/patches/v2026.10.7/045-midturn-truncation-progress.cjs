'use strict';

// Capability: send a tool-result truncation that made no progress to native compaction.
// Target: locked openclaw@2026.10.7 mid-turn prompt preflight.
// Scope: the existing truncate-only recovery branch after durable truncation.
// Safety: reuse native compaction admission, retry limits and transcript ownership.
// Remove when: upstream #199636 or equivalent no-progress handling is installed.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { readRuntimeTextFile, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

const TARGET = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const OWNER = 'handleEmbeddedAttemptMidTurnPrecheck';

function locate(source) {
  const { start, text } = functionRange(source, OWNER);
  const tree = parse(text);
  const count = one(collect(tree, node => ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === 'truncatedCount'), 'mid-turn durable truncation count');
  const branch = count.parent.parent.parent.parent;
  if (!ts.isIfStatement(branch) || branch.elseStatement ||
    !same(count.initializer.getText(tree), 'truncationResult.truncated ? truncationResult.truncatedCount : 0'))
    throw new Error('mid-turn truncation recovery changed');
  return { start, tree, condition: branch.expression };
}

const ORIGINAL = 'truncationResult.truncated || truncationResult.reason === "no oversized or aggregate tool results"';
const EXPECTED = 'truncationResult.truncated';

function verifyCurrent(source) {
  const { tree, condition } = locate(source);
  if (!same(condition.getText(tree), EXPECTED)) throw new Error('mid-turn truncation can still report zero progress');
}

function transform(source) {
  const { start, tree, condition } = locate(source);
  const current = condition.getText(tree);
  if (same(current, EXPECTED)) return source;
  if (!same(current, ORIGINAL)) throw new Error('mid-turn truncation condition changed');
  const result = source.slice(0, start + condition.getStart(tree)) + EXPECTED + source.slice(start + condition.end);
  verifyCurrent(result);
  return result;
}

function applyPatch(root) {
  const file = path.join(root, TARGET);
  if (fs.existsSync(path.join(root, 'gateway-bundle.mjs'))) {
    verifyPatch(root);
    return [];
  }
  const source = readRuntimeTextFile(file);
  return writeIfChanged(file, source, transform(source)) ? [TARGET] : [];
}

function verifyPatch(root) {
  const bundle = path.join(root, 'gateway-bundle.mjs');
  const file = path.join(root, TARGET);
  if (fs.existsSync(file)) verifyCurrent(readRuntimeTextFile(file));
  else if (!fs.existsSync(bundle)) throw new Error('missing mid-turn truncation owner');
  if (fs.existsSync(bundle)) verifyCurrent(readRuntimeTextFile(bundle));
}

module.exports = { applyPatch, verifyPatch, __testing: { TARGET, OWNER, transform } };
