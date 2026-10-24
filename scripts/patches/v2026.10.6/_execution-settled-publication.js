'use strict';

// A native cancellation reservation owns the immediate client notification,
// while the same execution's producer still owns its later settled terminal.
const crypto = require('node:crypto');
const acorn = require('acorn');
const ts = require('typescript');
const { canonicalHelper, extractNativeFunction } = require('../../openclaw/native-support-contract.cjs');
const { findMatchingDelimiter } = require('./_patch-utils.js');

const MARKER = 'RUNTIME_EXECUTION_SETTLED_PUBLICATION_V2026_10_6';
const names = ['reserveAgentTerminalEvent', 'enrichAgentEvent'];
const hashes = {
  reserveAgentTerminalEvent: {
    pristine: 'ef8266f69f8fddc755669731ae4f35e42cd16c8e113111a2d2c351ae9c6ad664',
    patched: '6201eee6a6f33c623368563effe0502b99ce932267eb89d8084a975d105ead27',
  },
  enrichAgentEvent: {
    pristine: '6a730c7f8f789c73d9fb9ffbe086ab0775105e4f79ea686314c85efe28920d67',
    patched: 'd7e8a55344bcda607c3ec4241b1de9e7e9d74b38a8d4a14a635d7112458a7161',
  },
};
const nativeNames = [
  ...names, 'getAgentRunContext', 'withAgentRunLifecycleGeneration',
  'captureAgentRunLifecycleGeneration', 'recordAgentEventRouting', 'resolveAgentEventRouting',
  'getAgentEventState', 'getAgentEventExecutionContext', 'dispatchAgentEvent',
  'hasInvalidLifecycleStartTimestamp', 'recordAgentRunModel', 'recordExecutionActivity',
  'isDefinitiveRunLifecycle', 'AGENT_EVENT_ROUTING_FIELDS',
];

function extract(source, name, file) {
  const fn = extractNativeFunction(source, name, findMatchingDelimiter, true);
  if (!fn) throw new Error(`${file}: exact synchronous native ${name} is required`);
  let previous;
  for (const token of acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })) {
    if (token.start >= fn.start) break;
    previous = token;
  }
  if (previous?.type.label === 'name' && previous.value === 'async')
    throw new Error(`${file}: exact synchronous native ${name} is required`);
  return fn;
}

function canonical(body) {
  const filename = 'publication.mjs';
  const ast = ts.createSourceFile(filename, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const options = { allowJs: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === filename ? ast : undefined;
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const bindings = new Map();
  function bind(name) {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol && !bindings.has(symbol)) bindings.set(symbol, `__executionBinding${bindings.size}`);
    } else if (ts.isBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
    }
  }
  function collect(node) {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bind(node.name);
    if (ts.isFunctionDeclaration(node) && node.parent !== ast && node.name) bind(node.name);
    ts.forEachChild(node, collect);
  }
  collect(ast);
  const transformed = ts.transform(ast, [context => {
    function visit(node) {
      if (ts.isShorthandPropertyAssignment(node)) {
        const symbol = checker.getShorthandAssignmentValueSymbol(node);
        return ts.factory.createPropertyAssignment(node.name.text,
          ts.factory.createIdentifier(bindings.get(symbol) ?? node.name.text));
      }
      if (ts.isBindingElement(node) && !node.propertyName && !node.dotDotDotToken &&
        ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent))
        return ts.factory.updateBindingElement(node, node.dotDotDotToken,
          ts.factory.createIdentifier(node.name.text), ts.visitNode(node.name, visit),
          node.initializer && ts.visitNode(node.initializer, visit));
      if (ts.isIdentifier(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isBindingElement(node.parent) && node.parent.propertyName === node)) {
        const local = bindings.get(checker.getSymbolAtLocation(node));
        if (local) return ts.factory.createIdentifier(local);
        const native = nativeNames.find(name => node.text === name ||
          new RegExp(`^${name}(?:\\$\\d+|\\d+)$`, 'u').test(node.text));
        if (native) return ts.factory.createIdentifier(native);
      }
      return ts.visitEachChild(node, visit, context);
    }
    return root => ts.visitNode(root, visit);
  }]);
  try {
    return canonicalHelper(ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]));
  } finally { transformed.dispose(); }
}

function hash(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

function replaceOne(body, before, after, file) {
  const position = body.indexOf(before);
  if (position < 0 || body.indexOf(before, position + 1) !== -1)
    throw new Error(`${file}: native terminal publication topology changed`);
  return body.slice(0, position) + after + body.slice(position + before.length);
}

function patchBody(body, name, file) {
  if (name === 'reserveAgentTerminalEvent') return replaceOne(body,
    'runState.terminalPublication ??= publication;',
    `if (!runState.terminalPublication) {
      runState.terminalPublication = publication;
      const nativeIdentity = resolved.routing;
      const pendingIdentity = nativeIdentity && {
        lifecycleGeneration: resolved.ownedLifecycleGeneration,
        sessionId: nativeIdentity.sessionId,
        sessionKey: nativeIdentity.sessionKey,
        agentId: nativeIdentity.agentId
      };
      if (pendingIdentity && Object.values(pendingIdentity).every(value => typeof value === "string" && value.trim())) {
        runState.pendingExecutionSettlementPublication = publication;
        runState.pendingExecutionSettlementIdentity = Object.freeze(pendingIdentity);
      }
    }`, file);
  body = replaceOne(body,
    'if (consumed || runState.terminalPublication && runState.terminalPublication !== publication) return false;',
    `if (consumed) return false;
      const executionSettled = (data.phase === "end" || data.phase === "error") && data.executionSettled === true;
      const pendingIdentity = runState.pendingExecutionSettlementIdentity;
      const reservedSettlement = executionSettled && runState.pendingExecutionSettlementPublication !== undefined &&
        runState.terminalPublication === runState.pendingExecutionSettlementPublication && pendingIdentity !== undefined &&
        event.lifecycleGeneration === pendingIdentity.lifecycleGeneration &&
        lifecycleGeneration === pendingIdentity.lifecycleGeneration && sessionId === pendingIdentity.sessionId &&
        sessionKey === pendingIdentity.sessionKey && agentId === pendingIdentity.agentId;
      if (runState.terminalPublication && runState.terminalPublication !== publication && !reservedSettlement) return false;`, file);
  return replaceOne(body, 'consumed = true;',
    `consumed = true;
      if (executionSettled) {
        delete runState.pendingExecutionSettlementPublication;
        delete runState.pendingExecutionSettlementIdentity;
      }`, file);
}

function assertExecutionSettledPublication(source, file = '<runtime>') {
  for (const name of names)
    if (hash(extract(source, name, file).body) !== hashes[name].patched)
      throw new Error(`${file}: native settled-publication semantics changed (${name})`);
}

function transformExecutionSettledPublication(source, file = '<runtime>') {
  const functions = names.map(name => ({ name, ...extract(source, name, file) }));
  const states = functions.map(fn => {
    const actual = hash(fn.body);
    if (actual === hashes[fn.name].patched) return 'patched';
    if (actual === hashes[fn.name].pristine) return 'pristine';
    throw new Error(`${file}: historical or partial native settled publication; rebuild pristine runtime`);
  });
  if (states.every(state => state === 'patched')) return source;
  if (states.some(state => state !== 'pristine') || source.includes(MARKER) ||
    source.includes('pendingExecutionSettlementPublication'))
    throw new Error(`${file}: mixed native settled publication; rebuild pristine runtime`);
  let result = source;
  for (const fn of functions.sort((a, b) => b.start - a.start))
    result = result.slice(0, fn.start) + `/*${MARKER}*/\n` + patchBody(fn.body, fn.name, file) + result.slice(fn.end);
  assertExecutionSettledPublication(result, file);
  return result;
}

module.exports = {
  transformExecutionSettledPublication, assertExecutionSettledPublication,
  __testing: { extract, canonical, hash, patchBody, names },
};
