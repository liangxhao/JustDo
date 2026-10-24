'use strict';

const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { findMatchingDelimiter } = require('./_patch-utils.js');
const path = require('node:path');

function assertTargetPaths(root, actual, expected, label) {
  const paths = actual.map(file => path.relative(root, file).replaceAll(path.sep, '/')).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...expected].sort()))
    throw new Error(`${label}: native target paths changed (${paths.join(', ')})`);
}

function functionRange(source, name) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + 1) >= 0)
    throw new Error(`${name}: native function topology changed`);
  const paren = source.indexOf('(', start);
  const close = findMatchingDelimiter(source, paren, '(', ')', name);
  const open = source.indexOf('{', close);
  const end = findMatchingDelimiter(source, open, '{', '}', name) + 1;
  return { start, end, text: source.slice(start, end) };
}

function parse(source) {
  return ts.createSourceFile('native.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function collect(node, predicate) {
  const result = [];
  const visit = current => {
    if (predicate(current)) result.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return result;
}

function one(values, label) {
  if (values.length !== 1) throw new Error(`${label}: native topology changed (${values.length})`);
  return values[0];
}

function same(actual, expected) {
  return (
    canonicalHelper(`function seam(){return ${actual};}`) ===
    canonicalHelper(`function seam(){return ${expected};}`)
  );
}

function prepend(source, value) {
  const at = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, at) + value + source.slice(at);
}

module.exports = { functionRange, parse, collect, one, same, prepend, assertTargetPaths };
