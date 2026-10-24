'use strict';

// Capability: stream ordinary runs while retaining owned final-answer revision gates.
// Target: pristine openclaw@2026.10.6 hook registration, attempt preparation and prompt admission.
// Scope: explicitly scoped before_agent_finalize hooks in the built-in local harness.
// Safety: freeze exact registrations after prompt preparation; unknown/unlocked paths remain protected.
// Remove when: native finalize hooks support per-attempt admission shared by streaming and dispatch.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createFinalizeHookAdmission } = require('./finalize-hook-admission.js');
const {
  canonicalHelper, nodes: collect, oneNativeNode: one, parseNativeSource: parse,
  extractNativeFunction, editNativeSource, verifyNativeSupportBindings,
} = require('../../openclaw/native-support-contract.cjs');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const CONTRACT = 'RUNTIME_SCOPED_FINALIZE_ADMISSION_V2026_10_6';
const HELPER = 'createFinalizeHookAdmission';
const signatures = ['createHookRunner', 'prepareStream', 'runEmbeddedAttemptPromptPhase'];
function same(actual, expected, label) {
  if (
    canonicalHelper(`function seam(){${actual}}`) !==
    canonicalHelper(`function seam(){${expected}}`)
  )
    throw new Error(`${label}: historical or partial finalization admission`);
}
function functionRange(source, name) {
  const part = extractNativeFunction(source, name, findMatchingDelimiter);
  if (!part) throw new Error(`${name}: native declaration changed`);
  return { ...part, text: part.body };
}
function editFunction(source, name, edit) {
  const range = functionRange(source, name);
  return editNativeSource(source, [{ ...range, text: edit(range.text) }]);
}
function transformFunction(body, name) {
  // Restore async for parsing await/comma expressions in the prompt handler.
  const prefix = name === 'runEmbeddedAttemptPromptPhase' ? 'async ' : '';
  const ast = parse(prefix + body);
  const fn = ast.statements[0];
  const text = node => node.getText(ast);
  const offset = prefix.length;
  const edits = [];
  const add = (at, value) => edits.push({ start: at - offset, end: at - offset, value });
  const replace = (node, value) =>
    edits.push({ start: node.getStart(ast) - offset, end: node.end - offset, value });
  const property = (object, key) => object.properties.find(p => p.name?.getText(ast) === key);
  const addProperty = (object, value) => add(object.properties.pos, value + ',');
  const assertProperty = (object, key, expected) => {
    const current = property(object, key);
    if (current) same(`return {${text(current)}};`, `return {${expected}};`, name + '/' + key);
    else addProperty(object, expected);
  };
  const boundName = key => {
    const bindings = collect(
      fn,
      n => ts.isBindingElement(n) && (n.propertyName?.getText(ast) ?? n.name.getText(ast)) === key,
    );
    return text(one(bindings, name + '/' + key).name);
  };
  if (name === 'createHookRunner') {
    const registry = text(fn.parameters[0].name);
    const run = one(
      collect(
        fn,
        n => ts.isFunctionDeclaration(n) && /^runModifyingHook\d*$/.test(n.name?.text ?? ''),
      ),
      name + '/native dispatch',
    );
    const output = one(
      fn.body.statements.filter(ts.isReturnStatement),
      name + '/return',
    ).expression;
    if (!ts.isObjectLiteralExpression(output)) throw new Error('Hook runner return changed');
    const original = property(output, 'runBeforeAgentFinalize');
    if (!original) throw new Error('Native finalization hook missing');
    const invoke = one(
      collect(original, ts.isCallExpression).filter(n => text(n.expression) === text(run.name)),
      name + '/finalization dispatch',
    );
    if (invoke.arguments.length !== 4) throw new Error('Native hook dispatch arguments changed');
    const event = invoke.arguments[1];
    if (!ts.isCallExpression(event) || event.arguments.length !== 2)
      throw new Error('Native run identity binding changed');
    const merge = property(invoke.arguments[3], 'mergeResults');
    if (!merge) throw new Error('Native finalization merge missing');
    const mergeName = ts.isShorthandPropertyAssignment(merge)
      ? text(merge.name)
      : text(merge.initializer);
    assertProperty(
      output,
      'createBeforeAgentFinalizeAdmission',
      `createBeforeAgentFinalizeAdmission: () => ${HELPER}(${registry}, (event, context, selected) => ${text(run.name)}("before_agent_finalize", ${text(event.expression)}(event, context), context, {mergeResults:${mergeName}, includeRegistration: registration => selected === undefined || (selected.has(registration) && selected.get(registration) === registration.handler)}))`,
    );
  } else if (name === 'prepareStream') {
    const hookRunner = boundName('hookRunner');
    const should = one(
      collect(
        fn,
        n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'shouldRunBeforeAgentFinalize',
      ),
      name + '/gate',
    );
    const expected = `const runFinalizeAdmission = ${hookRunner}?.createBeforeAgentFinalizeAdmission?.();`;
    const admission = collect(
      fn,
      n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'runFinalizeAdmission',
    );
    if (admission.length)
      same(`const ${text(one(admission, name + '/admission'))};`, expected, name);
    else add(should.parent.parent.end, expected);
    const call = one(
      collect(
        fn,
        n =>
          ts.isCallExpression(n) &&
          /^runAgentHarnessBeforeAgentFinalizeHook\d*$/.test(text(n.expression)),
      ),
      name + '/finalize',
    );
    const options = call.arguments[0];
    const runner = property(options, 'hookRunner');
    const replacement = `hookRunner: runFinalizeAdmission ? runFinalizeAdmission.runner(${hookRunner}) : ${hookRunner}`;
    if (ts.isShorthandPropertyAssignment(runner)) replace(runner, replacement);
    else same(`return {${text(runner)}};`, `return {${replacement}};`, name + '/runner');
    const subscribe = one(
      collect(
        fn,
        n =>
          ts.isCallExpression(n) && /^subscribeEmbeddedAgentSession\d*$/.test(text(n.expression)),
      ),
      name + '/subscribe',
    );
    const optionsObject = subscribe.arguments[0];
    const deferred = property(optionsObject, 'deferTerminalDelivery');
    const getter =
      'get deferTerminalDelivery() { return shouldRunBeforeAgentFinalize === true && (runFinalizeAdmission?.required ?? true); }';
    if (ts.isGetAccessor(deferred))
      same(`return {${text(deferred)}};`, `return {${getter}};`, name + '/defer');
    else {
      same(
        `return {${text(deferred)}};`,
        'return {deferTerminalDelivery: shouldRunBeforeAgentFinalize === true};',
        name + '/native defer',
      );
      replace(deferred, getter);
    }
    const output = one(
      fn.body.statements.filter(ts.isReturnStatement),
      name + '/return',
    ).expression;
    assertProperty(
      output,
      'lockBeforeAgentFinalize',
      'lockBeforeAgentFinalize: context => runFinalizeAdmission?.lock(context)',
    );
  } else {
    const runtime = boundName('preparedStreamRuntime');
    const assembly = one(
      collect(
        fn,
        n =>
          ts.isVariableDeclaration(n) &&
          n.initializer &&
          ts.isAwaitExpression(n.initializer) &&
          ts.isCallExpression(n.initializer.expression) &&
          /^prepareEmbeddedAttemptPromptAssembly\d*$/.test(
            text(n.initializer.expression.expression),
          ),
      ),
      name + '/post-prompt assembly',
    );
    const owner = text(assembly.name);
    const statementFor = node => {
      while (node && !ts.isStatement(node)) node = node.parent;
      return node;
    };
    const active = one(
      collect(
        fn,
        n =>
          ts.isCallExpression(n) &&
          text(n.expression) === owner + '.assertHostActive' &&
          statementFor(n)?.parent === assembly.parent.parent.parent,
      ),
      name + '/authority',
    );
    const expected = `${runtime}.stream.lockBeforeAgentFinalize?.(${owner}.hookCtx)`;
    const existing = collect(
      fn,
      n =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'lockBeforeAgentFinalize',
    );
    if (existing.length) {
      const current = one(existing, name + '/lock');
      same(text(current) + ';', expected + ';', name + '/lock');
      const sequence = [];
      const flatten = node => {
        if (ts.isParenthesizedExpression(node)) flatten(node.expression);
        else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) {
          flatten(node.left);
          flatten(node.right);
        } else sequence.push(node);
      };
      const statement = statementFor(active);
      if (!ts.isExpressionStatement(statement))
        throw new Error('Finalization authority expression changed');
      flatten(statement.expression);
      if (
        sequence.indexOf(active) < 0 ||
        sequence.indexOf(current) !== sequence.indexOf(active) + 1
      )
        throw new Error('Finalization lock moved outside the admitted post-prompt boundary');
    } else replace(active, `(${text(active)}, ${expected})`);
  }
  let result = body;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}
function transformRegistration(source) {
  const ast = parse(source);
  const text = node => node.getText(ast);
  const registration = one(
    collect(ast, n => ts.isVariableDeclaration(n) && n.name.getText(ast) === 'registerTypedHook'),
    'typed hook registrar',
  );
  if (
    !ts.isArrowFunction(registration.initializer) ||
    registration.initializer.parameters.length !== 5
  )
    throw new Error('Native hook registrar parameters changed');
  const args = registration.initializer.parameters.map(p => text(p.name));
  const push = one(
    collect(
      registration.initializer,
      n =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        text(n.expression).endsWith('.typedHooks.push'),
    ),
    'typed hook publication',
  );
  const object = push.arguments[0];
  const expected = `...${args[1]} === "before_agent_finalize" && ${args[3]}?.appliesToAgentRun !== undefined ? {appliesToAgentRun:${args[3]}.appliesToAgentRun} : {}`;
  const current = object.properties.filter(
    p => ts.isSpreadAssignment(p) && text(p).includes('appliesToAgentRun'),
  );
  if (current.length) {
    same(
      `return {${text(one(current, 'finalization registrar'))}};`,
      `return {${expected}};`,
      'registrar',
    );
    return source;
  }
  return (
    source.slice(0, object.properties.pos) + expected + ',' + source.slice(object.properties.pos)
  );
}
function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const current = source.includes(CONTRACT);
  const behavior =
    source.includes('runFinalizeAdmission') ||
    source.includes('appliesToAgentRun') ||
    source.includes('createBeforeAgentFinalizeAdmission');
  if (behavior && !current && !isGatewayBundlePath(file))
    throw new Error(`${file}: finalization admission marker missing`);
  let result = source;
  if (result.includes('function createHookRunner(')) {
    if (result.includes(`function ${HELPER}(`)) {
      try {
        verifyNativeSupportBindings(result, createFinalizeHookAdmission.toString(), findMatchingDelimiter);
      } catch {
        throw new Error(`${file}: finalization admission implementation changed`);
      }
    } else {
      if (current || result.includes('createBeforeAgentFinalizeAdmission'))
        throw new Error('Partial finalization admission helper');
      result = result.replace(
        'function createHookRunner(',
        createFinalizeHookAdmission.toString() + '\nfunction createHookRunner(',
      );
    }
  }
  for (const name of signatures)
    if (result.includes(`function ${name}(`))
      result = editFunction(result, name, body => transformFunction(body, name));
  if (result.includes('const registerTypedHook =')) result = transformRegistration(result);
  if ((current || behavior) && result !== source)
    throw new Error(`${file}: partial finalization admission patch`);
  if (result === source && !current) {
    if (!isGatewayBundlePath(file))
      throw new Error(`${file}: finalization admission marker missing`);
    return source;
  }
  return current || isGatewayBundlePath(file) ? result : `// ${CONTRACT}\n` + result;
}
const ADMISSION_CONTEXT =
  'Readonly<Pick<PluginHookAgentContext, "agentId" | "runId" | "sessionId" | "sessionKey" | "workspaceDir">>';
const OPTION = ` & (K extends "before_agent_finalize" ? { /** Synchronous identity-only admission after prompt assembly and before agent-run hooks/model output. Only false excludes the hook, permanently for this attempt; later state changes are not re-evaluated. */ appliesToAgentRun?: (ctx: ${ADMISSION_CONTEXT}) => boolean } : { appliesToAgentRun?: never })`;
const REGISTRATION = `\n  appliesToAgentRun?: (ctx: ${ADMISSION_CONTEXT}) => boolean;`;
const ADMISSION_TYPE =
  '\n  createBeforeAgentFinalizeAdmission: () => { lock(ctx: PluginHookAgentContext): void; readonly required: boolean; runner(original: ReturnType<typeof createHookRunner>): ReturnType<typeof createHookRunner>; };';
function transformTypes(source, file) {
  const registrationAnchor =
    'type PluginHookRegistration$1<K extends PluginHookName = PluginHookName> = {';
  const optionsAnchor = 'type PluginHookRegistrationOptions<K extends PluginHookName> = {';
  const states = [];
  const edits = [];
  let hasRegistration = false;
  let hasOptions = false;
  if (source.includes(registrationAnchor)) {
    hasRegistration = true;
    const at = source.indexOf(registrationAnchor) + registrationAnchor.length;
    const runner = source.indexOf('declare function createHookRunner(');
    if (runner < 0) throw new Error('Native hook runner declarations changed');
    const paren = source.indexOf('(', runner);
    const end = findMatchingDelimiter(source, paren, '(', ')', file);
    const body = source.indexOf('{', end) + 1;
    const registrationCurrent = source.slice(at).startsWith(REGISTRATION);
    const runnerCurrent = source.slice(body).startsWith(ADMISSION_TYPE);
    if (registrationCurrent !== runnerCurrent)
      throw new Error('Partial hook runner admission declarations');
    states.push(registrationCurrent);
    if (!registrationCurrent) {
      edits.push({ at, text: REGISTRATION }, { at: body, text: ADMISSION_TYPE });
    }
  }
  if (source.includes(optionsAnchor)) {
    hasOptions = true;
    const start = source.indexOf(optionsAnchor) + optionsAnchor.length - 1;
    const end = findMatchingDelimiter(source, start, '{', '}', file) + 1;
    const optionsCurrent = source.slice(end).startsWith(OPTION);
    states.push(optionsCurrent);
    if (!optionsCurrent) edits.push({ at: end, text: OPTION });
  }
  if (hasRegistration && !hasOptions)
    throw new Error(`${file}: native hook registration options declaration missing`);
  if (path.basename(file) === 'config-contracts-C65kIjn4.d.ts' && !hasRegistration)
    throw new Error(`${file}: native hook registration declaration missing`);
  if (states.length === 0) return source;
  if (states.some(Boolean) && !states.every(Boolean))
    throw new Error(`${file}: partial registration and options admission declarations`);
  if (states.every(Boolean)) {
    const expectedOptions = (hasRegistration ? 1 : 0) + (hasOptions ? 2 : 0);
    if (
      (source.match(/\bappliesToAgentRun\b/g) ?? []).length !== expectedOptions ||
      (source.match(/\bcreateBeforeAgentFinalizeAdmission\b/g) ?? []).length !==
        (hasRegistration ? 1 : 0)
    )
      throw new Error(`${file}: partial or duplicate admission declarations`);
    return source;
  }
  if (source.includes('appliesToAgentRun') || source.includes('createBeforeAgentFinalizeAdmission'))
    throw new Error(`${file}: historical or partial finalization admission types`);
  let next = source;
  for (const edit of edits.sort((left, right) => right.at - left.at))
    next = next.slice(0, edit.at) + edit.text + next.slice(edit.at);
  return next;
}
function processTargets(root, verify) {
  const anchors = [...signatures.map(name => `function ${name}(`), 'const registerTypedHook ='];
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 2 : 1;
  const groups = anchors.map(anchor => findFilesContaining(root, anchor));
  if (groups.some(files => files.length !== expected))
    throw new Error(`Finalization admission copies changed: ${groups.map(g => g.length)}`);
  const entries = [...new Set(groups.flat())].map(file => ({
    file,
    source: fs.readFileSync(file, 'utf8'),
  }));
  const native = entries.filter(entry => !isGatewayBundlePath(entry.file));
  if (
    native.some(e => e.source.includes(CONTRACT)) &&
    native.some(e => !e.source.includes(CONTRACT))
  )
    throw new Error('Mixed pristine and patched finalization admission');
  const plans = entries.map(entry => ({ ...entry, next: transform(entry.source, entry.file) }));
  const types = [];
  const pending = [path.join(root, 'dist')];
  while (pending.length)
    for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        const source = fs.readFileSync(file, 'utf8');
        if (
          source.includes('type PluginHookRegistrationOptions<K extends PluginHookName> = {') ||
          source.includes(
            'type PluginHookRegistration$1<K extends PluginHookName = PluginHookName> = {',
          )
        )
          types.push({ file, source, next: transformTypes(source, file) });
      }
    }
  if (types.length !== 1)
    throw new Error(`Finalization admission SDK copies ${types.length}, expected 1`);
  if (
    types.some(p => p.source.includes('appliesToAgentRun')) &&
    types.some(p => !p.source.includes('appliesToAgentRun'))
  )
    throw new Error('Mixed pristine and patched finalization admission declarations');
  if (
    native.some(p => p.source.includes(CONTRACT)) !==
    types.some(p => p.source.includes('appliesToAgentRun'))
  )
    throw new Error('Native and SDK finalization admission are partially applied');
  const bundle = plans.find(p => isGatewayBundlePath(p.file));
  if (bundle && native.every(p => p.source.includes(CONTRACT)) !== (bundle.source === bundle.next))
    throw new Error('Source and bundle finalization admission are partially applied');
  plans.push(...types);
  if (verify) {
    if (plans.some(p => p.source !== p.next))
      throw new Error('Scoped finalization admission is missing');
    return [];
  }
  return plans.flatMap(p =>
    writeIfChanged(p.file, p.source, p.next) ? [path.relative(root, p.file)] : [],
  );
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { CONTRACT, transform, transformTypes, createFinalizeHookAdmission },
};
