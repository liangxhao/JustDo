import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/034-commentary-block-ownership.cjs');
const { transform, TARGET, CONTRACT } = patch.__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const roots: string[] = [];
// Locked native publication body, including the preceding 028 source-fact wiring.
const owner = `function emitAssistantCommentaryStreamData(ctx, message, finalMessage = false, preparedText) {
  const isResponsesCommentary = isResponsesApiAssistantMessage(message);
  const { lastAssistantStreamContentIndex: index, lastAssistantStreamItemId: itemId } = ctx.state;
  const commentaryMessage = isResponsesCommentary ? scopeAssistantMessageToStreamBlock(message, index, itemId) : message;
  const text = !isResponsesCommentary && preparedText !== undefined ? preparedText : extractAssistantCommentaryText(commentaryMessage);
  if (text && (finalMessage || !isResponsesCommentary || ctx.state.deltaBuffer !== text)) {
    const commentaryItemId = isResponsesCommentary ? itemId : resolveAssistantStreamItemId({ message });
    ctx.emitAssistantStreamData({ text, delta: '', replace: true, phase: 'commentary', itemId: commentaryItemId },
      { finalMessage, sourceMessage: message, messageComplete: finalMessage });
  }
}`;
const helpers = `function parseAssistantTextSignature(block) {
  return block?.textSignature ? JSON.parse(block.textSignature) : null;
}
function isResponsesApiAssistantMessage(message) { return message.api === 'openai-responses'; }
function scopeAssistantMessageToStreamBlock(message, index) { return { ...message, content: [message.content[index]] }; }
function extractAssistantCommentaryText(message) {
  return message.content.filter(block => parseAssistantTextSignature(block)?.phase === 'commentary')
    .map(block => block.text).filter(Boolean).join('\\n');
}
function resolveAssistantStreamItemId({ message }) {
  for (const block of [...message.content].reverse()) {
    const signature = parseAssistantTextSignature(block);
    if (signature?.id) return signature.id;
  }
}
function readAgentAssistantSource(message) { if (message?.role === 'assistant') return message.source; return undefined; }`;
const delivery = `function createReplyDelivery({ state }) {
  const emitAssistantStreamData = (data, options) => {
    if (state.unsubscribed) return;
    const assistantSource = readAgentAssistantSource(state.lastAssistant);
    state.calls.push([data, options, assistantSource]);
  };
  state.emitAssistantStreamData = emitAssistantStreamData;
  return { emitAssistantStreamData };
}`;
const fixture = `${helpers}\n${owner}\n${delivery}\nexport { emitAssistantCommentaryStreamData, createReplyDelivery };`;
const textBlock = (text: string, id: string, phase = 'commentary') => ({
  type: 'text', text, textSignature: JSON.stringify({ v: 1, id, phase }),
});
const message = (content: object[], api = 'openai-completions') => ({
  role: 'assistant', api, content, openclawDelivery: { messageScopeId: 'native-message-1' },
});
function emitter(source = transform(fixture)) {
  const body = functionRange(source, 'emitAssistantCommentaryStreamData').text;
  const deliveryBody = functionRange(source, 'createReplyDelivery').text;
  return new Function(`${helpers}\n${body}\n${deliveryBody}\nreturn { emitAssistantCommentaryStreamData, createReplyDelivery };`)();
}
function context(source = transform(fixture)) {
  const state = { lastAssistantStreamContentIndex: 1, lastAssistantStreamItemId: 'block-1', deltaBuffer: '',
    calls: [] as Array<[Record<string, unknown>, Record<string, unknown> | undefined]>, unsubscribed: false };
  const api = emitter(source);
  const ctx = { state, ...api.createReplyDelivery({ state }) };
  return { ctx, state, emit: (message: object, complete = false, prepared?: string) =>
    api.emitAssistantCommentaryStreamData(ctx, message, complete, prepared) };
}
function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commentary-block-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, TARGET), fixture);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('commentary-block-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('generic complete-message commentary publication', () => {
  test('control reproduces cumulative old text being published under a new block ID', () => {
    const { state, emit } = context(fixture);
    const first = textBlock('First paragraph.', 'block-0');
    emit(message([first]));
    emit(message([first, textBlock('Second paragraph.', 'block-1')]));
    expect(state.calls.map(([data]) => [data.itemId, data.text])).toEqual([
      ['block-0', 'First paragraph.'], ['block-1', 'First paragraph.\nSecond paragraph.'],
    ]);
  });

  test('keeps the native complete message body, identity, and source/completion metadata', () => {
    const { state, emit } = context();
    const source = message([textBlock('First paragraph.', 'block-0'),
      { type: 'thinking', thinking: 'private' }, textBlock('Second paragraph.', 'block-1'),
      { type: 'toolCall', id: 'tool-1', name: 'read' }, textBlock('Done.', 'answer', 'final_answer')]);
    emit(source, true, 'First paragraph.\nSecond paragraph.');
    expect(state.calls.map(([data]) => [data.itemId, data.text])).toEqual([
      ['answer', 'First paragraph.\nSecond paragraph.'],
    ]);
    for (const [data, options] of state.calls) {
      expect(data).toMatchObject({ delta: '', replace: true, phase: 'commentary', commentarySnapshot: 'message' });
      expect(options).toEqual({ finalMessage: true, messageComplete: true, sourceMessage: source });
      expect(options?.sourceMessage).toBe(source);
    }
    expect(JSON.stringify(state.calls.map(([data]) => data))).not.toContain('private');
  });

  test.each([['Same.', 'Same.'], ['Same.', 'Same. More.']])('retains intentional distinct block text %j', (first, second) => {
    const { state, emit } = context();
    emit(message([textBlock(first, 'block-0'), textBlock(second, 'block-1')]));
    expect(state.calls.map(([data]) => [data.itemId, data.text])).toEqual([
      ['block-1', `${first}\n${second}`],
    ]);
  });

  test('preserves Responses active-block selection and completion gates', () => {
    const { ctx, state, emit } = context();
    const source = message([textBlock('First.', 'block-0'), textBlock('Second.', 'block-1')], 'openai-responses');
    ctx.state.deltaBuffer = 'Second.';
    emit(source, false, 'Wrong prepared cumulative text');
    expect(state.calls).toEqual([]);
    emit(source, true);
    expect(state.calls.map(([data]) => [data.itemId, data.text])).toEqual([['block-1', 'Second.']]);
    expect(state.calls[0][0]).not.toHaveProperty('commentarySnapshot');
  });

  test('normalizes the mixed-phase direct publication path without mutating its input', () => {
    const { ctx, state } = context();
    const source = Object.freeze(message(Object.freeze([textBlock('First.', 'block-0'), textBlock('Second.', 'block-1'),
      textBlock('Answer.', 'answer', 'final_answer')]) as unknown as object[]));
    const data = Object.freeze({ text: 'Second.', delta: 'Second.', phase: 'commentary', itemId: 'block-1' });
    ctx.emitAssistantStreamData(data, { sourceMessage: source });
    expect(state.calls[0][0]).toEqual({ ...data, text: 'First.\nSecond.', delta: '', replace: true, commentarySnapshot: 'message' });
    expect(data.text).toBe('Second.');
    expect(source.content).toHaveLength(3);
  });

  test.each([undefined, ''])('preserves prepared text and unscoped source metadata (%j)', scope => {
    const { state, emit } = context();
    const source = message([textBlock('Legacy.', 'legacy')]);
    source.openclawDelivery.messageScopeId = scope as string;
    emit(source, false, 'Prepared legacy text.');
    expect(state.calls[0][0].text).toBe('Prepared legacy text.');
    expect(state.calls[0][0]).not.toHaveProperty('commentarySnapshot');
    expect(state.calls[0][1]?.sourceMessage).toBe(source);
  });

  test('preserves ordinary answer data and stops before extraction after unsubscribe', () => {
    const { ctx, state } = context();
    const data = Object.freeze({ text: 'Answer.', delta: 'Answer.', phase: 'final_answer', itemId: 'answer' });
    ctx.emitAssistantStreamData(data, { sourceMessage: message([textBlock('Other.', 'commentary')]) });
    expect(state.calls[0][0]).toBe(data);
    state.unsubscribed = true;
    const source = { ...message([]), get content() { throw new Error('Must not extract after unsubscribe'); } };
    expect(() => ctx.emitAssistantStreamData({ phase: 'commentary', text: 'Hidden.', delta: '' }, { sourceMessage: source })).not.toThrow();
    expect(state.calls).toHaveLength(1);
  });
});

describe('locked patch and bundle proof', () => {
  test('is idempotent and rejects changed/partial publication or source bindings', () => {
    const next = transform(fixture);
    expect(transform(next)).toBe(next);
    expect(() => transform(`// ${CONTRACT}\n${fixture}`)).toThrow();
    expect(() => transform(next.replace("commentarySnapshot: 'message'", "commentarySnapshot: 'block'"))).toThrow();
    expect(() => transform(next.replace('sourceMessage: message', 'sourceMessage: scopedMessage'))).toThrow();
    expect(() => transform(next.replace('readAgentAssistantSource(state.lastAssistant)', 'otherSource(state.lastAssistant)'))).toThrow();
    expect(() => transform(fixture.replace('delta: \'\'', 'delta: text'))).toThrow();
    expect(() => transform(fixture.replace('const commentaryMessage =', 'const commentaryBlocks = message.content; const commentaryMessage ='))).toThrow();
  });

  test('applies atomically, verifies native and compiled semantics, and preserves all current bytes', () => {
    const root = createRoot();
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toEqual([path.normalize(TARGET)]);
    expect(patch.applyPatch(root)).toEqual([]);
    const source = fs.readFileSync(path.join(root, TARGET), 'utf8');
    const compiled = buildSync({ stdin: { contents: source, resolveDir: root },
      bundle: true, write: false, platform: 'node', target: 'node24', format: 'esm', minifySyntax: true, treeShaking: false }).outputFiles[0].text;
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), compiled);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    expect(patch.applyPatch(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(source);
    expect(fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8')).toBe(compiled);
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), compiled.replace('commentarySnapshot: "message"', 'commentarySnapshot: "block"'));
    expect(() => patch.applyPatch(root)).toThrow();
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(source);
  });

  test('rejects mixed source/bundle states before the first write', () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), transform(fixture));
    expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(fixture);
  });
});
