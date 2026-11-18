'use strict';

// Capability: omit exact native uninstall/disable/install targets' extra old-runtime rollback copies.
// Target: pristine openclaw@2026.10.7 captures old lifecycle target source before draining it.
// Scope: authoritative native uninstall/disable/install pluginIds; all other captures remain unchanged.
// Safety: preserve hooks, drain, resource cleanup, final removal and unavailable-owner rollback guards.
// Remove when: native lifecycle operations omit target copies with the same failure boundaries.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const {
  assertCurrentPatchContract, countOccurrences, findFilesContaining, isGatewayBundlePath,
  readRuntimeTextFile, writeIfChanged,
} = require('./_patch-utils.js');
const { assertTargetPaths, collect, functionRange, one, prepend } =
  require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_PLUGIN_LIFECYCLE_RECOVERY_V2026_10_7';
const TARGET = 'dist/server-plugin-reload-kLZrvRgz.mjs';
const OWNER = 'createPluginReloadRecovery';
const CALLER = 'reloadGatewayPlugins';
const CALLER_PREFIX_SHA = '66aa4dd70da0cc1e90ebd3a9d10b5e8272335ec963164c08b33a641c0192d604';
const OWNER_SHA = 'a98706ea509f15f42ef87051185884344251790e4c206ef67fd17fc1c6729d1b';
const PATCHED_OWNER_SHA = '4b6d73bfdb25d0d2bafc3da69db7d73705e58864439218136f0e70ec75d2ba3f';
const digest = source => createHash('sha256').update(canonicalHelper(source)).digest('hex');

function replaceRanges(source, edits) {
  return edits.toSorted((left, right) => right.start - left.start).reduce(
    (text, { start, end, value }) => text.slice(0, start) + value + text.slice(end), source);
}
const same = (left, right) => canonicalHelper(
  'function seam(){return (' + left + ');}') === canonicalHelper(
  'function seam(){return (' + right + ');}');

function callerRange(source, file) {
  const range = functionRange(source, CALLER);
  if (source.slice(range.start - 6, range.start) !== 'async ')
    throw new Error(file + ': native recovery caller is no longer async');
  return { start: range.start - 6, end: range.end, text: 'async ' + range.text };
}

function callerContract(source, file) {
  const caller = callerRange(source, file);
  const ast = ts.createSourceFile('caller.mjs', caller.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(file + ': invalid native recovery caller syntax');
  const declaration = one(ast.statements.filter(ts.isFunctionDeclaration), file + ': native recovery caller');
  const params = declaration.parameters[1];
  if (declaration.parameters.length !== 2 || !params || !ts.isIdentifier(params.name))
    throw new Error(file + ': native recovery caller parameters changed');
  const call = one(collect(ast, node => ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) && node.expression.text === OWNER), file + ': native recovery invocation');
  if (!ts.isVariableDeclaration(call.parent) || call.parent.initializer !== call)
    throw new Error(file + ': native recovery allocation changed');
  const patched = call.arguments.length === 3;
  const lifecycle = params.name.text + '.pluginLifecycle';
  const targets = lifecycle + '?.reason === "uninstall" || ' + lifecycle + '?.reason === "disable" || ' + lifecycle + '?.reason === "install" ? ' + lifecycle + '.pluginIds : []';
  if ((call.arguments.length !== 2 && !patched) ||
      (patched && !same(call.arguments[2].getText(ast), targets)))
    throw new Error(file + ': native recovery lifecycle targets changed');
  let statement = call;
  while (statement.parent && statement.parent !== declaration.body) statement = statement.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== declaration.body)
    throw new Error(file + ': native recovery invocation moved');
  const before = OWNER + '(' + call.arguments.slice(0, 2).map(argument => argument.getText(ast)).join(', ') + ')';
  const nativePrefix = replaceRanges(caller.text.slice(0, call.end), [{
    start: call.getStart(ast), end: call.end, value: before,
  }]) + ';\n}';
  if (digest(nativePrefix) !== CALLER_PREFIX_SHA)
    throw new Error(file + ': native recovery caller authority changed');
  return {
    patched,
    edit: { start: caller.start + call.getStart(ast), end: caller.start + call.end,
      value: before.slice(0, -1) + ', ' + targets + ')' },
  };
}

function updateOwner(owner, file) {
  const ast = ts.createSourceFile('recovery.mjs', owner, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(file + ': invalid plugin recovery syntax');
  const declaration = one(ast.statements.filter(ts.isFunctionDeclaration), file + ': native recovery owner');
  if (declaration.parameters.length !== 2) throw new Error(file + ': native recovery parameters changed');
  const returned = one(declaration.body.statements.filter(ts.isReturnStatement), file + ': native recovery object');
  const hooks = one(collect(ast, node => ts.isGetAccessor(node) &&
    node.name.getText(ast) === 'previousHookIds'), file + ': native hook owner');
  const hookId = one(collect(hooks, ts.isReturnStatement), file + ': native hook identity').expression.getText(ast);
  const hookAdd = one(collect(ast, node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.expression.getText(ast) === hookId &&
    node.expression.expression.name.text === 'add'), file + ': native hook registration');
  const recordId = hookAdd.expression.arguments[0].getText(ast);
  const caught = one(collect(ast, ts.isCatchClause), file + ': native capture failure');
  const unavailableAdd = one(collect(caught, node => ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'add'),
  file + ': native unavailable owner');
  const unavailable = unavailableAdd.expression.expression.getText(ast);
  const parameters = declaration.parameters.map(item => item.getText(ast)).join(', ');
  const updated = replaceRanges(owner, [
    { start: declaration.parameters.pos, end: declaration.parameters.end,
      value: parameters + ', skipRecoveryPluginIds = []' },
    { start: returned.getStart(ast), end: returned.getStart(ast),
      value: 'const skipRecoveryTargets = new Set(skipRecoveryPluginIds);\n' },
    { start: hookAdd.end, end: hookAdd.end,
      value: '\nif (skipRecoveryTargets.has(' + recordId + ')) { ' + unavailable + '.add(' + recordId + '); continue; }' },
  ]);
  if (digest(updated) !== PATCHED_OWNER_SHA)
    throw new Error(file + ': native lifecycle recovery transform changed');
  return updated;
}

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  if (/RUNTIME_PLUGIN_(?:RECOVERY_MISSING_SOURCE|UNINSTALL_RECOVERY|RETIREMENT_RECOVERY)_/u.test(source) ||
      /\bfunction hasMissingPluginRecoverySource\s*\(/u.test(source))
    throw new Error(file + ': historical lifecycle recovery; rebuild pristine runtime');
  const bundle = isGatewayBundlePath(file);
  if ([...source.matchAll(/\bcreatePluginReloadRecovery\s*\(/g)].length !== 2)
    throw new Error(file + ': native recovery references changed');
  const caller = callerContract(source, file);
  const owner = functionRange(source, OWNER);
  const ownerHash = digest(owner.text);
  const patched = ownerHash === PATCHED_OWNER_SHA;
  if (!patched && ownerHash !== OWNER_SHA) throw new Error(file + ': native recovery owner changed');
  if (patched !== caller.patched)
    throw new Error(file + ': partial plugin lifecycle recovery; rebuild pristine runtime');
  const markerCount = countOccurrences(source, CONTRACT);
  if (patched) {
    if (markerCount > 1 || (!bundle && markerCount !== 1))
      throw new Error(file + ': partial plugin lifecycle recovery; rebuild pristine runtime');
    assertCurrentPatchContract(source, CONTRACT, file, !bundle);
    return source;
  }
  if (markerCount) throw new Error(file + ': partial plugin lifecycle recovery; rebuild pristine runtime');
  const updated = replaceRanges(source, [caller.edit,
    { start: owner.start, end: owner.end, value: updateOwner(owner.text, file) }]);
  return prepend(updated, '// ' + CONTRACT + '\n');
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, 'function ' + OWNER + '(');
  assertTargetPaths(root, files, [TARGET, ...bundle], 'plugin lifecycle recovery');
  const plans = files.map(file => {
    const source = readRuntimeTextFile(file);
    return { file, source, next: transform(source, file) };
  });
  const pending = plans.filter(({ source, next }) => source !== next);
  if (!pending.length) return [];
  if (verify) throw new Error('Plugin lifecycle must skip only its exact targets rollback copies');
  if (pending.length !== plans.length)
    throw new Error('Mixed source/bundle plugin lifecycle recovery; rebuild pristine runtime');
  return pending.filter(({ file, source, next }) => writeIfChanged(file, source, next))
    .map(({ file }) => path.relative(root, file));
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET, CONTRACT, CALLER, callerRange, OWNER_SHA, PATCHED_OWNER_SHA },
};
