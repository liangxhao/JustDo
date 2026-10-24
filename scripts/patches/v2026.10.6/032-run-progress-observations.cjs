'use strict';

// Capability: content-free activity while generic tool arguments/model output stream.
// Target: pristine openclaw@2026.10.6 filters raw toolcall deltas before the public event bus.
// Scope: one observation seam in handleMessageUpdate; reuse native item delivery/snapshots.
// Safety: no arguments/text, execution changes, new RPC, schema or transcript persistence.
// Remove when: native Gateway exposes equivalent provider-independent stream progress.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { canonicalHelper } = require('../../openclaw/native-support-contract.cjs');
const { assertCurrentPatchContract, findFilesContaining, isGatewayBundlePath, nativeSupportModule,
  nativeSupportImport, writeIfChanged } = require('./_patch-utils.js');
const { functionRange, parse, collect, one, same, prepend, assertTargetPaths } = require('./prepared-read-patch-shapes.js');
const { observeRunStreamProgress } = require('../../../src/main/openclaw/runtime/native-support/run-progress.mjs');
const SUPPORT = 'run-progress.mjs';
const SUPPORT_SOURCE = path.resolve(__dirname, '../../../src/main/openclaw/runtime/native-support', SUPPORT);
const CONTRACT = 'RUNTIME_RUN_PROGRESS_OBSERVATIONS_V2026_10_6';
const TARGET = 'dist/builtin-openclaw-CcrkVuBH.mjs';
const OWNER = 'handleMessageUpdate';
const ANCHOR = 'const liveEditDiff = updateLiveEditDiffProgress(ctx.state.liveEditDiffStateById, assistantRecord);';
const STREAM = `observeRunStreamProgress(ctx.state, assistantRecord, progress => {
  const data = { itemId: "run-stream-progress", kind: "status", phase: "update",
    title: "Stream progress", status: "running", progress };
  emitAgentEvent({ runId: ctx.params.runId, stream: "item", data });
  runBestEffortCallback({ label: "run stream progress", log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.({ stream: "item", data }) });
});`;

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const range = functionRange(source, OWNER);
  if (range.text.split(ANCHOR).length !== 2) throw new Error(`${file}: stream observation boundary changed`);
  const ast = parse(range.text);
  const calls = collect(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'observeRunStreamProgress');
  const imports = `import { observeRunStreamProgress } from "${nativeSupportImport(file, SUPPORT)}";`;
  if (source.includes(CONTRACT)) {
    const call = one(calls, file);
    const owner = one(collect(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === OWNER), file);
    if (!source.includes(imports) || !same(call.getText(ast), STREAM.slice(0, -1)) ||
      !ts.isExpressionStatement(call.parent) || call.parent.parent !== owner.body ||
      range.text.slice(call.end, range.text.indexOf(ANCHOR)).trim() !== ';')
      throw new Error(`${file}: stream observation changed`);
    return source;
  }
  if (calls.length || source.includes(SUPPORT)) throw new Error(`${file}: partial stream observation`);
  const body = range.text.replace(ANCHOR, STREAM + '\n' + ANCHOR);
  return prepend(source.slice(0, range.start) + body + source.slice(range.end), `// ${CONTRACT}\n${imports}\n`);
}

function verifyBundle(source) {
  if (canonicalHelper(functionRange(source, 'observeRunStreamProgress').text) !== canonicalHelper(observeRunStreamProgress.toString()))
    throw new Error('Bundle stream progress helper changed');
  const body = functionRange(source, OWNER).text;
  const ast = parse(body);
  const call = one(collect(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'observeRunStreamProgress'), 'bundle stream observation');
  const owner = one(collect(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === OWNER), 'bundle observation owner');
  if (!same(call.getText(ast), STREAM.slice(0, -1)) || !ts.isExpressionStatement(call.parent) || call.parent.parent !== owner.body)
    throw new Error('Bundle stream observation binding changed');
  const anchor = one(collect(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'updateLiveEditDiffProgress'), 'bundle observation boundary');
  if (call.end >= anchor.getStart(ast)) throw new Error('Bundle stream observation moved');
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
  __testing: { transform, verifyBundle, TARGET, CONTRACT } };
