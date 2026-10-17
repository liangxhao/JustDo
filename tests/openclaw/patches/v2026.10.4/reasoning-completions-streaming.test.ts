import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { PRISTINE_REASONING_PARSER } from './reasoning-stream-parser-fixture';

const patch = require('../../../../scripts/patches/v2026.10.4/029-reasoning-completions-streaming.cjs');
const { transform, CONTRACT } = patch.__testing;
const { functionRange, parse, collect, one } =
  require('../../../../scripts/patches/v2026.10.4/prepared-read-patch-shapes.js');
const { PROVIDER_TRANSPORT_PATH, PROVIDER_PARTITIONER_PATH } =
  require('../../../../scripts/openclaw/openclaw-patch-dependencies.cjs');
const subscriberPath = 'dist/builtin-openclaw-qVsnLx0N.mjs';
// Keep structural fixtures independent of whether the developer's runtime has
// already been patched. Real native functions are covered by the semantic and
// complete pristine-package build tests.
const transport = `async function processCompletionsStream(stream, output, model, compat, options) {
  const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
  const flushReasoningTagTextPartitioner = () => {
    for (const delta of reasoningTagTextPartitioner.flush()) consume(delta);
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
  const partialAssistant = event.message;
  const isReasoningCompletionsText = partialAssistant.openclawDelivery?.textPhaseRequiresTerminal;
  if (isReasoningCompletionsText) return;
  const currentSourcePartial = ctx.currentSourcePartial;
  ctx.pushAssistantText(partialAssistant, { emitPartialReply: !currentSourcePartial.hold });
  if (!isPhasePendingAnthropicText && !isPhasePendingCompletionsText) ctx.flush();
}
function handleMessageEnd(ctx, event) {
  const assistantMessage = event.message;
  const suppressVisibleAssistantOutput = assistantMessage.phase === 'commentary';
  if (suppressVisibleAssistantOutput) {
    emitAssistantCommentaryStreamData(ctx, assistantMessage, true);
    return;
  }
}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(bundle: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-stream-contract-'));
  roots.push(root);
  const files = [PROVIDER_TRANSPORT_PATH, subscriberPath, PROVIDER_PARTITIONER_PATH];
  for (const [index, relative] of files.entries()) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [transport, subscriber, PRISTINE_REASONING_PARSER][index]);
  }
  if (bundle) {
    files.push('gateway-bundle.mjs');
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'),
      transport + '\n' + subscriber + '\n' + PRISTINE_REASONING_PARSER);
  }
  return { root, files: files.map(relative => path.join(root, relative)) };
}

describe('protocol-based native reasoning text stream patch', () => {
  it.each([false, true])('applies atomically and is byte-idempotent (bundle: %s)', bundle => {
    const { root, files } = fixture(bundle);
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toHaveLength(bundle ? 4 : 3);
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

  it('rejects partial shapes before writing any earlier target', () => {
    const { root, files } = fixture(false);
    fs.writeFileSync(files[1], subscriber.replace('!currentSourcePartial.hold', 'false'));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/historical or partial/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it.each([0, 1, 2, 3])('rejects mixed source/bundle state without writes (changed target: %s)', index => {
    const { root, files } = fixture(true);
    fs.writeFileSync(files[index], transform(fs.readFileSync(files[index], 'utf8'), files[index]));
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow(/Mixed|partially applied/);
    expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('rejects a historical marker and changed current strict admission', () => {
    expect(() => transform('// ' + CONTRACT.replace('2026_10_4', '2026_9_8') + '\n' + transport))
      .toThrow();
    const current = transform(transport);
    expect(() => transform(current.replace('options?.strictReasoningTags !== true', 'true')))
      .toThrow(/partial structured stream policy/);
    expect(() => transform(current.replace(' && !streamStructuredText', '')))
      .toThrow(/partially applied/);
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
