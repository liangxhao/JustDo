'use strict';

// Capability: use the source attempt's prepared history for same-turn isolated finalization.
// Target: locked openclaw@2026.10.7 built-in harness and prompt history preparation.
// Scope: the existing built-in, tool-free finalizer with the active user and settled tool batch in its source snapshot.
// Safety: changes only model input; preserves the native writer, replay sanitation and existing fallback path.
// Remove when: upstream #186288 or equivalent prepared finalization history is installed.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { readRuntimeTextFile, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same } = require('./prepared-read-patch-shapes.js');

const TARGET = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const HARNESS = 'createOpenClawAgentHarness';
const HISTORY = 'prepareEmbeddedAttemptHistory';
const FIELD = 'settledTurnFinalizationMessages';
const SELECTION = 'selectedFinalizationMessages';
const canonicalCallback = source => canonicalHelper(`function boundary(){return ${source};}`);

const originalFinalizer = projection => `async ({ attempt }) => {
  const result = await runEmbeddedAttempt(buildRestrictedFinalizationAttempt(attempt));
  return projectSettledTurnFinalizationAttemptResult(result${projection});
}`;
const preparedFinalizer = projection => `async ({ attempt, settledAttempt }) => {
  const context = settledAttempt.settledTurnFinalizationContext;
  const messages = context?.source === "openclaw-transcript" ? context.messages :
    context === void 0 ? settledAttempt.messagesSnapshot : void 0;
  const restrictedAttempt = buildRestrictedFinalizationAttempt(attempt);
  const activeUser = messages?.findLast(message => message.role === "user");
  if (activeUser && activeUser.display !== false && activeUser.provenance?.kind !== "internal_system" &&
      resolveSettledToolBatchEvidence({ ...settledAttempt, messagesSnapshot: messages }).allToolsProvenSettled) {
    restrictedAttempt.${FIELD} = Object.freeze([...messages]);
  }
  const result = await runEmbeddedAttempt(restrictedAttempt);
  return projectSettledTurnFinalizationAttemptResult(result${projection});
}`;

function locateCallback(source) {
  const range = functionRange(source, HARNESS);
  const tree = parse(range.text);
  const property = one(collect(tree, node => ts.isPropertyAssignment(node) &&
    node.name.getText(tree) === 'finalizeSettledTurn'), 'built-in finalization callback');
  return { range, tree, callback: property.initializer };
}

function locateHistory(source) {
  const range = functionRange(source, HISTORY);
  const tree = parse(range.text);
  const operation = one(collect(tree, node => ts.isVariableDeclaration(node) && node.initializer &&
    ts.isBinaryExpression(node.initializer) &&
    node.initializer.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(node.initializer.left) && node.initializer.left.name.text === 'operation' &&
    ts.isStringLiteral(node.initializer.right) && node.initializer.right.text === 'settled-tool-finalization'),
  'settled history discriminant');
  const sanitize = one(collect(tree, node => ts.isCallExpression(node) &&
    node.expression.getText(tree) === 'sanitizeSessionHistory'), 'prepared history sanitizer');
  const assignment = one(collect(tree, node => ts.isIfStatement(node) &&
    ts.isExpressionStatement(node.thenStatement) && ts.isBinaryExpression(node.thenStatement.expression) &&
    node.thenStatement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.thenStatement.expression.left.getText(tree).endsWith('.agent.state.messages')), 'limited history install');
  const message = one(sanitize.arguments[0].properties.filter(property =>
    ts.isPropertyAssignment(property) && property.name.getText(tree) === 'messages'), 'sanitized model history input');
  const prior = sanitize.parent.parent;
  if (!ts.isAwaitExpression(sanitize.parent) || !ts.isVariableDeclaration(prior) || assignment.elseStatement ||
      !ts.isIdentifier(assignment.thenStatement.expression.right))
    throw new Error('settled finalization history ownership changed');
  const attempt = operation.initializer.left.expression.getText(tree);
  const operationStatement = operation.parent.parent;
  const nativeHistory = assignment.thenStatement.expression.left.getText(tree).replace(/\.agent\.state\.messages$/u, '.messages');
  const nativeCondition = `${assignment.thenStatement.expression.right.getText(tree)}.length > 0 || ${prior.name.getText(tree)}.length > 0`;
  return { range, tree, operation, operationStatement, message: message.initializer,
    condition: assignment.expression, nativeHistory, nativeCondition,
    selection: `${operation.name.getText(tree)} && ${attempt}.${FIELD}` };
}

function verifyCurrent(source) {
  const { tree, callback } = locateCallback(source);
  const current = canonicalCallback(callback.getText(tree));
  if (![', true', ''].some(projection => current === canonicalCallback(preparedFinalizer(projection))))
    throw new Error('built-in finalizer does not preserve its proven source history');
  const history = locateHistory(source);
  const selectionStatement = history.operationStatement.parent.statements[
    history.operationStatement.parent.statements.indexOf(history.operationStatement) + 1
  ];
  if (!selectionStatement || !ts.isVariableStatement(selectionStatement) ||
      selectionStatement.declarationList.declarations.length !== 1)
    throw new Error('missing prepared finalization history selection');
  const selection = selectionStatement.declarationList.declarations[0];
  const binding = selection.name.getText(history.tree);
  if (!selection.initializer || !same(selection.initializer.getText(history.tree), history.selection) ||
      !same(history.message.getText(history.tree), `${binding} ? [...${binding}] : ${history.nativeHistory}`) ||
      !same(history.condition.getText(history.tree), `${history.nativeCondition} || ${binding}`))
    throw new Error('prepared finalization history does not reach the native model view');
}

function transform(source) {
  if (source.includes(FIELD)) {
    verifyCurrent(source);
    return source;
  }
  const { range, tree, callback } = locateCallback(source);
  const current = canonicalCallback(callback.getText(tree));
  const projection = [', true', ''].find(value => current === canonicalCallback(originalFinalizer(value)));
  const history = locateHistory(source);
  if (projection === undefined || !same(history.message.getText(history.tree), history.nativeHistory) ||
      !same(history.condition.getText(history.tree), history.nativeCondition))
    throw new Error('locked finalization history or built-in callback changed');
  const changes = [
    [range.start + callback.getStart(tree), range.start + callback.end, preparedFinalizer(projection)],
    [history.range.start + history.operationStatement.end, history.range.start + history.operationStatement.end,
      `\n\tconst ${SELECTION} = ${history.selection};`],
    [history.range.start + history.message.getStart(history.tree), history.range.start + history.message.end,
      `${SELECTION} ? [...${SELECTION}] : ${history.nativeHistory}`],
    [history.range.start + history.condition.getStart(history.tree), history.range.start + history.condition.end,
      `${history.nativeCondition} || ${SELECTION}`],
  ];
  let result = source;
  for (const [start, end, replacement] of changes.sort((a, b) => b[0] - a[0]))
    result = result.slice(0, start) + replacement + result.slice(end);
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
  else if (!fs.existsSync(bundle)) throw new Error('missing built-in finalization history owner');
  if (fs.existsSync(bundle)) verifyCurrent(readRuntimeTextFile(bundle));
}

module.exports = { applyPatch, verifyPatch, __testing: { TARGET, HARNESS, HISTORY, transform, verifyCurrent } };
