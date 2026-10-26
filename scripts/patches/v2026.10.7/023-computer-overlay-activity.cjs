'use strict';

// Capability: content-free activity for the local Windows desktop overlay.
// Target: pristine openclaw@2026.10.7 Gateway computer handler and service.
// Scope: observe admitted, deduplicated native invocations; no new input executor.
// Safety: preserve owner, generation, policy, cancellation, result and cleanup.
// Remove when: native Gateway publishes equivalent local desktop activity events.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { transformSync } = require('esbuild');
const { computerOverlayInvoke } = require('./computer-overlay-activity.js');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const SERVICE = 'RUNTIME_COMPUTER_ACTIVITY_SERVICE_V2026_10_7';
const HANDLER = 'RUNTIME_COMPUTER_ACTIVITY_HANDLER_V2026_10_7';
const GUARD = 'RUNTIME_COMPUTER_ACTIVITY_GUARD_V2026_10_7';
const helper = computerOverlayInvoke.toString();
const callbackFor = context =>
  `activity => ${context}.broadcast("computer.activity", activity, { dropIfSlow: true })`;
const parse = source =>
  ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function canonical(source) {
  const ast = parse(source);
  const transformed = ts.transform(ast, [
    context => {
      const visit = node => {
        if (ts.isIdentifier(node)) {
          const name = node.text.replace(
            /^(request|desktopTarget|invoke|id|input|desktop|clicks|cursor|emit|phase|click|heartbeat|result|value|activity|execution|slot|state|close|release|ownerSignal)\d+$/,
            '$1',
          );
          if (name !== node.text) return ts.factory.createIdentifier(name);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return visit;
    },
  ]);
  try {
    return transformSync(
      ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]),
      {
        minifySyntax: true,
        minifyWhitespace: true,
        legalComments: 'none',
      },
    ).code;
  } finally {
    transformed.dispose();
  }
}
const expression = source => canonical(`const verification = (${source});`);
function collect(node, predicate) {
  const result = [];
  const visit = item => {
    if (predicate(item)) result.push(item);
    ts.forEachChild(item, visit);
  };
  visit(node);
  return result;
}
function unique(items, file) {
  if (items.length !== 1)
    throw new Error(`${file}: computer activity topology changed (${items.length})`);
  return items[0];
}
function scope(source, pattern, file) {
  const match = unique([...source.matchAll(pattern)], file);
  const open = source.indexOf('{', match.index);
  const end = findMatchingDelimiter(source, open, '{', '}', file) + 1;
  return { start: match.index, end, text: source.slice(match.index, end) };
}
function replace(source, start, end, text) {
  return source.slice(0, start) + text + source.slice(end);
}
function prepend(source, text) {
  const offset = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0;
  return source.slice(0, offset) + text + source.slice(offset);
}

function transformService(source, file = '<runtime>') {
  assertCurrentPatchContract(source, SERVICE, file, false);
  const owner = scope(source, /function createGatewayComputerService\([^)]*\)\s*\{/g, file);
  const ast = parse(owner.text);
  const call = unique(
    collect(
      ast,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'invoke',
    ),
    file,
  );
  const native = call.getText(ast);
  const fields = call.arguments[0]?.properties;
  const command = fields?.find(node => node.name?.getText(ast) === 'command')?.initializer;
  const requestName =
    command && ts.isPropertyAccessExpression(command) && command.name.text === 'command'
      ? command.expression.getText(ast)
      : '';
  const assertRuntime = unique(
    collect(
      call,
      node => ts.isCallExpression(node) && /^assertRuntime\d*$/.test(node.expression.getText(ast)),
    ),
    file,
  );
  const runtimeName = assertRuntime.arguments[0]?.getText(ast);
  const execution = unique(
    collect(
      call,
      node => ts.isPropertyAssignment(node) && node.name.getText(ast) === 'executionId',
    ),
    file,
  ).initializer;
  const executionName =
    ts.isPropertyAccessExpression(execution) && execution.name.text === 'physicalId'
      ? execution.expression.getText(ast)
      : '';
  const uuid = unique(
    collect(
      ast,
      node =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'physicalId' &&
        ts.isCallExpression(node.initializer) &&
        /^randomUUID\d*$/.test(node.initializer.expression.getText(ast)),
    ),
    file,
  ).initializer.getText(ast);
  unique(
    collect(
      ast,
      node =>
        (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        node.name?.getText(ast) === 'releaseOwner',
    ),
    file,
  );
  if (
    !/^[A-Za-z_$][\w$]*$/.test(requestName) ||
    !/^[A-Za-z_$][\w$]*$/.test(runtimeName ?? '') ||
    !/^[A-Za-z_$][\w$]*$/.test(executionName) ||
    !native.includes(`${requestName}.assertCurrent()`) ||
    !owner.text.includes(`${executionName}.settled.has(${requestName}.idempotencyKey)`)
  )
    throw new Error(`${file}: native computer admission boundary changed`);
  const expected = `computerOverlayInvoke(${requestName}, ${runtimeName}.desktopTarget, () => ${native}, ${uuid}, ${executionName})`;
  const wrapped = collect(
    ast,
    node => ts.isCallExpression(node) && node.expression.getText(ast) === 'computerOverlayInvoke',
  );
  if (wrapped.length) {
    const wrapper = unique(wrapped, file);
    const declaration = scope(source, /async function computerOverlayInvoke\([^)]*\)\s*\{/g, file);
    if (
      canonical(declaration.text) !== canonical(helper) ||
      expression(wrapper.getText(ast)) !== expression(expected)
    )
      throw new Error(
        `${file}: historical or partial computer activity service; rebuild pristine runtime`,
      );
    assertCurrentPatchContract(source, SERVICE, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(SERVICE) || source.includes('computerOverlayInvoke'))
    throw new Error(`${file}: partial computer activity service; rebuild pristine runtime`);
  const patched = replace(
    source,
    owner.start + call.getStart(ast),
    owner.start + call.end,
    expected,
  );
  return prepend(patched, `// ${SERVICE}\n${helper}\n`);
}

function transformHandler(source, file = '<runtime>') {
  assertCurrentPatchContract(source, HANDLER, file, false);
  const owner = scope(source, /\bcomputerHandlers\s*=\s*\{/g, file);
  const ast = parse(owner.text + ';');
  const handler = unique(
    collect(
      ast,
      node =>
        ts.isPropertyAssignment(node) &&
        ts.isStringLiteral(node.name) &&
        node.name.text === 'computer.invoke',
    ),
    file,
  );
  const optionsName = handler.initializer.parameters?.[0]?.name;
  if (!optionsName || !ts.isIdentifier(optionsName))
    throw new Error(`${file}: computer handler options changed`);
  const call = unique(
    collect(
      handler,
      node =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'invoke',
    ),
    file,
  );
  const serviceName = call.expression.expression.getText(ast);
  unique(
    collect(
      handler,
      node =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(ast) === serviceName &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        node.initializer.name.text === 'gatewayComputerService',
    ),
    file,
  );
  // The minified caller can shadow the destructured context name in the inner
  // callback. Capture the handler options instead of referring to that alias.
  const callback = callbackFor(`${optionsName.text}.context`);
  const params = unique(
    collect(
      handler,
      node =>
        ts.isBindingElement(node) &&
        (node.propertyName?.getText(ast) ?? node.name.getText(ast)) === 'params',
    ),
    file,
  );
  const caller = unique(
    collect(
      handler,
      node =>
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        /^resolveComputerCaller\d*$/.test(node.initializer.expression.getText(ast)),
    ),
    file,
  );
  const argument = call.arguments[0];
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(argument))
    throw new Error(`${file}: computer invoke request changed`);
  const properties = argument.properties;
  const field = properties.find(node => node.name?.getText(ast) === 'onComputerActivity');
  const nativeFields = properties
    .filter(node => node !== field)
    .map(node => node.getText(ast).replace(/\s/g, ''));
  if (
    nativeFields.length !== 2 ||
    nativeFields[0] !== `...${params.name.getText(ast)}` ||
    nativeFields[1] !== `...${caller.name.getText(ast)}`
  )
    throw new Error(`${file}: native computer caller boundary changed`);
  if (field) {
    if (
      !ts.isPropertyAssignment(field) ||
      expression(field.initializer.getText(ast)) !== expression(callback)
    )
      throw new Error(`${file}: historical or partial computer activity callback`);
    assertCurrentPatchContract(source, HANDLER, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(HANDLER) || owner.text.includes('onComputerActivity'))
    throw new Error(`${file}: partial computer activity callback; rebuild pristine runtime`);
  return prepend(
    replace(
      source,
      owner.start + argument.getStart(ast),
      owner.start + argument.end,
      `{ ${nativeFields.join(', ')}, onComputerActivity: ${callback} }`,
    ),
    `// ${HANDLER}\n`,
  );
}

function transformGuard(source, file = '<runtime>') {
  assertCurrentPatchContract(source, GUARD, file, false);
  const owner = scope(source, /\bEVENT_SCOPE_GUARDS\s*=\s*\{/g, file);
  const ast = parse(owner.text + ';');
  const field = collect(
    ast,
    node =>
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === 'computer.activity',
  );
  if (field.length) {
    if (
      expression(unique(field, file).initializer.getText(ast)) !== expression('["operator.admin"]')
    )
      throw new Error(`${file}: partial computer activity event guard`);
    assertCurrentPatchContract(source, GUARD, file, !isGatewayBundlePath(file));
    return source;
  }
  if (source.includes(GUARD)) throw new Error(`${file}: partial computer activity event guard`);
  const open = source.indexOf('{', owner.start) + 1;
  return prepend(
    replace(source, open, open, '\n"computer.activity": ["operator.admin"],\n'),
    `// ${GUARD}\n`,
  );
}

function processTargets(root, verify) {
  const services = findFilesContaining(root, 'function createGatewayComputerService(');
  const handlers = findFilesContaining(root, ['computerHandlers', 'resolveComputerCaller']);
  const guards = findFilesContaining(root, 'function hasEventScope(');
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 2 : 1;
  if (services.length !== expected || handlers.length !== expected || guards.length !== expected)
    throw new Error(
      `Computer activity topology changed: services=${services.length}, handlers=${handlers.length}, guards=${guards.length}, expected=${expected}`,
    );
  const states = [];
  const plans = [...new Set([...services, ...handlers, ...guards])].map(file => {
    const source = fs.readFileSync(file, 'utf8');
    let next = source;
    for (const [files, transform] of [[services, transformService], [handlers, transformHandler], [guards, transformGuard]]) {
      if (!files.includes(file)) continue;
      const before = next;
      next = transform(next, file);
      states.push(before === next);
    }
    if (verify && next !== source) throw new Error(`${file}: computer activity patch missing`);
    return { file, source, next };
  });
  if (states.some(Boolean) && states.some(current => !current))
    throw new Error('Mixed computer activity revisions; rebuild pristine runtime');
  return plans.flatMap(({ file, source, next }) =>
    !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [],
  );
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transformService, transformHandler, transformGuard, SERVICE, HANDLER, GUARD },
};
