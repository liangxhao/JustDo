'use strict';

// Capability: distinguish mid-turn compaction pressure from a request that cannot fit.
// Target: locked openclaw@2026.10.7 tool-result guard.
// Scope: the post-tool guard's hard-window decision.
// Safety: preserve native tool-result projection and fail closed for an invalid estimate.
// Remove when: upstream #200714 or equivalent hard-window handling is installed.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { readRuntimeTextFile, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

const TARGET = 'dist/attempt-system-prompt-prepare-77TR2SVS.mjs';
const OWNER = 'installToolResultContextGuard';

function locate(source) {
  const { start, text } = functionRange(source, OWNER);
  const tree = parse(text);
  const params = tree.statements[0].parameters[0].name.getText(tree);
  const signal = one(collect(tree, node => ts.isThrowStatement(node) &&
    ts.isNewExpression(node.expression) &&
    node.expression.expression.getText(tree) === 'MidTurnPrecheckSignal'), 'mid-turn overflow signal');
  const statement = signal.parent.parent;
  if (!ts.isIfStatement(statement) || statement.thenStatement !== signal.parent)
    throw new Error('mid-turn overflow decision changed');
  const estimate = one(collect(tree, node => ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === 'precheck'), 'mid-turn estimate').name.getText(tree);
  const condition = statement.expression;
  const budget = `${params}.midTurnPrecheck.contextTokenBudget`;
  const tokens = `${estimate}.estimatedPromptTokens`;
  const original = `${estimate}.route !== "fits"`;
  const expected = `${original} && (!Number.isFinite(${tokens}) || !Number.isFinite(${budget}) || ${budget} <= 0 || ${tokens} > ${budget})`;
  return { start, tree, condition, original, expected };
}

function verifyCurrent(source) {
  const { tree, condition, expected } = locate(source);
  if (!same(condition.getText(tree), expected)) throw new Error('missing mid-turn hard context limit');
}

function transform(source) {
  const { start, tree, condition, original, expected } = locate(source);
  const current = condition.getText(tree);
  if (same(current, expected)) return source;
  if (!same(current, original)) throw new Error('mid-turn overflow decision changed');
  const result = source.slice(0, start + condition.getStart(tree)) +
    expected + source.slice(start + condition.end);
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
  else if (!fs.existsSync(bundle)) throw new Error('missing mid-turn context guard');
  if (fs.existsSync(bundle)) verifyCurrent(readRuntimeTextFile(bundle));
}

module.exports = { applyPatch, verifyPatch, __testing: { TARGET, locate, transform } };
