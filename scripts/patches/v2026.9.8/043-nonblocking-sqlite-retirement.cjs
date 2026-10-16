'use strict';

// Capability: retire SQLite handles without blocking foreground Agent writes.
// Target: pristine openclaw@2026.9.8 WAL maintenance close (all native copies).
// Scope: only the final checkpoint uses a zero busy timeout; restore the policy.
// Safety: keep checkpoint results, invalidation, native close and lease evidence.
// Remove when: upstream handle retirement no longer waits for concurrent readers.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'SQLITE_RETIREMENT_CHECKPOINT_V2026_9_8';
const NAME = 'configureSqliteWalMaintenance';

function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const ast = ts.createSourceFile(
    'runtime.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = [];
  const collect = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === NAME) functions.push(node);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  if (functions.length !== 1) throw new Error(`${file}: SQLite maintenance topology changed`);
  const fn = functions[0];
  const database = fn.parameters[0]?.name.getText(ast);
  if (fn.parameters.length !== 2 || !database)
    throw new Error(`${file}: SQLite maintenance parameters changed`);
  const closes = [];
  const visit = node => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === 'close' &&
      ts.isArrowFunction(node.initializer) &&
      node.initializer.parameters.length === 1
    )
      closes.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (closes.length !== 1) throw new Error(`${file}: SQLite retirement close changed`);
  const close = closes[0];
  const parameter = close.parameters[0].name.getText(ast);
  const closeText = close.getText(ast);
  if (
    !closeText.includes('clearInterval(') ||
    !closeText.includes('cancelSqliteWalWriteAdmission(')
  )
    throw new Error(`${file}: SQLite retirement cleanup guards changed`);
  const calls = [];
  const findCloseCall = node => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isArrowFunction(node.arguments[0]) &&
      !ts.isBlock(node.arguments[0].body)
    )
      calls.push(node.arguments[0].body);
    ts.forEachChild(node, findCloseCall);
  };
  findCloseCall(close.body);
  if (calls.length !== 1 || !ts.isCallExpression(calls[0]))
    throw new Error(`${file}: SQLite retirement checkpoint changed`);
  const candidate = calls[0];
  let invalidationGuard = false;
  const findInvalidation = node => {
    if (
      ts.isIfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isReturnStatement(node.thenStatement) &&
      node.thenStatement.expression?.kind === ts.SyntaxKind.FalseKeyword
    )
      invalidationGuard = true;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isPrefixUnaryExpression(node.left) &&
      node.left.operator === ts.SyntaxKind.ExclamationToken &&
      node.right.getStart(ast) <= candidate.getStart(ast) &&
      node.right.end >= candidate.end
    )
      invalidationGuard = true;
    ts.forEachChild(node, findInvalidation);
  };
  findInvalidation(close.body);
  if (!invalidationGuard) throw new Error(`${file}: SQLite retirement invalidation guard changed`);
  const patched = candidate.arguments.length === 3;
  const checkpoint =
    patched && ts.isArrowFunction(candidate.arguments[2]) ? candidate.arguments[2].body : candidate;
  if (
    !ts.isCallExpression(checkpoint) ||
    checkpoint.arguments.length !== 1 ||
    !ts.isBinaryExpression(checkpoint.arguments[0]) ||
    checkpoint.arguments[0].operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    checkpoint.arguments[0].left.getText(ast) !== `${parameter}?.checkpointMode`
  )
    throw new Error(`${file}: SQLite retirement mode preservation changed`);
  const helpers = new Set();
  const findBusyHelper = node => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 3 &&
      node.arguments[0].getText(ast) === database &&
      node.arguments[1].getText(ast) === '0' &&
      ts.isArrowFunction(node.arguments[2]) &&
      ts.isCallExpression(node.arguments[2].body) &&
      node.arguments[2].body.expression.getText(ast) === checkpoint.expression.getText(ast)
    )
      helpers.add(node.expression.getText(ast));
    ts.forEachChild(node, findBusyHelper);
  };
  findBusyHelper(fn.body);
  if (helpers.size !== 1) throw new Error(`${file}: native SQLite busy-timeout helper changed`);
  const helper = [...helpers][0];
  if (patched) {
    if (
      candidate.expression.getText(ast) !== helper ||
      candidate.arguments[0].getText(ast) !== database ||
      candidate.arguments[1].getText(ast) !== '0'
    )
      throw new Error(`${file}: partial SQLite retirement checkpoint patch`);
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT)) throw new Error(`${file}: partial SQLite retirement marker`);
  const replacement = `${helper}(${database}, 0, () => ${checkpoint.getText(ast)})`;
  const next = source.slice(0, candidate.getStart(ast)) + replacement + source.slice(candidate.end);
  const headerEnd = next.startsWith('#!') ? next.indexOf('\n') + 1 : 0;
  return next.slice(0, headerEnd) + `// ${CONTRACT}\n` + next.slice(headerEnd);
}

function processTargets(root, verify) {
  const files = findFilesContaining(root, `function ${NAME}(`);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 8 : 7;
  if (files.length !== expected)
    throw new Error(`SQLite retirement target count ${files.length}, expected ${expected}`);
  const changes = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    const next = transform(source, file);
    if (verify && next !== source) throw new Error(`${file}: SQLite retirement patch missing`);
    return { file, source, next };
  });
  return changes.flatMap(({ file, source, next }) =>
    !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT },
};
