import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { PRISTINE_REASONING_PARSER } from './reasoning-stream-parser-fixture';

const patch = require('../../../../scripts/patches/v2026.10.6/028-reasoning-completions-streaming.cjs');
const { transform, CONTRACT } = patch.__testing;
const { functionRange, parse, collect, one } =
  require('../../../../scripts/patches/v2026.10.6/prepared-read-patch-shapes.js');
const { PROVIDER_TRANSPORT_PATH, PROVIDER_PARTITIONER_PATH } =
  require('../../../../scripts/openclaw/openclaw-patch-dependencies.cjs');
const subscriberPath = 'dist/builtin-openclaw-CcrkVuBH.mjs';
const snapshotPath = 'dist/server-chat-state-BpVBhVO6.mjs';
// Keep structural fixtures independent of whether the developer's runtime has
// already been patched. Real native functions are covered by the semantic and
// complete pristine-package build tests.
const transport = `async function processCompletionsStream(stream, output, model, compat, options) {
  const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
  const flushReasoningTagTextPartitioner = (allowRecovery = true) => {
    for (const delta of reasoningTagTextPartitioner.flush({ recoverUnclosed: allowRecovery })) consume(delta);
  };
  const sealTextBeforeReasoning = () => { flushReasoningTagTextPartitioner(); };
  const beginReasoning = (hasFollowingVisibleText, forceStrict = false) => {
    if (forceStrict || reasoningTagTextPartitioner.hasPending()) {
      reasoningTagTextPartitioner.markStrict();
    }
    if (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) {
      sealTextBeforeReasoning();
    }
  };
  for await (const chunk of stream) {
    const choiceDelta = chunk.choices[0].delta;
    const reasoningDeltas = collectReasoningDeltas(choiceDelta);
    const hasReasoningThinking = reasoningDeltas.length > 0;
    const hasSameChunkVisibleText = typeof choiceDelta.content === 'string';
    beginReasoning(reasoningDeltas, true);
    const routedDeltas = hasReasoningThinking
      ? reasoningTagTextPartitioner.push(choiceDelta.content)
      : reasoningTagTextPartitioner.pushVisible(choiceDelta.content);
    consume(output, model, compat, options, hasSameChunkVisibleText, routedDeltas);
  }
  flushReasoningTagTextPartitioner();
}`;
const subscriber = `function handleMessageUpdate(ctx, event) {
  const msg = event.message;
  const commentaryText = msg.text;
  if (msg.phase === 'commentary' && commentaryText) {
    emitAssistantCommentaryStreamData(ctx, msg, false, commentaryText);
    return;
  }
  const partialAssistant = event.message;
  const isReasoningCompletionsText = partialAssistant.openclawDelivery?.textPhaseRequiresTerminal;
  if (isReasoningCompletionsText) return;
  const currentSourcePartial = ctx.currentSourcePartial;
  ctx.pushAssistantText(partialAssistant, { emitPartialReply: !currentSourcePartial.hold });
  ctx.emitAssistantStreamData({ text: msg.text }, { finalMessage: false });
  if (msg.final) ctx.emitAssistantStreamData({ text: msg.text }, { finalMessage: true });
  if (!isPhasePendingAnthropicText && !isPhasePendingCompletionsText) ctx.flush();
}
function handleMessageEnd(ctx, event) {
  const assistantMessage = event.message;
  const suppressVisibleAssistantOutput = assistantMessage.phase === 'commentary';
  if (suppressVisibleAssistantOutput) {
    emitAssistantCommentaryStreamData(ctx, assistantMessage, true);
    return;
  }
  ctx.emitAssistantStreamData({ text: assistantMessage.text }, { finalMessage: true });
}
function emitAssistantCommentaryStreamData(ctx, message, finalMessage, text) {
  ctx.emitAssistantStreamData({ text, phase: 'commentary' }, { finalMessage });
}
function resolveAssistantStreamItemId({ message }) {
  const signature = parseAssistantTextSignature(message.content[0]);
  return signature?.id;
}
function createReplyDelivery({ params, state, log }) {
  const lastEmittedCommentaryByItem = new Map();
  const publishAgentEvent = event => {
    if (!emitAgentEventIfCurrent({ runId: params.runId, lifecycleGeneration: params.lifecycleGeneration, ...event })) return;
    if (params.onAgentEvent) runBestEffortCallback({ label: 'assistant agent event', log,
      callback: () => params.onAgentEvent?.(event) });
  };
  const emitAssistantStreamDataSafely = scope => {
    const delivery = scope.delivery;
    const itemId = delivery.eventData?.itemId ?? '';
    const commentarySignature = 'fixture';
    const event = { stream: 'item', data: { kind: 'preamble', itemId, progressText: delivery.eventData.text } };
    if (lastEmittedCommentaryByItem.get(itemId) !== commentarySignature) {
      lastEmittedCommentaryByItem.set(itemId, commentarySignature);
      publishAgentEvent(event);
    }
    drainPartialReply(scope);
  };
  const emitAssistantStreamData = (data, options) => {
    const streamedText = data.text; const raw = { text: streamedText };
    const assistantItemId = resolveAssistantStreamItemId({ message: state.lastAssistant });
    let eventData = data;
    const delivery = { data, eventData,
      emitPartialReply: options?.emitPartialReply === true,
      finalMessage: options?.finalMessage === true, blockIndex: state.assistantMessageIndex };
    if (!eventData && !delivery.emitPartialReply) return;
    emitAssistantStreamDataSafely({ delivery });
  };
  return { emitAssistantStreamData };
}
function subscribeEmbeddedAgentSession(params) {
  const replyDelivery = createReplyDelivery(params);
  const { emitAssistantStreamData } = replyDelivery;
  const ctx = { ...params, emitAssistantStreamData };
  return ctx;
}`;
const snapshot = `function updateChatRunProgressSnapshot(snapshot, event, mode = 'full') {
  const data = event.data ?? {};
  const isAssistant = event.stream === 'assistant' && Boolean(snapshot?.events.some((candidate) => candidate.stream === 'run_status'));
  const next = snapshot ?? { events: [], byteLength: 0 };
  const removeWhere = predicate => { next.events = next.events.filter(candidate => !predicate(candidate)); };
  removeWhere(candidate => {
    if (candidate.stream === 'run_status' || candidate.stream === 'assistant') return true;
    return false;
  });
  const storedData = isAssistant ? {} : { kind: 'preamble', progressText: data.progressText };
  const storedEvent = { ...event, data: storedData };
  let captured = captureProgressEvent(storedEvent);
  if (!captured) return next;
  next.events.push(captured.event);
  while (next.events.length > 100) {
    const oldest = next.events[0];
    const oldestToolCallId = oldest.data.toolCallId;
    removeWhere((candidate) => oldestToolCallId ? (candidate.stream === 'tool' || candidate.stream === 'item') && candidate.data?.toolCallId === oldestToolCallId : candidate === oldest);
  }
  return next;
}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(bundle: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-stream-contract-'));
  roots.push(root);
  const files = [PROVIDER_TRANSPORT_PATH, subscriberPath, PROVIDER_PARTITIONER_PATH, snapshotPath];
  for (const [index, relative] of files.entries()) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [transport, subscriber, PRISTINE_REASONING_PARSER, snapshot][index]);
  }
  if (bundle) {
    files.push('gateway-bundle.mjs');
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'),
      transport + '\n' + subscriber + '\n' + PRISTINE_REASONING_PARSER + '\n' + snapshot);
  }
  return { root, files: files.map(relative => path.join(root, relative)) };
}

describe('protocol-based native reasoning text stream patch', () => {
  it('leaves native publication and subscriber context unchanged', () => {
    const { root, files } = fixture(false);
    patch.applyPatch(root);
    const source = fs.readFileSync(files[1], 'utf8');
    expect(functionRange(source, 'subscribeEmbeddedAgentSession').text)
      .toBe(functionRange(subscriber, 'subscribeEmbeddedAgentSession').text);
    const native = (value: string) => one(collect(parse(functionRange(value, 'createReplyDelivery').text),
      (node: ts.Node) => ts.isVariableDeclaration(node) && node.name.getText() === 'publishAgentEvent'), 'publisher').getText();
    expect(native(source)).toBe(native(subscriber));
    expect(source).not.toMatch(/withAssistantPublicationBatch|pendingAgentPublications|retainedCommentaryItemIds/);
  });

  it.each([false, true])('applies atomically and is byte-idempotent (bundle: %s)', bundle => {
    const { root, files } = fixture(bundle);
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toHaveLength(bundle ? 5 : 4);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(patch.applyPatch(root)).toEqual([]);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('handles the renamed native bundle parameters without widening anchors', () => {
    const source = transport.replace(/\boutput\b/g, 'output2').replace(/\bmodel\b/g, 'model2') +
      '\n' + subscriber;
    const next = transform(source, 'gateway-bundle.mjs');
    expect(next).toContain('const streamStructuredText = options?.strictReasoningTags !== true');
    expect(next).toContain('...output2.openclawDelivery, structuredTextStreaming: true');
    expect(transform(next, 'gateway-bundle.mjs')).toBe(next);
  });

  it('allocates message identity independently of structured-reasoning admission', () => {
    const current = transform(transport);
    const ast = parse(functionRange(current, 'processCompletionsStream').text);
    const fn = ast.statements[0] as ts.FunctionDeclaration;
    const identity = one(fn.body!.statements.filter(node => ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) && node.expression.left.getText(ast) === 'output.openclawDelivery'), 'source identity');
    expect(identity.getText(ast)).toContain('messageScopeId');
    const begin = one(collect(ast, (node: ts.Node) => ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === 'beginReasoning'), 'structured admission');
    expect(begin.getText(ast)).not.toContain('messageScopeId');
    const oldAdmission = current.replace(identity.getText(ast), '').replace(
      '...output.openclawDelivery, structuredTextStreaming: true',
      '...output.openclawDelivery, structuredTextStreaming: true, messageScopeId: globalThis.crypto.randomUUID()',
    );
    expect(() => transform(oldAdmission)).toThrow(/partial|historical/);
  });

  it('rejects a missing or duplicated native target', () => {
    const { root, files } = fixture(false);
    fs.writeFileSync(path.join(root, 'dist/unexpected-copy.mjs'), subscriber);
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/target paths changed/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    fs.rmSync(path.join(root, 'dist/unexpected-copy.mjs'));
    fs.rmSync(files[0]);
    expect(() => patch.applyPatch(root)).toThrow(/target paths changed/);
  });

  it('verifies the snapshot predicate after native bundle binding renames', () => {
    const renamed = snapshot.replace(/\bcandidate\b/g, 'candidate2')
      .replace(/\bevent\b/g, 'event3');
    const current = transform(renamed, 'gateway-bundle.mjs');
    expect(transform(current, 'gateway-bundle.mjs')).toBe(current);
  });

  it('rejects partial shapes before writing any earlier target', () => {
    const { root, files } = fixture(false);
    fs.writeFileSync(files[1], subscriber.replace('!currentSourcePartial.hold', 'false'));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/historical or partial/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('rejects an incomplete terminal scope without changing any target', () => {
    const { root, files } = fixture(true);
    patch.applyPatch(root);
    fs.writeFileSync(files[1], fs.readFileSync(files[1], 'utf8').replace('messageComplete: true', 'messageComplete: false'));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/partial terminal buffer/);
    expect(() => patch.verifyPatch(root)).toThrow(/partial terminal buffer/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('rejects an incomplete source scope before writing any target', () => {
    const { root, files } = fixture(true);
    patch.applyPatch(root);
    fs.writeFileSync(files[1], fs.readFileSync(files[1], 'utf8')
      .replace('sourceMessage: msg', 'sourceMessage: event'));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/partial source message scope/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('rejects the historical preview-only shape without upgrading it in place', () => {
    const { root, files } = fixture(true);
    patch.applyPatch(root);
    const originalDelivery = functionRange(subscriber, 'createReplyDelivery').text;
    for (const file of [files[1], files[4]]) {
      const source = fs.readFileSync(file, 'utf8');
      const range = functionRange(source, 'createReplyDelivery');
      fs.writeFileSync(file, source.slice(0, range.start) + originalDelivery + source.slice(range.end));
    }
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/partially applied message scope/);
    expect(() => patch.verifyPatch(root)).toThrow(/partially applied message scope/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it.each(['withAssistantPublicationBatch', 'pendingAgentPublications', 'retainedCommentaryItemIds'])(
    'rejects the historical receipt/queue design without writes (%s)', historical => {
    const { root, files } = fixture(true);
    patch.applyPatch(root);
    fs.appendFileSync(files[1], `\nconst ${historical} = null;`);
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/historical reasoning receipts/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it.each([0, 1, 2, 3, 4])('rejects mixed source/bundle state without writes (changed target: %s)', index => {
    const { root, files } = fixture(true);
    fs.writeFileSync(files[index], transform(fs.readFileSync(files[index], 'utf8'), files[index]));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/Mixed|partially applied/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('rejects a historical marker and changed current strict admission', () => {
    expect(() => transform('// ' + CONTRACT.replace('2026_10_6', '2026_9_8') + '\n' + transport))
      .toThrow();
    const current = transform(transport);
    expect(() => transform(current.replace('options?.strictReasoningTags !== true', 'true')))
      .toThrow(/partial structured stream policy/);
    expect(() => transform(current.replace(' && !streamStructuredText', '')))
      .toThrow(/partially applied/);
  });

  it('preserves the native pending-syntax phase boundary and rejects the old forced-seal override', () => {
    const current = transform(transport);
    const native = '!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()';
    expect(current).toContain(`if (${native})`);
    expect(() => transform(current.replace(native, `streamStructuredText || ${native}`)))
      .toThrow(/native reasoning phase boundary/);
  });

  it('allows only marked live Agent events and retains the durable partial gate', () => {
    const current = transform(subscriber);
    const ast = parse(functionRange(current, 'handleMessageUpdate').text);
    const hold = one(collect(ast, (node: ts.Node) => ts.isIfStatement(node) &&
      node.expression.getText(ast).startsWith('isReasoningCompletionsText &&')), 'live hold');
    const partial = one(collect(ast, (node: ts.Node) => ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === 'emitPartialReply'), 'durable gate');
    const holds = new Function('isReasoningCompletionsText', 'partialAssistant',
      `return ${hold.expression.getText(ast)};`);
    const emitsPartial = new Function('currentSourcePartial', 'isReasoningCompletionsText',
      `return ${partial.initializer.getText(ast)};`);
    expect(holds(true, { openclawDelivery: { textPhaseRequiresTerminal: true } })).toBe(true);
    expect(holds(true, { openclawDelivery: { structuredTextStreaming: true } })).toBe(false);
    expect(holds(true, { openclawDelivery: { structuredTextStreaming: 'true' } })).toBe(true);
    expect(emitsPartial({ hold: false }, true)).toBe(false);
    expect(emitsPartial({ hold: false }, false)).toBe(true);
    expect(emitsPartial({ hold: true }, false)).toBe(false);
    // These native phase gates must still control durable block accumulation.
    expect(current).toContain('!isPhasePendingAnthropicText && !isPhasePendingCompletionsText');
  });
});
