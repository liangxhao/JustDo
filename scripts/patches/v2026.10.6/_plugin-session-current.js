'use strict';

// 019 needs a native live assertion after its asynchronous worker read. Keep
// native source/physical custody; add only the exact execution-owner predicate.
const crypto = require('node:crypto');
const acorn = require('acorn');
const ts = require('typescript');
const {
  canonicalHelper,
  extractNativeFunction,
} = require('../../openclaw/native-support-contract.cjs');
const { findMatchingDelimiter } = require('./_patch-utils.js');

const NAME = 'captureSessionEntryCurrentCheck';
const MARKER = 'RUNTIME_PLUGIN_SESSION_CURRENT_V2026_10_6';
const PRISTINE_HASH = 'deca6be8967ae91f443dd2d310a631f9ed3bfa0acb827755d9fc84df59e1e407';
const PATCHED_HASH = '8cecd9f7b55c5b8ceff117bdc1cb2f5728fcfc5f24a23c6f37cf05b9d6fe3383';
const nativeNames = [
  NAME,
  'resolveSessionStorePathForScope',
  'captureSessionEntryReadScope',
  'isNativeSessionEntryRead',
  'captureSessionStoreReadCandidates',
  'buildConversationIdentity',
  'captureSessionStoreReadCandidate',
  'resolveUnsuffixedSqliteTargetFromSessionStorePath',
  'withSessionEntryReadOnlyInWorker',
  'resolveSqliteSessionKey',
  'readDatabasePathIdentitySync',
  'isSessionStoreReadCandidateCurrent',
  'assertSessionStoreReadCandidate',
  'loadSessionEntryReadOnly',
  'resolveCurrentConversationSession',
  'captureSessionEntrySourceAssertion',
];

function extract(source, file) {
  const fn = extractNativeFunction(source, NAME, findMatchingDelimiter, true);
  if (!fn) throw new Error(`${file}: exact async native session-current guard is required`);
  let previous;
  for (const token of acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module' })) {
    if (token.start >= fn.start) break;
    previous = token;
  }
  if (
    previous?.type.label !== 'name' ||
    previous.value !== 'async' ||
    /[\r\n\u2028\u2029]/u.test(source.slice(previous.end, fn.start))
  )
    throw new Error(`${file}: exact async native session-current guard is required`);
  return { ...fn, asyncStart: previous.start };
}

function canonical(body) {
  // Resolve lexical symbols before canonicalHelper: native nested callbacks
  // reuse local names which esbuild renames independently in each scope.
  const filename = 'current.mjs';
  const ast = ts.createSourceFile(filename, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const options = { allowJs: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => (file === filename ? ast : undefined);
  const checker = ts.createProgram([filename], options, host).getTypeChecker();
  const bindings = new Map();
  function bind(name) {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol && !bindings.has(symbol))
        bindings.set(symbol, `__executionBinding${bindings.size}`);
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
  const transformed = ts.transform(ast, [
    context => {
      function visit(node) {
        if (ts.isShorthandPropertyAssignment(node)) {
          const value = checker.getShorthandAssignmentValueSymbol(node);
          return ts.factory.createPropertyAssignment(
            node.name.text,
            ts.factory.createIdentifier(bindings.get(value) ?? node.name.text),
          );
        }
        if (
          ts.isBindingElement(node) &&
          !node.propertyName &&
          !node.dotDotDotToken &&
          ts.isIdentifier(node.name) &&
          ts.isObjectBindingPattern(node.parent)
        )
          return ts.factory.updateBindingElement(
            node,
            node.dotDotDotToken,
            ts.factory.createIdentifier(node.name.text),
            ts.visitNode(node.name, visit),
            node.initializer && ts.visitNode(node.initializer, visit),
          );
        if (
          ts.isIdentifier(node) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !(ts.isBindingElement(node.parent) && node.parent.propertyName === node)
        ) {
          const local = bindings.get(checker.getSymbolAtLocation(node));
          if (local) return ts.factory.createIdentifier(local);
          const native = nativeNames.find(
            name =>
              node.text === name || new RegExp(`^${name}(?:\\$\\d+|\\d+)$`, 'u').test(node.text),
          );
          if (native) return ts.factory.createIdentifier(native);
        }
        return ts.visitEachChild(node, visit, context);
      }
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    return canonicalHelper(
      ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]),
    );
  } finally {
    transformed.dispose();
  }
}

function hash(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

function replaceOne(source, before, after, file) {
  const position = source.indexOf(before);
  if (position < 0 || source.indexOf(before, position + 1) !== -1)
    throw new Error(`${file}: native session-current topology changed`);
  return source.slice(0, position) + after + source.slice(position + before.length);
}

function patchBody(body, file) {
  body = replaceOne(
    body,
    'function captureSessionEntryCurrentCheck(params) {',
    `function captureSessionEntryCurrentCheck(params) {
  const expectedExecutionInput = params.expectedSessionEntry;
  const expectedExecutionSession = expectedExecutionInput === undefined ? undefined : Object.freeze({
    sessionId: expectedExecutionInput.sessionId,
    lifecycleRevision: expectedExecutionInput.lifecycleRevision,
    pluginOwnerId: expectedExecutionInput.pluginOwnerId
  });
  if (expectedExecutionSession && ["sessionId", "lifecycleRevision", "pluginOwnerId"].some(field =>
    typeof expectedExecutionSession[field] !== "string" || !expectedExecutionSession[field].trim()))
    throw new Error("An exact execution session and plugin owner are required.");`,
    file,
  );
  body = replaceOne(
    body,
    'projection: "list",',
    'projection: expectedExecutionSession ? "full" : "list",',
    file,
  );
  body = replaceOne(
    body,
    '\t\tconst selected = read.value ? {',
    `\t\tif (expectedExecutionSession && ["sessionId", "lifecycleRevision", "pluginOwnerId"].some(field =>
      read.value?.[field] !== expectedExecutionSession[field])) refuse();
\t\tconst selected = read.value ? {
      ...(expectedExecutionSession ? { pluginOwnerId: read.value.pluginOwnerId } : {}),`,
    file,
  );
  body = replaceOne(
    body,
    'if (params.matchGeneration !== false) {',
    'if (expectedExecutionSession || params.matchGeneration !== false) {',
    file,
  );
  body = replaceOne(
    body,
    'if (current?.sessionId !== selected?.sessionId || current?.lifecycleRevision !== selected?.lifecycleRevision) return false;',
    `if (current?.sessionId !== selected?.sessionId || current?.lifecycleRevision !== selected?.lifecycleRevision ||
      (expectedExecutionSession && current?.pluginOwnerId !== expectedExecutionSession.pluginOwnerId)) return false;`,
    file,
  );
  return replaceOne(
    body,
    'fields: params.matchGeneration === false ? [] : ["sessionId", "lifecycleRevision"],',
    'fields: expectedExecutionSession ? ["sessionId", "lifecycleRevision", "pluginOwnerId"] : params.matchGeneration === false ? [] : ["sessionId", "lifecycleRevision"],',
    file,
  );
}

function assertPluginSessionCurrentCheck(source, file = '<runtime>') {
  const fn = extract(source, file);
  if (hash(fn.body) !== PATCHED_HASH)
    throw new Error(`${file}: plugin session-current guard semantics changed`);
}

function transformPluginSessionCurrentCheck(source, file = '<runtime>') {
  const fn = extract(source, file);
  const actual = hash(fn.body);
  if (actual === PATCHED_HASH) return source;
  if (
    actual !== PRISTINE_HASH ||
    source.includes(MARKER) ||
    source.includes('expectedSessionEntry')
  )
    throw new Error(
      `${file}: historical or partial plugin session-current guard; rebuild pristine runtime`,
    );
  const patched = patchBody(fn.body, file);
  assertPluginSessionCurrentCheck(`async ${patched}`, file);
  return source.slice(0, fn.asyncStart) + `/*${MARKER}*/\nasync ` + patched + source.slice(fn.end);
}

module.exports = {
  transformPluginSessionCurrentCheck,
  assertPluginSessionCurrentCheck,
  __testing: { extract, hash, patchBody, canonical },
};
