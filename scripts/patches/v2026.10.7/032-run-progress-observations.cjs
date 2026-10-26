'use strict';

// Capability: content-free activity during public streams and buffered provider output.
// Target: pristine openclaw@2026.10.7 hides provisional calls before the public event bus.
// Scope: observe message updates and the existing per-request transport activity callback.
// Safety: no arguments/text, execution changes, new RPC, schema or transcript persistence.
// Remove when: native Gateway exposes equivalent provider-independent stream progress.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { assertCurrentPatchContract, findFilesContaining, isGatewayBundlePath, nativeSupportModule,
  nativeSupportImport, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend, assertTargetPaths } = require('./prepared-read-patch-shapes.js');
const { observeRunStreamProgress, observeRunRequestActivity } = require('../../../src/main/openclaw/runtime/native-support/run-progress.mjs');
const SUPPORT = 'run-progress.mjs';
const SUPPORT_SOURCE = path.resolve(__dirname, '../../../src/main/openclaw/runtime/native-support', SUPPORT);
const CONTRACT = 'RUNTIME_RUN_PROGRESS_OBSERVATIONS_V2026_10_7';
const TARGET = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const OWNER = 'handleMessageUpdate';
const REQUEST_OWNER = 'streamWithIdleTimeout';
const ANCHOR = 'const liveEditDiff = updateLiveEditDiffProgress(ctx.state.liveEditDiffStateById, assistantRecord);';
const CONTROLLER = 'const streamAbortController = new AbortController();';
const REQUEST_STATE = 'const requestActivity = { lastAt: -Infinity };';
const REQUEST = `if (progress === true && runId && !settled && !streamAbortController.signal.aborted) {
  observeRunRequestActivity(requestActivity, data => {
    emitAgentEvent({ runId, stream: "item", data });
  });
}`;
const STREAM = `observeRunStreamProgress(ctx.state, assistantRecord, progress => {
  const data = { itemId: "run-stream-progress", kind: "status", phase: "update",
    title: "Stream progress", status: "running", progress };
  emitAgentEvent({ runId: ctx.params.runId, stream: "item", data });
  runBestEffortCallback({ label: "run stream progress", log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.({ stream: "item", data }) });
});`;

function statement(declaration) {
  return ts.isVariableDeclarationList(declaration.parent) &&
    ts.isVariableStatement(declaration.parent.parent) ? declaration.parent.parent : undefined;
}

function directDeclarations(block) {
  return block.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []);
}

// Validate the whole existing callback, its captured identities and the per-request state.
// Derive local names from their native bindings so compiled local renaming is harmless.
function verifyRequest(source, patched, file) {
  const body = functionRange(source, REQUEST_OWNER).text;
  const ast = parse(body);
  const owner = one(collect(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === REQUEST_OWNER), file);
  const returned = one(owner.body.statements.filter(node => ts.isReturnStatement(node) &&
    node.expression && ts.isArrowFunction(node.expression)), file).expression;
  if (!ts.isBlock(returned.body) || !owner.parameters[3] || !ts.isIdentifier(owner.parameters[3].name))
    throw new Error(`${file}: request observation invocation changed`);
  const invocation = returned.body;
  const declarations = directDeclarations(invocation);
  const controller = one(declarations.filter(node => node.initializer &&
    same(node.initializer.getText(ast), 'new AbortController()')), file);
  const run = one(directDeclarations(owner.body).filter(node => node.initializer &&
    same(node.initializer.getText(ast), `${owner.parameters[3].name.text}?.runId`)), file);
  const subscription = one(collect(ast, node => ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'onLlmRequestActivity' && node.arguments.length === 2 &&
    ts.isArrowFunction(node.arguments[1])), file);
  const callback = subscription.arguments[1];
  const registration = ts.isVariableDeclaration(subscription.parent) ? statement(subscription.parent) : undefined;
  const iteration = registration?.parent;
  if (!iteration || !ts.isBlock(iteration) || iteration === invocation ||
    !ts.isFunctionExpression(iteration.parent) || callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) || !ts.isIdentifier(controller.name) ||
    !ts.isIdentifier(run.name) ||
    !same(subscription.arguments[0].getText(ast), `${controller.name.text}.signal`))
    throw new Error(`${file}: request observation subscription changed`);
  const callbackNames = new Set(collect(callback, ts.isIdentifier).map(node => node.text));
  const settled = one(directDeclarations(iteration).filter(node => node.initializer?.kind === ts.SyntaxKind.FalseKeyword &&
    ts.isIdentifier(node.name) && (callbackNames.has(node.name.text) || !patched && node.name.text === 'settled')), file);
  const arm = one(collect(callback, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    directDeclarations(iteration).some(binding => ts.isIdentifier(binding.name) &&
      binding.name.text === node.expression.text && binding.initializer && ts.isArrowFunction(binding.initializer))), file);
  const progress = callback.parameters[0].name.text;
  const observation = collect(callback, node => ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'observeRunRequestActivity');
  let addition = '';
  if (patched) {
    const call = one(observation, file);
    const state = one(declarations.filter(node => ts.isIdentifier(node.name) &&
      node.name.text === call.arguments[0]?.getText(ast)), file);
    const stateStatement = statement(state);
    const controllerStatement = statement(controller);
    const adjacent = stateStatement === controllerStatement
      ? [...state.parent.declarations].indexOf(state) === [...controller.parent.declarations].indexOf(controller) + 1
      : invocation.statements.indexOf(stateStatement) === invocation.statements.indexOf(controllerStatement) + 1;
    if (!adjacent || !(state.parent.flags & ts.NodeFlags.Const) ||
      !same(state.initializer?.getText(ast) ?? '', '{ lastAt: -Infinity }'))
      throw new Error(`${file}: request observation state changed`);
    addition = `if (${progress} === true && ${run.name.text} && !${settled.name.text} && !${controller.name.text}.signal.aborted) {
      observeRunRequestActivity(${state.name.text}, data => { emitAgentEvent({ runId: ${run.name.text}, stream: "item", data }); });
    }`;
  } else if (observation.length || declarations.some(node => node.name.getText(ast) === 'requestActivity')) {
    throw new Error(`${file}: partial request observation`);
  }
  const expected = `(${progress}) => {
    ${arm.expression.getText(ast)}(${progress});
    ${addition}
    if (${progress} && ${run.name.text} && areDiagnosticsEnabledForProcess()) markDiagnosticRunProgress({
      runId: ${run.name.text}, reason: "model_call:stream_progress"
    });
  }`;
  if (!same(callback.getText(ast), expected)) throw new Error(`${file}: request observation changed`);
  if (patched && collect(ast, node => ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'observeRunRequestActivity').length !== 1)
    throw new Error(`${file}: request observation topology changed`);
}

function verifyStream(source, file) {
  const body = functionRange(source, OWNER).text;
  const ast = parse(body);
  const call = one(collect(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'observeRunStreamProgress'), file);
  const owner = one(collect(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === OWNER), file);
  const anchor = one(collect(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'updateLiveEditDiffProgress'), file);
  const boundary = ts.isVariableDeclaration(anchor.parent) ? statement(anchor.parent) : undefined;
  if (!same(call.getText(ast), STREAM.slice(0, -1)) || !ts.isExpressionStatement(call.parent) ||
    call.parent.parent !== owner.body || !boundary || boundary.parent !== owner.body ||
    owner.body.statements.indexOf(boundary) !== owner.body.statements.indexOf(call.parent) + 1)
    throw new Error(`${file}: stream observation changed`);
}

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const range = functionRange(source, OWNER);
  if (range.text.split(ANCHOR).length !== 2) throw new Error(`${file}: stream observation boundary changed`);
  const imports = `import { observeRunStreamProgress, observeRunRequestActivity } from "${nativeSupportImport(file, SUPPORT)}";`;
  if (source.includes(CONTRACT)) {
    if (!source.includes(imports)) throw new Error(`${file}: partial stream observation`);
    verifyStream(source, file);
    verifyRequest(source, true, file);
    return source;
  }
  if (source.includes(SUPPORT) || source.includes('observeRunStreamProgress') || source.includes('observeRunRequestActivity'))
    throw new Error(`${file}: partial stream observation`);
  verifyRequest(source, false, file);
  const request = functionRange(source, REQUEST_OWNER);
  if (request.text.split(CONTROLLER).length !== 2 || request.text.split('armTimer(progress);').length !== 2)
    throw new Error(`${file}: request observation boundary changed`);
  const bodies = [
    { ...range, text: range.text.replace(ANCHOR, STREAM + '\n' + ANCHOR) },
    { ...request, text: request.text.replace(CONTROLLER, CONTROLLER + '\n' + REQUEST_STATE)
      .replace('armTimer(progress);', 'armTimer(progress);\n' + REQUEST) },
  ].sort((left, right) => right.start - left.start);
  for (const body of bodies) source = source.slice(0, body.start) + body.text + source.slice(body.end);
  verifyRequest(source, true, file);
  return prepend(source, `// ${CONTRACT}\n${imports}\n`);
}

function verifyBundle(source) {
  for (const helper of [observeRunStreamProgress, observeRunRequestActivity]) {
    if (canonicalHelper(functionRange(source, helper.name).text) !== canonicalHelper(helper.toString()))
      throw new Error(`Bundle ${helper.name} helper changed`);
  }
  verifyStream(source, 'bundle stream observation');
  verifyRequest(source, true, 'bundle request observation');
}

function processTargets(root, verify) {
  const files = findFilesContaining(root, `function ${OWNER}(`).filter(file => !isGatewayBundlePath(file));
  assertTargetPaths(root, files, [TARGET], 'stream progress');
  const file = files[0];
  const source = fs.readFileSync(file, 'utf8');
  const next = transform(source, file);
  const bundle = path.join(root, 'gateway-bundle.mjs');
  if (fs.existsSync(bundle)) verifyBundle(fs.readFileSync(bundle, 'utf8'));
  const exists = fs.existsSync(path.join(root, 'dist/native-support', SUPPORT));
  if ((source === next) !== exists) throw new Error('Mixed stream progress capability; rebuild pristine runtime');
  if (exists) nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE, true);
  if (verify && source !== next) throw new Error('Native stream progress observations missing');
  nativeSupportModule(root, SUPPORT, SUPPORT_SOURCE, verify);
  return !verify && writeIfChanged(file, source, next) ? [path.relative(root, file)] : [];
}

module.exports = { applyPatch: root => processTargets(root, false), verifyPatch: root => processTargets(root, true),
  __testing: { transform, verifyBundle, TARGET, CONTRACT, REQUEST_OWNER } };
