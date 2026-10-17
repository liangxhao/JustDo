/* eslint-disable @typescript-eslint/no-explicit-any -- Exercise locked native JavaScript owners and heterogeneous receipt records in a VM. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import ts from 'typescript';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const { __testing: patch } = require('../../../../scripts/patches/v2026.10.4/030-tool-call-format-recovery.cjs');
const root = path.resolve(__dirname, '../../../..');
const runtime = path.join(root, 'vendor/openclaw-runtime/current');
const dist = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? runtime, 'dist');
const file = fs.readdirSync(dist).find(name => /^builtin-openclaw-.*\.mjs$/.test(name) &&
  fs.readFileSync(path.join(dist, name), 'utf8').includes('function runEmbeddedAttemptSettledPhase('));
const source = file ? fs.readFileSync(path.join(dist, file), 'utf8') : '';
let facts: any;
let nativeActivity: any;
let nativeAbortable: any;
beforeAll(async () => {
  facts = await import(pathToFileURL(path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery/facts.mjs')).href);
  const activityFile = fs.readdirSync(path.join(runtime, 'dist')).find(name => /^nested-tool-activity-.*\.mjs$/.test(name));
  nativeActivity = await import(pathToFileURL(path.join(runtime, 'dist', activityFile!)).href);
  const abortFile = fs.readdirSync(path.join(runtime, 'dist')).find(name => /^abortable-.*\.mjs$/.test(name));
  nativeAbortable = (await import(pathToFileURL(path.join(runtime, 'dist', abortFile!)).href)).n;
});

function transformed(native = source) {
  const owners = ['runEmbeddedAttemptSettledPhase', 'completeEmbeddedAttemptAfterTurn']
    .map(name => 'async ' + patch.extractFunction(native, name).body).join('\n');
  return patch.transformRunner(owners, 'native-nested-receipt-fixture.mjs');
}

function renamedOwner() {
  const aliases = new Set(['input', 'attempt', 'sessionManager', 'nestedToolActivityState', 'preparedStreamRuntime', 'abortable']);
  const ast = ts.createSourceFile('native.mjs', 'async ' + patch.extractFunction(source, 'runEmbeddedAttemptSettledPhase').body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const transformed = ts.transform(ast, [context => {
    const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (ts.isBindingElement(node) && !node.propertyName && ts.isIdentifier(node.name) && aliases.has(node.name.text))
        return ts.factory.updateBindingElement(node, node.dotDotDotToken, node.name, ts.factory.createIdentifier(node.name.text + 'Owned'), node.initializer);
      if (ts.isShorthandPropertyAssignment(node) && aliases.has(node.name.text))
        return ts.factory.createPropertyAssignment(node.name, ts.factory.createIdentifier(node.name.text + 'Owned'));
      if (ts.isIdentifier(node) && aliases.has(node.text) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isBindingElement(node.parent) && node.parent.propertyName === node))
        return ts.factory.createIdentifier(node.text + 'Owned');
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  try { return ts.createPrinter().printFile(transformed.transformed[0]) + '\nasync ' + patch.extractFunction(source, 'completeEmbeddedAttemptAfterTurn').body; }
  finally { transformed.dispose(); }
}

function fixture(options: { readFailure?: boolean; changedSession?: boolean; changedScope?: boolean; cancelled?: boolean; pendingRead?: boolean; renamed?: boolean; api?: string } = {}) {
  let sessionId = 'native-session';
  let releaseRead: (() => void) | undefined;
  const controller = new AbortController();
  if (options.cancelled) controller.abort(new Error('Native abort'));
  const target = {};
  const activity = nativeActivity.n({
    runId: 'native-run', scopeId: 'native-scope', afterEntryId: 'outer-entry', startOrder: 0,
    parentToolCallId: 'outer', toolCallId: 'inner', toolName: 'show_widget', input: { opaque: 'private-input' },
    result: { content: [{ type: 'text', text: 'private-result' }] }, isError: false, startedAt: 1, timestamp: 2,
  });
  const entries = [{ id: 'inner-entry', message: activity }];
  const readMaintenance = vi.fn(async () => {
    if (options.pendingRead) await new Promise<void>(resolve => { releaseRead = resolve; });
    if (options.readFailure) throw new Error('Read unavailable');
    if (options.changedSession) sessionId = 'replaced-session';
    return { events: entries };
  });
  const context: any = {
    ...facts,
    abortable: vi.fn((pending: Promise<unknown>) => nativeAbortable(controller.signal, pending)),
    asOptionalRecord: (value: any) => value && typeof value === 'object' ? value : undefined,
    prepareSessionTranscriptHydration: () => ({ readMaintenance, assertCurrent: vi.fn() }),
    sameSessionTranscriptTargetBinding: (a: any, b: any) => a === b,
    readNestedToolActivity: nativeActivity.a,
    NESTED_TOOL_ACTIVITY_CUSTOM_TYPE: nativeActivity.t,
    sessionManager: { getSessionId: () => sessionId, getSessionTarget: () => target, getEntries: () => entries },
    nestedToolActivityState: { scopeId: options.changedScope ? 'other-scope' : 'native-scope',
      accepted: { firstEntryId: 'inner-entry', lastEntryId: 'inner-entry', sessionId, target } },
    attempt: { runId: 'native-run', model: { api: options.api ?? 'openai-completions' } },
    preparedStreamRuntime: { stream: { subscription: { toolMetas: [
      { toolCallId: 'inner', toolName: 'show_widget', parentToolCallId: 'outer', isError: false },
      { toolCallId: 'outer', toolName: 'tool_call', isError: false },
    ] } } },
    state: {},
  };
  context.input = { attempt: context.attempt, preparedStreamRuntime: { ...context.preparedStreamRuntime, abortable: context.abortable },
    prepared: { toolBase: { nestedToolActivityState: context.nestedToolActivityState }, sessionRuntime: { sessionManager: context.sessionManager } } };
  context.inputOwned = context.input;
  vm.runInNewContext('async ' + patch.extractFunction(source, 'readAttemptNestedToolActivity').body, context);
  const assistant = { role: 'assistant', content: [], stopReason: 'error', errorCode: 'malformed_tool_call_arguments',
    diagnostics: [{ type: 'tool_call_pre_dispatch_rejection', timestamp: 1,
      details: { batchRejected: true, streamComplete: true, dispatchCount: 0 } }] };
  const result: any = {
    sessionIdUsed: sessionId, currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [{ role: 'user', content: 'Inspect' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'outer', name: 'tool_call', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'outer', toolName: 'tool_call', content: [] }, assistant],
    // The native result normalizer drops parentToolCallId. The new owner must
    // preserve correlation from the original subscription, not infer it later.
    toolMetas: context.preparedStreamRuntime.stream.subscription.toolMetas.map(({ parentToolCallId: _parent, ...meta }: any) => meta),
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    didSendViaMessagingTool: false, messagingToolSentTexts: [], messagingToolSentMediaUrls: [], messagingToolSentTargets: [],
  };
  context.result = result;
  const body = patch.extractFunction(transformed(options.renamed ? renamedOwner() : source), 'runEmbeddedAttemptSettledPhase');
  const receiptStatements: ts.Statement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText() === 'toolCallRecoveryNestedState')) receiptStatements.push(node);
    if (ts.isIfStatement(node) && node.expression.getText().includes('toolCallRecoveryNestedState')) receiptStatements.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body.fn);
  expect(receiptStatements).toHaveLength(2);
  const declaration = body.fn.body.statements.find((node: ts.Node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(item => item.name.getText() === 'result'));
  expect(declaration).toBeDefined();
  const tail = body.body.slice(declaration.end, body.body.lastIndexOf('}'));
  const receiptCode = receiptStatements.map(node => node.getText()).join('\n');
  return { context, result, readMaintenance, controller, releaseRead: () => releaseRead?.(),
    run: async () => vm.runInNewContext(`(async () => {let toolCallRecoveryNestedEvidence; ${receiptCode}\n${tail}})()`, context) };
}

describe.skipIf(!file)('native accepted nested receipt projection', () => {
  it('binds current source shape, is byte-preserving on reverify, and rejects a lost reader', () => {
    const patched = transformed();
    expect(patch.transformRunner(patched, 'native-nested-receipt-fixture.mjs', { verifyOnly: true })).toBe(patched);
    // Match the official bundle recipe: syntax minification is disabled.
    const compiled = transformSync(patched, { minifyWhitespace: true, target: 'node24', format: 'esm' }).code;
    expect(patch.transformRunner(compiled, 'compiled-nested-receipt-fixture.mjs', { verifyOnly: true })).toBe(compiled);
    const weakened = patched.replace(/await input\.preparedStreamRuntime\.abortable\(readAttemptNestedToolActivity\(input\.prepared\.sessionRuntime\.sessionManager, toolCallRecoveryNestedState\)\)/,
      'await Promise.resolve([])');
    expect(weakened).not.toBe(patched);
    expect(() => patch.transformRunner(weakened, 'fixture.mjs', { verifyOnly: true })).toThrow(/partial/);
    expect(() => transformed(source.replaceAll('readAttemptNestedToolActivity', 'foreignReceiptReader'))).toThrow(/reader|readAttempt/);
  });

  it('accepts real native receipts with normalized metadata and retains no input or output', async () => {
    const h = fixture();
    expect(await h.run()).toBe(h.result);
    expect(h.readMaintenance).toHaveBeenCalledWith({ operation: 'nested-activity', scopeId: 'native-scope',
      firstEntryId: 'inner-entry', lastEntryId: 'inner-entry' });
    expect(JSON.stringify(h.result.toolCallRecoveryNestedEvidence)).not.toMatch(/private/);
    expect(facts.observeToolCallRecoveryAttempt(h.result, false, 'native-run')).toMatchObject({ excluded: false, allToolsSettled: true });
    expect(h.context.abortable).toHaveBeenCalledTimes(1);
    const code = transformed();
    expect(code.indexOf('await input.preparedStreamRuntime.abortable(readAttemptNestedToolActivity')).toBeLessThan(code.indexOf('cleanupEmbeddedAttemptStreamExecution('));
  });

  it('uses native input custody after local names change in the bundle', async () => {
    const code = transformed(renamedOwner());
    const compiled = transformSync(code, { minifyWhitespace: true, target: 'node24', format: 'esm' }).code;
    expect(patch.transformRunner(compiled, 'compiled-renamed-nested.mjs', { verifyOnly: true })).toBe(compiled);
    expect(compiled).toContain('inputOwned.attempt.model.api');
    const h = fixture({ renamed: true });
    await h.run();
    expect(facts.observeToolCallRecoveryAttempt(h.result, false, 'native-run')).toMatchObject({ excluded: false, allToolsSettled: true });
  });

  it.each(['readFailure', 'changedSession', 'changedScope', 'cancelled'] as const)('refuses %s without converting uncertainty to success', async failure => {
    const h = fixture({ [failure]: true });
    await h.run();
    expect(facts.observeToolCallRecoveryAttempt(h.result, false, 'native-run')).toMatchObject({ excluded: true, allToolsSettled: false });
  });

  it('does not add a read to attempts without accepted nested activity or another transport', async () => {
    const empty = fixture();
    delete empty.context.nestedToolActivityState.accepted;
    await empty.run();
    expect(empty.readMaintenance).not.toHaveBeenCalled();
    const other = fixture({ api: 'other-native-api' });
    await other.run();
    expect(other.readMaintenance).not.toHaveBeenCalled();
  });

  it('uses native cancellation for a pending read and never publishes its late success', async () => {
    const h = fixture({ pendingRead: true });
    const pending = h.run();
    expect(h.readMaintenance).toHaveBeenCalledTimes(1);
    h.controller.abort(new Error('Stopped'));
    await pending;
    expect(h.result.toolCallRecoveryNestedEvidence).toBeNull();
    h.releaseRead();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.result.toolCallRecoveryNestedEvidence).toBeNull();
    expect(facts.observeToolCallRecoveryAttempt(h.result, false, 'native-run').excluded).toBe(true);
  });
});
