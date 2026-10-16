'use strict';

// Capability: retire SQLite handles without blocking foreground session writes.
// Target: pristine openclaw@2026.10.4 scheduled WAL maintenance (six native copies).
// Scope: zero busy timeout only around the final retirement checkpoint.
// Safety: preserve stop() joining, beginClose(), invalidation, results and leases.
// Remove when: native final checkpoints no longer block concurrent foreground writers.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'SQLITE_RETIREMENT_CHECKPOINT_V2026_10_4';
const NAME = 'configureSqliteWalMaintenance';
function collect(node, predicate) {
  const found = [];
  const visit = current => {
    if (predicate(current)) found.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}
function unique(items, label) {
  if (items.length !== 1)
    throw new Error(`${label}: expected one native boundary, got ${items.length}`);
  return items[0];
}
function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const ast = ts.createSourceFile(
    'runtime.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fn = unique(
    collect(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === NAME),
    file,
  );
  if (fn.parameters.length !== 2 || !ts.isIdentifier(fn.parameters[0].name))
    throw new Error(`${file}: native WAL parameters changed`);
  const database = fn.parameters[0].name.getText(ast);
  const arrow = name =>
    unique(
      collect(
        fn.body,
        node =>
          ts.isPropertyAssignment(node) &&
          node.name.getText(ast) === name &&
          ts.isArrowFunction(node.initializer) &&
          ts.isBlock(node.initializer.body) &&
          node.initializer.body.statements.length > 0,
      ),
      `${file}: ${name}`,
    ).initializer;
  const close = arrow('close');
  const stop = arrow('stop');
  const begin = close.body.statements[0];
  if (
    !ts.isExpressionStatement(begin) ||
    !ts.isCallExpression(begin.expression) ||
    begin.expression.arguments.length !== 0 ||
    !ts.isIdentifier(begin.expression.expression)
  )
    throw new Error(`${file}: retirement must retain native beginClose admission`);
  const beginName = begin.expression.expression.text;
  if (
    !collect(
      stop.body,
      node =>
        ts.isAwaitExpression(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(ast) === beginName,
    ).length ||
    !collect(
      stop.body,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'stop',
    ).length
  )
    throw new Error(`${file}: native asynchronous maintenance joining changed`);
  const candidate = unique(
    collect(
      close.body,
      node =>
        ts.isCallExpression(node) &&
        node.arguments.length === 1 &&
        ts.isArrowFunction(node.arguments[0]) &&
        ts.isCallExpression(node.arguments[0].body),
    ),
    `${file}: retirement checkpoint`,
  ).arguments[0].body;
  const patched = candidate.arguments.length === 3;
  const checkpoint =
    patched && ts.isArrowFunction(candidate.arguments[2]) ? candidate.arguments[2].body : candidate;
  const parameter = close.parameters[0]?.name.getText(ast);
  if (
    !parameter ||
    !ts.isCallExpression(checkpoint) ||
    checkpoint.arguments.length !== 1 ||
    !ts.isBinaryExpression(checkpoint.arguments[0]) ||
    checkpoint.arguments[0].operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    checkpoint.arguments[0].left.getText(ast) !== `${parameter}?.checkpointMode`
  )
    throw new Error(`${file}: native close mode or checkpoint result changed`);
  const invalidation = collect(
    close.body,
    node =>
      (ts.isIfStatement(node) &&
        ts.isReturnStatement(node.thenStatement) &&
        node.thenStatement.expression?.kind === ts.SyntaxKind.FalseKeyword) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ts.isPrefixUnaryExpression(node.left) &&
        node.left.operator === ts.SyntaxKind.ExclamationToken &&
        node.right.getStart(ast) <= candidate.getStart(ast) &&
        node.right.end >= candidate.end),
  );
  if (invalidation.length !== 1) throw new Error(`${file}: native invalidation guard changed`);
  const helpers = new Set(
    collect(
      fn.body,
      node =>
        ts.isCallExpression(node) &&
        node.arguments.length === 3 &&
        node.arguments[0].getText(ast) === database &&
        node.arguments[1].getText(ast) === '0' &&
        ts.isArrowFunction(node.arguments[2]) &&
        ts.isCallExpression(node.arguments[2].body) &&
        (node.arguments[2].body.expression.getText(ast) === checkpoint.expression.getText(ast) ||
          (ts.isStringLiteralLike(node.arguments[2].body.arguments[0]) &&
            node.arguments[2].body.arguments[0].text === 'TRUNCATE')),
    ).map(node => node.expression.getText(ast)),
  );
  const helper = unique([...helpers], `${file}: native temporary busy-timeout helper`);
  if (patched) {
    if (
      candidate.expression.getText(ast) !== helper ||
      candidate.arguments[0].getText(ast) !== database ||
      candidate.arguments[1].getText(ast) !== '0'
    )
      throw new Error(`${file}: partial retirement checkpoint`);
    assertCurrentPatchContract(source, CONTRACT, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(CONTRACT)) throw new Error(`${file}: partial retirement marker`);
  const next =
    source.slice(0, candidate.getStart(ast)) +
    `${helper}(${database}, 0, () => ${checkpoint.getText(ast)})` +
    source.slice(candidate.end);
  const header = next.startsWith('#!') ? next.indexOf('\n') + 1 : 0;
  return next.slice(0, header) + `// ${CONTRACT}\n` + next.slice(header);
}
function processTargets(root, verify) {
  const files = findFilesContaining(root, `function ${NAME}(`);
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 7 : 6;
  if (files.length !== expected)
    throw new Error(`SQLite retirement copies ${files.length}, expected ${expected}`);
  const plans = files.map(file => {
    const source = fs.readFileSync(file, 'utf8');
    const next = transform(source, file);
    return { file, source, next };
  });
  // The final bundle may omit source markers. Its verified behavior, like each
  // native copy, must already be current or require the same pristine pass.
  const current = plans.filter(({ source, next }) => source === next);
  if (current.length > 0 && current.length !== plans.length)
    throw new Error('Mixed pristine and patched SQLite retirement copies');
  if (verify && current.length !== plans.length)
    throw new Error('SQLite retirement checkpoint missing');
  return plans.flatMap(({ file, source, next }) =>
    !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, CONTRACT },
};
