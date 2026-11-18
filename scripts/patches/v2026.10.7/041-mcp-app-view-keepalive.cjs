'use strict';

// Capability: keep an opened MCP App's exact live view alive without replaying its launch.
// Target: pristine openclaw@2026.10.7 expires every view ten minutes after creation.
// Scope: authenticated mcp.app.view keepAlive reads; ordinary view reads are unchanged.
// Safety: never restore an expired view or change its requester, owner or tool grants.
// Remove when: a supported native live-view keepalive API replaces this version-locked branch.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const {
  assertCurrentPatchContract, countOccurrences, findFilesContaining,
  findMatchingDelimiter, isGatewayBundlePath, readRuntimeTextFile, writeIfChanged,
} = require('./_patch-utils.js');
const { assertTargetPaths, collect, one, prepend } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_MCP_APP_VIEW_KEEPALIVE_V2026_10_7';
const TARGET = 'dist/mcp-app-DRRDUDxP.mjs';
const OWNER_SHA = '301f350d6f6ac6409a9a88f5fe780b31ee399e380839a57fabf1aeee9d741986';
const globals = [
  'requireString', 'resolveMcpAppSessionOwner', 'resolveMcpAppRequesterId',
  'retainSessionScopedRead', 'McpAppViewExpiredError', 'resolveMcpAppActiveView',
  'withMcpAppActiveView', 'modelContextSubscriptions', 'getMcpAppModelContext',
  'subscribeMcpAppModelContext', 'requireMcpAppInteraction', 'canOpenMcpAppFiles',
  'buildMcpAppSandboxPath', 'createMcpAppStandaloneTicket',
  'authorizeOperatorScopesForMethod', 'logWarn', 'formatErrorMessage',
  'readGatewayRequestMutationAuthority',
];
const globalName = name => globals.find(base => new RegExp('^' + base + '\\d*$').test(name));
function digest(body) {
  const ast = ts.createSourceFile('owner.mjs', 'function owner(){return ' + body + ';}',
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const renamed = ts.transform(ast, [context => {
    const visit = node => ts.isIdentifier(node) && globalName(node.text)
      ? ts.factory.createIdentifier(globalName(node.text)) : ts.visitEachChild(node, visit, context);
    return root => ts.visitNode(root, visit);
  }]);
  try {
    return createHash('sha256').update(canonicalHelper(ts.createPrinter().printFile(renamed.transformed[0]))).digest('hex');
  } finally { renamed.dispose(); }
}
function ownerRange(source) {
  const matches = [...source.matchAll(/"mcp\.app\.view":\s*[\w$]+\(async\s*\([\w$]+\)\s*=>\s*\{/g)];
  const match = one(matches, 'MCP App view handler');
  const start = match.index + match[0].indexOf('async');
  const open = match.index + match[0].lastIndexOf('{');
  const end = findMatchingDelimiter(source, open, '{', '}', 'MCP App view handler') + 1;
  return { start, end, text: source.slice(start, end) };
}
const edits = (source, changes) => changes.toSorted((a, b) => b.start - a.start).reduce(
  (text, { start, end, value }) => text.slice(0, start) + value + text.slice(end), source);
function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const owner = ownerRange(source);
  const ast = ts.createSourceFile('view.mjs', owner.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(file + ': invalid App view handler syntax');
  const arrow = one(ast.statements.filter(ts.isExpressionStatement).map(node => node.expression), 'App view callback');
  if (!ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body)) throw new Error(file + ': App view callback changed');
  const options = arrow.parameters[0]?.name.getText(ast);
  const scope = one(collect(arrow.body, node => ts.isVariableDeclaration(node) &&
    node.initializer?.getText(ast) === options && ts.isObjectBindingPattern(node.name)), 'App view scope');
  const binding = key => one(scope.name.elements.filter(node =>
    (node.propertyName?.getText(ast) ?? node.name.getText(ast)) === key), 'App view ' + key).name.getText(ast);
  const params = binding('params');
  const context = binding('context');
  const client = binding('client');
  const calls = collect(arrow.body, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression));
  const operation = one(calls.filter(node => globalName(node.expression.text) === 'withMcpAppActiveView'), 'App view operation');
  const active = operation.arguments[0].getText(ast);
  const resolve = one(calls.filter(node => globalName(node.expression.text) === 'resolveMcpAppActiveView' &&
    ts.isVariableDeclaration(node.parent?.parent) && node.parent.parent.name.getText(ast) === active), 'App view admission');
  const input = resolve.arguments[0];
  if (!ts.isObjectLiteralExpression(input)) throw new Error(file + ': App view admission input changed');
  const restore = input.properties.filter(node => node.name?.getText(ast) === 'restore');
  const keeper = collect(arrow.body, node => ts.isIfStatement(node) &&
    node.expression.getText(ast) === params + '.keepAlive === true');
  if (restore.length > 1 || keeper.length > 1 || Boolean(restore.length) !== Boolean(keeper.length))
    throw new Error(file + ': partial App view keepalive; rebuild pristine runtime');
  const patched = Boolean(keeper.length);
  const nativeInput = input.properties.filter(node => node.name?.getText(ast) !== 'restore')
    .map(node => node.getText(ast)).join(',\n');
  const callText = restoreValue => resolve.expression.getText(ast) + '({\n' + nativeInput + ',\nrestore: ' + restoreValue + '\n})';
  const viewBinding = one(collect(arrow.body, node => ts.isVariableDeclaration(node) &&
    node.initializer?.getText(ast) === active && ts.isObjectBindingPattern(node.name)), 'App view binding');
  const view = one(viewBinding.name.elements.filter(node =>
    (node.propertyName?.getText(ast) ?? node.name.getText(ast)) === 'view'), 'App view lease').name.getText(ast);
  const grantCall = one(calls.filter(node => globalName(node.expression.text) === 'requireMcpAppInteraction' &&
    node.arguments[0]?.getText(ast) === view && (!patched || node.getStart(ast) > keeper[0].end)), 'App view grant');
  const assertRequest = one(collect(arrow.body, node => ts.isVariableDeclaration(node) &&
    /^assertRequestCurrent\d*$/.test(node.name.getText(ast))), 'App view request guard').name.getText(ast);
  let statement = viewBinding;
  while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
  const branch = `if (${params}.keepAlive === true) {
    if (${view}.readOnly !== true) await ${grantCall.expression.getText(ast)}(${view});
    readGatewayRequestMutationAuthority(${options}).assertCurrent();
    ${assertRequest}();
    const currentView = await ${callText('false')};
    readGatewayRequestMutationAuthority(${options}).assertCurrent();
    ${assertRequest}();
    ${active}.runtime.assertOwnerCurrent?.();
    const now = Date.now();
    if (currentView.view !== ${view} || currentView.runtime !== ${active}.runtime ||
        ${view}.expiresAtMs <= now || !${view}.expiryTimer) throw new McpAppViewExpiredError();
    ${view}.expiryTimer.refresh();
    ${view}.expiresAtMs = now + 10 * 60_000;
    return { viewId: ${view}.viewId, expiresAtMs: ${view}.expiresAtMs };
  }`;
  const original = edits(owner.text, [
    { start: input.getStart(ast), end: input.end, value: '{' + nativeInput + '}' },
    ...(patched ? [{ start: keeper[0].getStart(ast), end: keeper[0].end, value: '' }] : []),
  ]);
  if (digest(original) !== OWNER_SHA) throw new Error(file + ': App view authority owner changed');
  const bundle = isGatewayBundlePath(file);
  if (patched) {
    if (digest('async () => {' + keeper[0].getText(ast) + '}') !== digest('async () => {' + branch + '}') ||
        restore[0].getText(ast) !== 'restore: ' + params + '.keepAlive !== true' ||
        countOccurrences(source, CONTRACT) > 1 || (!bundle && countOccurrences(source, CONTRACT) !== 1))
      throw new Error(file + ': partial or changed App view keepalive');
    return source;
  }
  if (countOccurrences(source, CONTRACT) || owner.text.includes('keepAlive'))
    throw new Error(file + ': partial App view keepalive; rebuild pristine runtime');
  const property = input.properties.at(-1);
  const propertyIndent = owner.text.slice(owner.text.lastIndexOf('\n', property.getStart(ast)) + 1, property.getStart(ast));
  const indent = owner.text.slice(owner.text.lastIndexOf('\n', statement.getStart(ast)) + 1, statement.getStart(ast));
  const next = edits(owner.text, [
    { start: property.end, end: property.end, value: ',\n' + propertyIndent + 'restore: ' + params + '.keepAlive !== true' },
    { start: statement.end, end: statement.end, value: '\n' + branch.split('\n').map(line => indent + line).join('\n') },
  ]);
  return prepend(source.slice(0, owner.start) + next + source.slice(owner.end), '// ' + CONTRACT + '\n');
}
function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, '"mcp.app.view": mcpAppHandler(');
  assertTargetPaths(root, files, [TARGET, ...bundle], 'MCP App view keepalive');
  const plans = files.map(file => {
    const source = readRuntimeTextFile(file);
    return { file, source, next: transform(source, file) };
  });
  const pending = plans.filter(({ source, next }) => source !== next);
  if (!pending.length) return [];
  if (verify) throw new Error('MCP App live-view keepalive is missing');
  if (pending.length !== plans.length) throw new Error('Mixed source/bundle App keepalive; rebuild pristine runtime');
  return pending.filter(({ file, source, next }) => writeIfChanged(file, source, next)).map(({ file }) => path.relative(root, file));
}
module.exports = {
  applyPatch: root => processTargets(root, false), verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET, CONTRACT, ownerRange, digest },
};
