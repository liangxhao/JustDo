'use strict';

// Capability: durable exact plugin execution facts and run-owned tool cleanup.
// Scope: trusted in-process SDK, existing native registry/session custody.
// Remove when upstream supplies equivalent settlement and cleanup evidence.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const esbuild = require('esbuild');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  normalizeJustDoGatewayBundle,
  writeIfChanged,
} = require('./_patch-utils.js');
const helpers = require('./plugin-owned-execution.js');
const CONTRACT = 'JUSTDO_PLUGIN_OWNED_EXECUTION_V2026_9_8';
const names = Object.keys(helpers);
const helperSource = Object.values(helpers)
  .map(fn => fn.toString())
  .join('\n\n');
const signatures = [
  'createGatewaySubagentRuntime',
  'createSubagentRegistrationRecord',
  'createSubagentRegistryListener',
  'createSyntheticPluginRuntimeClient',
  'resolveInProcessGatewayDispatch',
  'registerPluginSubagentRunFromGateway',
  'createOpenClawCodingToolsInternal',
  'createUnavailableSubagentRuntime',
  'createDeferredGatewaySubagentRuntime',
  'createPluginRuntimeResolver',
  'startAgentRunExecution',
  'prepareAgentRunDispatch',
  'dispatchAgentRunFromGateway',
  'runAgentAttempt',
  'resolveEmbeddedRunModelSetup',
  'selectEmbeddedRunHarness',
  'selectEmbeddedRunHarnessForPreparedAttempts',
  'prepareEmbeddedRunRuntime',
  'getCodeModeExecBeforeHookMetadata',
];

function nodes(root, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}
function one(root, predicate, label) {
  const found = nodes(root, predicate);
  if (found.length !== 1) throw new Error(`${label}: topology changed (${found.length})`);
  return found[0];
}
function property(node, name) {
  return (
    ts.isObjectLiteralExpression(node) && node.properties.find(p => p.name?.getText() === name)
  );
}
function objectAt(call, index) {
  const object = call.arguments[index];
  if (!object || !ts.isObjectLiteralExpression(object))
    throw new Error('Plugin execution object boundary changed');
  return object;
}
function editFunction(source, name, edit) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  if (start < 0 || source.indexOf(signature, start + 1) >= 0)
    throw new Error(`${name}: topology changed`);
  const paren = source.indexOf('(', start);
  const close = findMatchingDelimiter(source, paren, '(', ')', name);
  const open = source.indexOf('{', close);
  const end = findMatchingDelimiter(source, open, '{', '}', name);
  return source.slice(0, start) + edit(source.slice(start, end + 1)) + source.slice(end + 1);
}

// esbuild removes comments, changes quotes and renames local bindings in the
// Gateway bundle. Compare the complete helper semantics after deterministic
// alpha-renaming, rather than accepting a marker or a few substrings.
function canonicalHelper(body, normalizeAfterMinify = true) {
  const sf = ts.createSourceFile(
    'helper.mjs',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const bindings = new Map();
  const bind = name => {
    if (ts.isIdentifier(name) && !bindings.has(name.text))
      bindings.set(name.text, `local${bindings.size}`);
    else if (ts.isBindingPattern(name))
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  nodes(sf, node => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) bind(node.name);
    return false;
  });
  const result = ts.transform(sf, [
    context => {
      const visit = node => {
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
            ts.factory.createIdentifier(bindings.get(node.name.text) ?? node.name.text),
            node.initializer && ts.visitNode(node.initializer, visit),
          );
        if (ts.isShorthandPropertyAssignment(node))
          return ts.factory.createPropertyAssignment(
            node.name.text,
            ts.factory.createIdentifier(bindings.get(node.name.text) ?? node.name.text),
          );
        if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
        if (ts.isIdentifier(node) && node.text === 'undefined') return ts.factory.createVoidZero();
        if (
          ts.isIdentifier(node) &&
          bindings.has(node.text) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !(ts.isBindingElement(node.parent) && node.parent.propertyName === node)
        )
          return ts.factory.createIdentifier(bindings.get(node.text));
        return ts.visitEachChild(node, visit, context);
      };
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    const normalized = esbuild.transformSync(
      ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]),
      { minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: false, target: 'node24' },
    ).code;
    // Syntax minification can remove intermediate bindings. Renumber the
    // retained bindings once more so source and already-minified code agree.
    return normalizeAfterMinify ? canonicalHelper(normalized, false) : normalized;
  } finally {
    result.dispose();
  }
}

// AST-selected offset edits retain upstream code and minified local names.
function transformFunction(body, name, registry) {
  const sf = ts.createSourceFile(
    'execution.mjs',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fn = sf.statements[0];
  if (!ts.isFunctionDeclaration(fn)) throw new Error(`${name}: declaration changed`);
  const args = fn.parameters.map(p => p.name.getText(sf));
  const edits = [];
  const text = node => node.getText(sf);
  const add = (at, value) => edits.push({ start: at, end: at, value });
  const replace = (node, value) => edits.push({ start: node.getStart(sf), end: node.end, value });
  const has = marker => body.includes(marker);
  const callNamed = callee =>
    one(fn, n => ts.isCallExpression(n) && text(n.expression) === callee, `${name}/${callee}`);
  const addProperty = (object, value) => add(object.properties.pos, `${value},`);
  const calls = nodes(fn, ts.isCallExpression);
  if (name === 'getCodeModeExecBeforeHookMetadata') {
    const addition = `if (isCodeModeControlTool(${args[0]}.tool) && normalizeToolPolicyName(${args[0]}.tool.name) === CODE_MODE_WAIT_TOOL_NAME) return { toolKind: "code_mode_wait" };`;
    if (!has('code_mode_wait')) add(fn.body.statements.pos, addition);
    else if (!normalizeJustDoGatewayBundle(body).includes(normalizeJustDoGatewayBundle(addition)))
      throw new Error('Partial native Code Mode wait identity');
  }
  if (name === 'createSubagentRegistrationRecord') {
    const object = objectAt(callNamed('normalizeSubagentRunState'), 0);
    const addition = `...${args[0]}.justDoPluginExecution ? { justDoPluginExecution: { ...${args[0]}.justDoPluginExecution, epoch: ${args[1]}.lifecycleGeneration, acceptedAt: ${args[1]}.now, executionSettled: false, cleanupSettled: false } } : {}`;
    if (!has('justDoPluginExecution')) addProperty(object, addition);
    else if (!normalizeJustDoGatewayBundle(body).includes(normalizeJustDoGatewayBundle(addition)))
      throw new Error('Partial plugin registration record');
  }
  if (name === 'registerPluginSubagentRunFromGateway') {
    if (!has('let justDoPluginExecution')) {
      const guard = calls.find(c => text(c.expression) === `${args[0]}.assertCurrent`);
      if (!guard) throw new Error('Plugin registration admission guard changed');
      // The minified worker joins this guard and adoption with a comma. Replace
      // the expression itself with a guarded initializer, without breaking it.
      const initialized = `(${args[0]}.assertCurrent(), justDoPluginExecution = justDoCreatePluginExecution(${args[0]}))`;
      add(fn.body.statements.pos, `let justDoPluginExecution;`);
      if (registry.startsWith('Promise.resolve({')) replace(guard, initialized);
      else {
        add(fn.body.statements.pos, `const { justDoCreatePluginExecution } = await ${registry};`);
        replace(guard, initialized);
      }
      const registration = one(
        fn,
        n =>
          ts.isCallExpression(n) &&
          n.arguments[0] &&
          property(n.arguments[0], 'cleanup') &&
          property(n.arguments[0], 'expectsCompletionMessage'),
        'plugin registration',
      );
      addProperty(objectAt(registration, 0), 'justDoPluginExecution');
      const adoption = one(
        fn,
        n =>
          ts.isCallExpression(n) &&
          n.arguments[0] &&
          property(n.arguments[0], 'childSessionKey') &&
          property(n.arguments[0], 'task') &&
          !property(n.arguments[0], 'cleanup'),
        'plugin paused adoption',
      );
      replace(adoption, `(justDoPluginExecution ? false : ${text(adoption)})`);
    } else if (!has('justDoPluginExecution = justDoCreatePluginExecution'))
      throw new Error('Partial plugin registration admission');
  }
  if (name === 'createSubagentRegistryListener' && !has('justDoObservePluginLifecycle')) {
    const entry = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        ts.isPropertyAccessExpression(n.initializer.expression) &&
        n.initializer.expression.name.text === 'get' &&
        n.initializer.arguments[0] &&
        /\.runId$/.test(text(n.initializer.arguments[0])),
      'lifecycle exact entry',
    );
    const event = text(entry.initializer.arguments[0]).slice(0, -6);
    const branch = one(
      fn,
      n =>
        ts.isIfStatement(n) &&
        ts.isBinaryExpression(n.expression) &&
        ts.isStringLiteralLike(n.expression.right) &&
        n.expression.right.text === 'start',
      'lifecycle start',
    );
    add(branch.getStart(sf), `await justDoObservePluginLifecycle(${text(entry.name)}, ${event});`);
  }
  if (name === 'startAgentRunExecution' && !has('justDoCloseManagedRun')) {
    const execution = one(
      fn.body,
      n => ts.isTryStatement(n) && n.parent === fn.body && n.finallyBlock,
      'physical execution finalizer',
    );
    add(
      execution.finallyBlock.statements.pos,
      `try { const { justDoFinishManagedRun: justDoCloseManagedRun } = await ${registry}; await justDoCloseManagedRun(${args[0]}.runId); } finally {`,
    );
    add(execution.finallyBlock.end - 1, '}');
  }
  if (name === 'prepareAgentRunDispatch' && !has('justDoAssertManagedPlacement')) {
    const admission = callNamed(`${args[0]}.acquireGatewayWorkAdmission`);
    const runtime = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        text(n.initializer.expression) === 'resolveAgentRunAdmissionModel',
      'native resolved runtime',
    );
    const binding = runtime.name.elements.find(
      n =>
        n.name.getText(sf) === 'resolvedRuntime' ||
        n.propertyName?.getText(sf) === 'resolvedRuntime',
    );
    if (!binding) throw new Error('Native runtime admission binding changed');
    replace(
      admission,
      `(${args[0]}.client?.internal?.justDoManagedToolsLifetime === "run" ? justDoAssertManagedPlacement(true, ${args[0]}.context, ${args[0]}.getAdmittedSessionId(), ${text(binding.name)}.harness, readAcpSessionMetaForEntry({sessionKey:${args[0]}.resolvedSessionKey, agentId:${args[0]}.activeSessionAgentId, cfg:${args[0]}.cfgForAgent ?? ${args[0]}.cfg, entry:${args[0]}.sessionEntry},{current:true})) : undefined, ${text(admission)})`,
    );
  }
  if (name === 'dispatchAgentRunFromGateway' && !has('justDoAssertManagedPlacement')) {
    const invoke = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isArrowFunction(n.initializer) &&
        ts.isCallExpression(n.initializer.body) &&
        text(n.initializer.body).includes('agentCommandFromGatewayIngress'),
      'actual native invocation',
    );
    const original = text(invoke.initializer.body);
    replace(
      invoke.initializer,
      `() => { if (justDoManagedRunEnabled(${args[0]}.runId)) justDoAssertManagedPlacement(true, ${args[0]}.context, ${args[0]}.ingressOpts.sessionId, "openclaw", readAcpSessionMetaForEntry({sessionKey:${args[0]}.ingressOpts.sessionKey, agentId:${args[0]}.ingressOpts.agentId},{current:true})); return ${original}; }`,
    );
  }
  if (name === 'runAgentAttempt' && !has('justDoRequireManagedHarness')) {
    const cli = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isConditionalExpression(n.initializer) &&
        ts.isCallExpression(n.initializer.whenFalse) &&
        text(n.initializer.whenFalse.expression) === 'isCliProvider',
      'actual CLI resolution',
    );
    replace(
      cli.initializer,
      `((value) => { if (value) justDoRequireManagedHarness(${args[0]}.runId, {id:"cli"}); return value; })(${text(cli.initializer)})`,
    );
  }
  if (
    [
      'resolveEmbeddedRunModelSetup',
      'selectEmbeddedRunHarness',
      'selectEmbeddedRunHarnessForPreparedAttempts',
    ].includes(name) &&
    !has('justDoRequireManagedHarness')
  ) {
    const selected = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        text(n.initializer).includes(
          name === 'selectEmbeddedRunHarnessForPreparedAttempts'
            ? 'selectAgentHarnessForPreparedModelProviders('
            : 'selectAgentHarness(',
        ),
      `${name}/selected actual harness`,
    );
    replace(
      selected.initializer,
      `justDoRequireManagedHarness(${args[0]}.runParams.runId, ${text(selected.initializer)})`,
    );
  }
  if (name === 'prepareEmbeddedRunRuntime' && !has('justDoRequireManagedHarness')) {
    const harness = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isPropertyAccessExpression(n.initializer) &&
        n.initializer.name.text === 'agentHarness',
      'prepared actual harness',
    );
    replace(
      harness.initializer,
      `justDoRequireManagedHarness(${args[0]}.runParams.runId, ${text(harness.initializer)})`,
    );
    for (const assignment of nodes(
      fn,
      n =>
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        text(n.left) === text(harness.name),
    ))
      replace(
        assignment.right,
        `justDoRequireManagedHarness(${args[0]}.runParams.runId, ${text(assignment.right)})`,
      );
  }
  if (name === 'createSyntheticPluginRuntimeClient') {
    const object = one(
      fn,
      n => ts.isObjectLiteralExpression(n) && property(n, 'syntheticClient'),
      'synthetic plugin client',
    );
    if (!has('justDoManagedToolsLifetime'))
      addProperty(
        object,
        `...${args[0]}?.justDoManagedToolsLifetime === "run" ? { justDoManagedToolsLifetime: "run" } : {}`,
      );
  }
  if (name === 'resolveInProcessGatewayDispatch') {
    const client = objectAt(
      one(
        fn,
        n =>
          ts.isCallExpression(n) &&
          text(n.expression) === 'createSyntheticPluginRuntimeClient' &&
          n.arguments[0] &&
          property(n.arguments[0], 'agentRunTracking'),
        'synthetic dispatch client',
      ),
      0,
    );
    const merge = one(
      fn,
      n =>
        ts.isCallExpression(n) &&
        text(n.expression) === 'mergePluginRuntimeClientInternal' &&
        n.arguments[1] &&
        ts.isConditionalExpression(n.arguments[1]),
      'scoped plugin client',
    );
    const object = merge.arguments[1].whenTrue;
    if (!ts.isObjectLiteralExpression(object)) throw new Error('Scoped plugin metadata changed');
    if (!has('justDoManagedToolsLifetime')) {
      addProperty(client, `justDoManagedToolsLifetime: ${args[2]}?.justDoManagedToolsLifetime`);
      addProperty(
        object,
        `...${args[2]}?.justDoManagedToolsLifetime === "run" ? { justDoManagedToolsLifetime: "run" } : {}`,
      );
    } else if (!property(client, 'justDoManagedToolsLifetime'))
      throw new Error('Partial scoped plugin metadata');
  }
  if (name === 'createGatewaySubagentRuntime') {
    const object = one(
      fn,
      n =>
        ts.isObjectLiteralExpression(n) &&
        property(n, 'waitForRun') &&
        property(n, 'deleteSession'),
      'plugin SDK',
    );
    const run = property(object, 'run');
    const params = one(
      run,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.properties.length === 1 &&
        ts.isSpreadAssignment(n.initializer.properties[0]),
      'SDK run params',
    );
    const p = text(params.name);
    const dispatch = one(
      run,
      n => ts.isCallExpression(n) && text(n.expression) === 'dispatchGatewayMethodInProcess',
      'SDK agent dispatch',
    );
    const wire = objectAt(dispatch, 1);
    const options = objectAt(dispatch, 2);
    if (!has('Invalid plugin run timeoutSeconds.')) {
      // Insert at the method body boundary rather than a multi-declaration that
      // includes async side effects in minified copies. Validate the request.
      const r = text(run.parameters[0].name);
      add(
        run.body.statements.pos,
        `if (${r}.timeoutSeconds !== undefined && (!Number.isSafeInteger(${r}.timeoutSeconds) || ${r}.timeoutSeconds < 0)) throw new Error("Invalid plugin run timeoutSeconds."); if (${r}.managedToolsLifetime !== undefined && ${r}.managedToolsLifetime !== "run") throw new Error("Invalid plugin managedToolsLifetime.");`,
      );
      addProperty(
        wire,
        `...${p}.timeoutSeconds !== undefined ? { timeout: (() => { const cap = getInProcessGatewayRequestContext(justDoGatewayResolver)?.getRuntimeConfig()?.agents?.defaults?.timeoutSeconds ?? 172800; return cap > 0 ? Math.min(${p}.timeoutSeconds || cap, cap) : ${p}.timeoutSeconds; })() } : {}`,
      );
      addProperty(
        options,
        `...${p}.managedToolsLifetime === "run" ? { justDoManagedToolsLifetime: "run" } : {}`,
      );
    } else if (
      !text(wire).includes('timeoutSeconds') ||
      !text(options).includes('justDoManagedToolsLifetime')
    )
      throw new Error('Partial SDK execution projection');
    if (!property(object, 'describeRun')) {
      add(
        fn.body.statements.pos,
        `const justDoGatewayResolver = ${args[0]}; const justDoGatewayLifetime = ${args[2]};`,
      );
      addProperty(
        object,
        `async describeRun(params) {
        const context = getInProcessGatewayRequestContext(justDoGatewayResolver);
        const assertCurrent = () => { params.assertCurrent?.(); justDoGatewayLifetime?.throwIfAborted(); if (!context || getInProcessGatewayRequestContext(justDoGatewayResolver) !== context) throw new Error("Plugin execution Gateway binding is unavailable."); };
        assertCurrent();
        const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
        const { justDoDescribePluginRun: describeOwnedRun } = await ${registry};
        assertCurrent();
        const result = await describeOwnedRun(params.runId, pluginId); assertCurrent(); return result;
      }`,
      );
      addProperty(
        object,
        `async cancelRun(params) {
        const context = getInProcessGatewayRequestContext(justDoGatewayResolver);
        const assertCurrent = () => { params.assertCurrent?.(); justDoGatewayLifetime?.throwIfAborted(); if (!context || getInProcessGatewayRequestContext(justDoGatewayResolver) !== context) throw new Error("Plugin execution Gateway binding is unavailable."); };
        assertCurrent();
        const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
        const { justDoDescribePluginRun: describeOwnedRun, justDoPreparePluginCancel: prepareOwnedCancel } = await ${registry};
        assertCurrent(); await describeOwnedRun(params.runId, pluginId); assertCurrent();
        const owned = await prepareOwnedCancel(params.runId, pluginId); assertCurrent();
        if (owned) await dispatchGatewayMethodInProcess("sessions.abort", { key: owned.sessionKey, runId: params.runId, clearQueued: true }, { resolveGatewayContext: justDoGatewayResolver, pluginRuntimeOwnerId: pluginId, sessionMutationCommitGuard: () => { assertCurrent(); owned.assertCurrent(); } });
        assertCurrent(); const result = await describeOwnedRun(params.runId, pluginId); assertCurrent(); return { accepted: true, ...result };
      }`,
      );
    } else if (!property(object, 'cancelRun'))
      throw new Error('Partial SDK owned execution methods');
  }
  if (name === 'createOpenClawCodingToolsInternal' && !has('justDoRegisterManagedToolCleanup')) {
    const scope = one(
      fn,
      n =>
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        text(n.initializer.expression) === 'resolveProcessToolScopeKey',
      'managed tool scope',
    );
    // The one-shot guard is the next statement, after the complete scope binding.
    const guard = one(
      fn,
      n =>
        ts.isIfStatement(n) &&
        text(n.expression).includes('oneShotCliRun') &&
        text(n.expression).includes('registerRunCleanup'),
      'tool cleanup admission',
    );
    add(
      guard.getStart(sf),
      `justDoRegisterManagedToolCleanup(${args[0]}, ${text(scope.name)}, getProcessSupervisor(), waitForExecScope);`,
    );
    const policy = callNamed('projectEffectiveExecPolicy');
    replace(
      policy,
      `justDoValidateManagedExecPolicy(${args[0]}?.runId, ${text(policy)}, ${args[0]}?.sandbox?.enabled)`,
    );
    const core = callNamed('createCoreCodingTools');
    replace(
      core,
      `${text(core)}.map(tool => justDoManagedRunEnabled(${args[0]}?.runId) && tool.name === "exec" ? copyAgentToolMetadata(tool, pinExecToolTarget(tool, {host:"gateway"})) : tool)`,
    );
  }
  if (name === 'createUnavailableSubagentRuntime') {
    const object = one(
      fn,
      n => ts.isObjectLiteralExpression(n) && property(n, 'waitForRun'),
      'unavailable SDK',
    );
    if (!property(object, 'describeRun')) {
      addProperty(object, `describeRun: ${text(property(object, 'waitForRun').initializer)}`);
      addProperty(object, `cancelRun: ${text(property(object, 'waitForRun').initializer)}`);
    } else if (!property(object, 'cancelRun')) throw new Error('Partial unavailable SDK');
  }
  if (name === 'createDeferredGatewaySubagentRuntime' || name === 'createPluginRuntimeResolver') {
    const object = one(
      fn,
      n => ts.isObjectLiteralExpression(n) && property(n, 'waitForRun'),
      'deferred SDK',
    );
    if (!property(object, 'describeRun')) {
      const base = text(property(object, 'waitForRun').initializer);
      if (name === 'createPluginRuntimeResolver') {
        const initializer = property(object, 'waitForRun').initializer;
        if (!ts.isArrowFunction(initializer) || !ts.isCallExpression(initializer.body))
          throw new Error('Plugin scoped runtime boundary changed');
        const scope = text(initializer.body.expression);
        addProperty(
          object,
          `describeRun: ${base.replace(/\.waitForRun\(([\w$]+)\)/g, (_match, p) => `.describeRun({ ...${p}, assertCurrent: () => ${scope}(() => undefined) })`)}`,
        );
        addProperty(
          object,
          `cancelRun: ${base.replace(/\.waitForRun\(([\w$]+)\)/g, (_match, p) => `.cancelRun({ ...${p}, assertCurrent: () => ${scope}(() => undefined) })`)}`,
        );
      } else {
        addProperty(object, `describeRun: ${base.replace(/\.waitForRun\(/g, '.describeRun(')}`);
        addProperty(object, `cancelRun: ${base.replace(/\.waitForRun\(/g, '.cancelRun(')}`);
      }
    } else if (!property(object, 'cancelRun')) throw new Error('Partial deferred SDK');
  }
  let result = body;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

// Remove only this patch's own seams, then rebuild them from the native AST
// anchors. Comparing the complete normalized function also checks execution
// position: a short-circuited call or a call moved into a different branch cannot
// pass merely because its name remains present. Native code and other patches
// (including the prompt-budget hook) remain in the reconstructed function.
function assertCurrentFunction(body, name, registry, registryFile, file) {
  // editFunction starts at "function", excluding an existing async prefix.
  // Restore it for parsing so await(a, b) remains an await/comma expression.
  const sf = ts.createSourceFile(
    'current.mjs',
    'async ' + body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const text = node => node.getText(sf);
  const contains = (node, value) => text(node).includes(value);
  const isHelper = (expression, value) =>
    ts.isIdentifier(expression) && new RegExp(`^${value}\\d*$`).test(expression.text);
  const directCall = (expression, helper) => {
    while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
      expression = expression.expression;
    return ts.isCallExpression(expression) && isHelper(expression.expression, helper);
  };
  const unwrapped = node => {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  let currentRegistry = registry;
  const registryImports = nodes(
    sf,
    node =>
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some(element =>
        /^justDo(?:CreatePluginExecution|FinishManagedRun|DescribePluginRun|PreparePluginCancel)$/.test(
          element.propertyName?.getText(sf) ?? element.name.getText(sf),
        ),
      ) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer),
  );
  for (const declaration of registryImports) {
    const actual = text(declaration.initializer.expression);
    const module = path.basename(registryFile, '.mjs').replace(/[^\w]/g, '_');
    const bundled = `Promise.resolve().then(() => (init_${module}(), ${module}_exports))`;
    if (
      ![registry, `import("./${registryFile}")`, bundled].some(
        expected =>
          canonicalHelper(`function load(){ return ${expected}; }`) ===
          canonicalHelper(`function load(){ return ${actual}; }`),
      )
    )
      throw new Error(`${file}: historical/partial ${name} registry ownership binding`);
    if (
      currentRegistry !== registry &&
      canonicalHelper(`function load(){ return ${currentRegistry}; }`) !==
        canonicalHelper(`function load(){ return ${actual}; }`)
    )
      throw new Error(`${file}: inconsistent ${name} registry ownership binding`);
    currentRegistry = actual;
  }
  const transformResult = ts.transform(sf, [
    context => {
      const visit = node => {
        // The inserted finally wrapper joins exact tool cleanup before retaining
        // the original native finalizer. Preserve that finalizer, not the wrapper.
        if (
          name === 'startAgentRunExecution' &&
          ts.isTryStatement(node) &&
          contains(node.tryBlock, 'justDoCloseManagedRun')
        ) {
          if (!node.finallyBlock) throw new Error(`${file}: partial managed execution finalizer`);
          return node.finallyBlock.statements.map(statement => ts.visitNode(statement, visit));
        }
        if (ts.isVariableStatement(node)) {
          const declarations = node.declarationList.declarations.filter(declaration => {
            const declared = text(declaration.name);
            return (
              !/^justDo(?:GatewayResolver|GatewayLifetime|PluginExecution)\d*$/.test(declared) &&
              !registryImports.includes(declaration)
            );
          });
          if (!declarations.length) return undefined;
          if (declarations.length !== node.declarationList.declarations.length)
            return ts.factory.updateVariableStatement(
              node,
              node.modifiers,
              ts.factory.updateVariableDeclarationList(
                node.declarationList,
                declarations.map(declaration => ts.visitNode(declaration, visit)),
              ),
            );
        }
        if (
          ts.isExpressionStatement(node) &&
          ((name === 'createSubagentRegistryListener' &&
            directCall(node.expression, 'justDoObservePluginLifecycle')) ||
            (name === 'createOpenClawCodingToolsInternal' &&
              (directCall(node.expression, 'justDoRegisterManagedToolCleanup') ||
                (ts.isBinaryExpression(node.expression) &&
                  contains(node.expression, 'justDoRegisterManagedToolCleanup')))))
        )
          return undefined;
        if (
          name === 'getCodeModeExecBeforeHookMetadata' &&
          ts.isIfStatement(node) &&
          contains(node, 'code_mode_wait')
        )
          return undefined;
        if (
          name === 'createGatewaySubagentRuntime' &&
          ts.isIfStatement(node) &&
          (contains(node, 'Invalid plugin run timeoutSeconds.') ||
            contains(node, 'Invalid plugin managedToolsLifetime.'))
        )
          return undefined;
        if (ts.isObjectLiteralExpression(node)) {
          const properties = node.properties.filter(property => {
            const key = property.name?.getText(sf);
            if (
              [
                'createGatewaySubagentRuntime',
                'createUnavailableSubagentRuntime',
                'createDeferredGatewaySubagentRuntime',
                'createPluginRuntimeResolver',
              ].includes(name) &&
              ['describeRun', 'cancelRun'].includes(key)
            )
              return false;
            if (
              name === 'createSubagentRegistrationRecord' &&
              contains(property, '.justDoPluginExecution')
            )
              return false;
            if (name === 'registerPluginSubagentRunFromGateway' && key === 'justDoPluginExecution')
              return false;
            if (
              ['createSyntheticPluginRuntimeClient', 'resolveInProcessGatewayDispatch'].includes(
                name,
              ) &&
              (key === 'justDoManagedToolsLifetime' ||
                (ts.isSpreadAssignment(property) &&
                  contains(property, 'justDoManagedToolsLifetime')))
            )
              return false;
            if (
              name === 'createGatewaySubagentRuntime' &&
              ts.isSpreadAssignment(property) &&
              (contains(property, '.timeoutSeconds') ||
                contains(property, 'justDoManagedToolsLifetime'))
            )
              return false;
            return true;
          });
          if (properties.length !== node.properties.length)
            return ts.factory.updateObjectLiteralExpression(
              node,
              properties.map(property => ts.visitNode(property, visit)),
            );
        }
        if (name === 'registerPluginSubagentRunFromGateway') {
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.CommaToken &&
            ts.isBinaryExpression(node.right) &&
            node.right.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            /^justDoPluginExecution\d*$/.test(text(node.right.left))
          )
            return ts.visitNode(node.left, visit);
          if (ts.isConditionalExpression(node) && contains(node.condition, 'justDoPluginExecution'))
            return ts.visitNode(node.whenFalse, visit);
        }
        if (
          name === 'prepareAgentRunDispatch' &&
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.CommaToken &&
          ts.isConditionalExpression(unwrapped(node.left)) &&
          contains(unwrapped(node.left).whenTrue, 'justDoAssertManagedPlacement')
        )
          return ts.visitNode(node.right, visit);
        if (
          name === 'dispatchAgentRunFromGateway' &&
          ts.isArrowFunction(node) &&
          ts.isBlock(node.body) &&
          node.body.statements.some(
            statement =>
              ts.isIfStatement(statement) &&
              contains(statement.thenStatement, 'justDoAssertManagedPlacement'),
          ) &&
          node.body.statements.some(
            statement =>
              ts.isReturnStatement(statement) &&
              statement.expression &&
              contains(statement.expression, 'agentCommandFromGatewayIngress'),
          )
        ) {
          const returned = node.body.statements.filter(ts.isReturnStatement);
          if (returned.length !== 1 || !returned[0].expression)
            throw new Error(`${file}: partial managed dispatch admission`);
          return ts.factory.updateArrowFunction(
            node,
            node.modifiers,
            node.typeParameters,
            node.parameters,
            node.type,
            node.equalsGreaterThanToken,
            ts.visitNode(returned[0].expression, visit),
          );
        }
        if (
          name === 'runAgentAttempt' &&
          ts.isCallExpression(node) &&
          node.arguments.length === 1 &&
          ts.isArrowFunction(unwrapped(node.expression)) &&
          ts.isBlock(unwrapped(node.expression).body) &&
          unwrapped(node.expression).body.statements.some(
            statement =>
              ts.isIfStatement(statement) &&
              contains(statement.thenStatement, 'justDoRequireManagedHarness'),
          )
        )
          return ts.visitNode(node.arguments[0], visit);
        if (ts.isCallExpression(node)) {
          if (
            isHelper(node.expression, 'justDoRequireManagedHarness') ||
            isHelper(node.expression, 'justDoValidateManagedExecPolicy')
          ) {
            if (node.arguments.length < 2)
              throw new Error(`${file}: partial managed execution wrapper`);
            return ts.visitNode(node.arguments[1], visit);
          }
          if (
            name === 'createOpenClawCodingToolsInternal' &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'map' &&
            contains(node.expression.expression, 'createCoreCodingTools(') &&
            contains(node, 'justDoManagedRunEnabled')
          )
            return ts.visitNode(node.expression.expression, visit);
        }
        if (ts.isIfStatement(node)) {
          const then = ts.visitNode(node.thenStatement, visit) ?? ts.factory.createEmptyStatement();
          const other =
            node.elseStatement &&
            (ts.visitNode(node.elseStatement, visit) ?? ts.factory.createEmptyStatement());
          return ts.factory.updateIfStatement(
            node,
            ts.visitNode(node.expression, visit),
            then,
            other,
          );
        }
        return ts.visitEachChild(node, visit, context);
      };
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    const native = ts
      .createPrinter({ removeComments: true })
      .printFile(transformResult.transformed[0])
      .replace(/^async\s+/, '');
    const residual = new RegExp(
      `\\b(?:${names.join('|')}|justDoGatewayResolver|justDoGatewayLifetime|justDoPluginExecution|justDoManagedToolsLifetime|justDoCloseManagedRun)\\d*\\b`,
    );
    if (
      residual.test(native) ||
      (name === 'getCodeModeExecBeforeHookMetadata' && native.includes('code_mode_wait'))
    )
      throw new Error(
        `${file}: historical/partial ${name} execution seam could not be removed (${native.match(residual)?.[0] ?? 'code_mode_wait'})`,
      );
    const rebuilt = transformFunction(native.trim(), name, currentRegistry);
    // New SDK methods have independent lexical scopes. A bundled local such as
    // context5 may also appear in the outer native function; compare each owned
    // method independently before comparing their surrounding native structure.
    const ownMethods = value => {
      const ast = ts.createSourceFile(
        'methods.mjs',
        'async ' + value,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      return nodes(
        ast,
        node =>
          (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
          ['describeRun', 'cancelRun'].includes(node.name?.getText(ast)),
      ).map(node => node.getText(ast));
    };
    let actualBody = body;
    let expectedBody = rebuilt;
    if (name === 'createGatewaySubagentRuntime') {
      const actual = ownMethods(body);
      const expected = ownMethods(rebuilt);
      if (
        actual.length !== 2 ||
        expected.length !== 2 ||
        actual.some(
          (method, index) =>
            canonicalHelper(`async function ownedMethod(){ return {${method}}; }`) !==
            canonicalHelper(`async function ownedMethod(){ return {${expected[index]}}; }`),
        )
      )
        throw new Error(`${file}: historical/partial owned SDK execution method`);
      for (let index = 0; index < 2; index++) {
        actualBody = actualBody.replace(actual[index], `ownedExecutionMethod${index}: undefined`);
        expectedBody = expectedBody.replace(
          expected[index],
          `ownedExecutionMethod${index}: undefined`,
        );
      }
    }
    if (canonicalHelper('async ' + actualBody) !== canonicalHelper('async ' + expectedBody))
      throw new Error(
        `${file}: historical/partial ${name} execution seam; rebuild pristine runtime`,
      );
  } finally {
    transformResult.dispose();
  }
}

function assertCallerProjection(source, file) {
  const pattern =
    /pluginId:\s*normalizeOptionalString\(([\w$]+)\.client\?\.internal\?\.pluginRuntimeOwnerId\)/g;
  for (const match of source.matchAll(pattern)) {
    let start = source.lastIndexOf('{', match.index);
    let end;
    while (start >= 0) {
      end = findMatchingDelimiter(source, start, '{', '}', file);
      if (end > match.index) break;
      start = source.lastIndexOf('{', start - 1);
    }
    if (start < 0) throw new Error(`${file}: native plugin registration object changed`);
    const sf = ts.createSourceFile(
      'projection.mjs',
      '(' + source.slice(start, end + 1) + ')',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const expression = sf.statements[0]?.expression;
    const object = expression && ts.isParenthesizedExpression(expression) && expression.expression;
    if (!object || !ts.isObjectLiteralExpression(object))
      throw new Error(`${file}: native plugin registration object changed`);
    const fields = object.properties.filter(
      property => property.name?.getText(sf) === 'managedToolsLifetime',
    );
    if (
      fields.length !== 1 ||
      !ts.isPropertyAssignment(fields[0]) ||
      fields[0].initializer.getText(sf).replace(/\s+/g, '') !==
        `${match[1]}.client?.internal?.justDoManagedToolsLifetime`
    )
      throw new Error(`${file}: historical/partial plugin registration lifetime projection`);
  }
}

function assertStaticBindings(source, file, registryFile) {
  if (isGatewayBundlePath(file)) return;
  const declarations = [...source.matchAll(/import\s*\{[^}]*\}\s*from\s*["'][^"']+["']\s*;?/g)];
  const check = (names, module) => {
    const matching = declarations.filter(([declaration]) => declaration.includes(names[0]));
    if (matching.length !== 1)
      throw new Error(`${file}: historical/partial managed execution import`);
    const sf = ts.createSourceFile(
      'bindings.mjs',
      matching[0][0],
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const declaration = sf.statements[0];
    const bindings = declaration.importClause?.namedBindings;
    if (
      !ts.isImportDeclaration(declaration) ||
      !ts.isStringLiteral(declaration.moduleSpecifier) ||
      declaration.moduleSpecifier.text !== module ||
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length !== names.length ||
      bindings.elements.some(
        (element, index) => element.propertyName || element.name.text !== names[index],
      )
    )
      throw new Error(`${file}: historical/partial managed execution import binding`);
  };
  if (
    !source.includes('function persistSubagentRuns(') &&
    [
      'createOpenClawCodingToolsInternal',
      'prepareAgentRunDispatch',
      'runAgentAttempt',
      'resolveEmbeddedRunModelSetup',
    ].some(name => source.includes(`function ${name}(`))
  )
    check(
      [
        'justDoRegisterManagedToolCleanup',
        'justDoValidateManagedExecPolicy',
        'justDoManagedRunEnabled',
        'justDoAssertManagedPlacement',
        'justDoRequireManagedHarness',
      ],
      './' + registryFile,
    );
  if (
    !source.includes('function persistSubagentRuns(') &&
    source.includes('function prepareAgentRunDispatch(')
  )
    check(['readAcpSessionMetaForEntry'], './session-meta-readonly-CM56ub56.mjs');
}

function transform(source, file, registryFile) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const embedded = source.includes('function persistSubagentRuns(');
  const registry = embedded
    ? `Promise.resolve({ ${names.join(', ')} })`
    : `import("./${registryFile}")`;
  let value = source;
  if (embedded) {
    if (!value.includes('function justDoCreatePluginExecution('))
      value = value.replace(
        'function persistSubagentRuns(',
        `${helperSource}\nfunction persistSubagentRuns(`,
      );
    else if (!isGatewayBundlePath(file) && !value.includes(helperSource))
      throw new Error(`${file}: partial native helpers`);
    else if (isGatewayBundlePath(file))
      for (const [name, helper] of Object.entries(helpers)) {
        editFunction(value, name, body => {
          const actual = (helper.toString().startsWith('async ') ? 'async ' : '') + body;
          const nativeEquality =
            value
              .match(
                /import\s*\{\s*isDeepStrictEqual\s+as\s+([\w$]+)\s*\}\s*from\s*["']node:util["']/g,
              )
              ?.map(declaration => declaration.match(/as\s+([\w$]+)/)[1]) ?? [];
          const normalizedActual = actual.replace(/\bisDeepStrictEqual\d+\b/g, alias =>
            nativeEquality.includes(alias) ? 'isDeepStrictEqual' : alias,
          );
          if (canonicalHelper(normalizedActual) !== canonicalHelper(helper.toString()))
            throw new Error(`${file}: partial bundled helper ${name}`);
          return body;
        });
      }
    if (path.basename(file) === registryFile) {
      const exported = `export { ${names.join(', ')} };`;
      if (!value.includes(exported)) value += `\n${exported}\n`;
    }
  }
  const verifyCurrent =
    source.includes(CONTRACT) ||
    (isGatewayBundlePath(file) && source.includes('function justDoCreatePluginExecution('));
  for (const name of signatures)
    if (value.includes(`function ${name}(`))
      value = editFunction(value, name, body => {
        if (verifyCurrent) {
          assertCurrentFunction(body, name, registry, registryFile, file);
          return body;
        }
        return transformFunction(body, name, registry);
      });
  // This admission call site remains outside the registration helper.
  const caller =
    /pluginId:\s*normalizeOptionalString\(([\w$]+)\.client\?\.internal\?\.pluginRuntimeOwnerId\),?/g;
  value = value.replace(caller, (match, p, offset, full) =>
    full
      .slice(offset + match.length)
      .trimStart()
      .startsWith('managedToolsLifetime:')
      ? match
      : `${match.endsWith(',') ? match : match + ','}managedToolsLifetime: ${p}.client?.internal?.justDoManagedToolsLifetime,`,
  );
  assertCallerProjection(value, file);
  if (
    !embedded &&
    [
      'createOpenClawCodingToolsInternal',
      'prepareAgentRunDispatch',
      'runAgentAttempt',
      'resolveEmbeddedRunModelSetup',
    ].some(name => value.includes(`function ${name}(`)) &&
    !value.includes('import { justDoRegisterManagedToolCleanup,')
  )
    value = `import { justDoRegisterManagedToolCleanup, justDoValidateManagedExecPolicy, justDoManagedRunEnabled, justDoAssertManagedPlacement, justDoRequireManagedHarness } from "./${registryFile}";\n${value}`;
  if (
    !embedded &&
    value.includes('function prepareAgentRunDispatch(') &&
    !value.includes('import { readAcpSessionMetaForEntry }')
  )
    value = `import { readAcpSessionMetaForEntry } from "./session-meta-readonly-CM56ub56.mjs";\n${value}`;
  assertStaticBindings(value, file, registryFile);
  if (source.includes(CONTRACT)) {
    if (source !== value) throw new Error(`${file}: partial patch; rebuild pristine runtime`);
    return source;
  }
  if (
    !isGatewayBundlePath(file) &&
    (source.includes('justDoPluginExecution') || source.includes('justDoManagedToolsLifetime'))
  )
    throw new Error(`${file}: historical/partial patch`);
  return value === source ? source : `// ${CONTRACT}\n${value}`;
}

function transformTypes(source, file) {
  if (!source.includes('type SubagentRunParams = {')) return source;
  const params = 'type SubagentRunParams = {';
  const fields =
    '\n  /** Native per-run budget, bounded by the configured native cap. */\n  timeoutSeconds?: number;\n  /** Join owned local tool cleanup before releasing this plugin run. */\n  managedToolsLifetime?: "run";';
  const method = '    waitForRun: (params: SubagentWaitParams) => Promise<AgentWaitResult>;';
  const methods =
    '\n    describeRun: (params: { runId: string }) => Promise<{ runId: string; sessionKey?: string; state: "unknown" | "accepted" | "running" | "settled"; executionSettled?: boolean; cleanupSettled?: boolean; executionStartedAt?: number; executionEndedAt?: number; acceptedAt?: number; epoch?: string; currentEpoch?: boolean; currentSession?: boolean; cancelled?: boolean; outcome?: "ok" | "error" | "cancelled" }>;\n    cancelRun: (params: { runId: string }) => Promise<{ accepted: true; runId: string; state: "unknown" | "accepted" | "running" | "settled"; executionSettled?: boolean; cleanupSettled?: boolean }>;';
  if (source.includes('managedToolsLifetime')) {
    if (!source.includes(params + fields) || !source.includes(method + methods))
      throw new Error(`${file}: historical/partial plugin execution declarations`);
    return source;
  }
  if (source.split(params).length !== 2 || source.split(method).length !== 2)
    throw new Error(`${file}: plugin execution declaration topology changed`);
  return source.replace(params, params + fields).replace(method, method + methods);
}

function processTargets(root, verify) {
  const groups = signatures.map(name => findFilesContaining(root, `function ${name}(`));
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 5 : 4;
  if (groups.some(group => group.length !== expected))
    throw new Error(
      `Plugin execution topology changed: ${groups.map(group => group.length)}, expected ${expected}`,
    );
  const registryFile = groups[1].find(
    file =>
      path.resolve(path.dirname(file)) === path.resolve(root, 'dist') &&
      !file.endsWith('package-update-activation-recovery.mjs'),
  );
  if (!registryFile) throw new Error('Native plugin execution registry module missing');
  // Validate all transforms before writing any target.
  const changes = [...new Set(groups.flat())].map(file => {
    const content = fs.readFileSync(file, 'utf8');
    const next = transform(content, file, path.basename(registryFile));
    if (verify && next !== content) throw new Error(`Plugin execution patch missing: ${file}`);
    return { file, content, next };
  });
  const declarations = [];
  const pending = [path.join(root, 'dist')];
  while (pending.length)
    for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        const content = fs.readFileSync(file, 'utf8');
        if (
          content.includes('type SubagentRunParams = {') ||
          content.includes('type PluginHookToolKind = "code_mode_exec"')
        ) {
          let next = transformTypes(content, file);
          if (next.includes('type PluginHookToolKind = "code_mode_exec";'))
            next = next.replace(
              'type PluginHookToolKind = "code_mode_exec";',
              'type PluginHookToolKind = "code_mode_exec" | "code_mode_wait";',
            );
          if (verify && next !== content)
            throw new Error(`Plugin execution declarations missing: ${file}`);
          declarations.push({ file, content, next });
        }
      }
    }
  if (declarations.filter(item => item.content.includes('type SubagentRunParams = {')).length !== 6)
    throw new Error(`Plugin execution declaration copies changed: ${declarations.length}`);
  changes.push(...declarations);
  return changes.flatMap(({ file, content, next }) =>
    !verify && writeIfChanged(file, content, next) ? [file] : [],
  );
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: {
    transform,
    transformFunction,
    transformTypes,
    editFunction,
    assertCurrentFunction,
    canonicalHelper,
    helpers,
    CONTRACT,
    signatures,
  },
};
