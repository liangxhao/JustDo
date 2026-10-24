import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import { afterEach, describe, expect, test, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.6/032-run-progress-observations.cjs');
const { transform, verifyBundle, TARGET, CONTRACT } = patch.__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.6/prepared-read-patch-shapes.js');
const { observeRunStreamProgress } = require('../../../../src/main/openclaw/runtime/native-support/run-progress.mjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('run-progress-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const fixture = `function handleMessageUpdate(ctx, evt) {
  if (evt.message?.role !== "assistant") return;
  const assistantRecord = evt.assistantMessageEvent;
  const liveEditDiff = updateLiveEditDiffProgress(ctx.state.liveEditDiffStateById, assistantRecord);
  return liveEditDiff;
}`;
const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-progress-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, TARGET), fixture);
  return root;
};
const partial = { content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { secret: 'private-value' }, partialJson: 'private-json' }] };

describe('content-free runtime progress', () => {
  test('counts long arguments with bounded emissions and no argument parsing, copies or previews', () => {
    const state = {};
    const emit = vi.fn();
    observeRunStreamProgress(state, { type: 'toolcall_start', contentIndex: 0, partial }, emit, 0);
    for (let index = 0; index < 2_000; index++) {
      observeRunStreamProgress(state, { type: 'toolcall_delta', contentIndex: 0, partial, delta: 'a'.repeat(1_000) }, emit, index);
    }
    observeRunStreamProgress(state, { type: 'toolcall_end', toolCall: partial.content[0] }, emit, 2_000);
    expect(emit.mock.calls.length).toBeLessThan(12);
    expect(emit.mock.calls.at(-1)?.[0]).toEqual({ kind: 'tool-input', toolCallId: 'call-1', name: 'write', receivedChars: 2_000_000, complete: true });
    observeRunStreamProgress(state, { type: 'toolcall_delta', contentIndex: 0, partial, delta: 'duplicate' }, emit, 3_000);
    expect(emit.mock.calls.at(-1)?.[0].receivedChars).toBe(2_000_000);
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/private-value|private-json|arguments|partialJson/);
    expect(JSON.stringify(state)).not.toContain('private');
    const calls = (state as { runProgressState: { calls: Map<string, unknown> } }).runProgressState.calls;
    expect([...calls]).toEqual([['call-1', { receivedChars: 2_000_000, complete: true }]]);
  });

  test('exposes hidden output only as a counter and isolates subscriptions', () => {
    const emit = vi.fn();
    observeRunStreamProgress({}, { type: 'thinking_delta', delta: 'private reasoning' }, emit, 0);
    expect(emit).toHaveBeenCalledWith({ kind: 'model', receivedChars: 17 });
    observeRunStreamProgress({}, { type: 'text_delta', delta: 'new' }, emit, 0);
    expect(emit.mock.calls.at(-1)?.[0].receivedChars).toBe(3);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private reasoning');
    expect(() => observeRunStreamProgress({}, { type: 'text_delta', delta: 'data' }, () => { throw new Error('observer unavailable'); }, 0)).not.toThrow();
  });

  test('keeps parallel call counts separate and rejects missing identities', () => {
    const state = {};
    const emit = vi.fn();
    observeRunStreamProgress(state, { type: 'toolcall_delta', contentIndex: 0, partial, delta: 'abc' }, emit, 0);
    const second = { content: [{ type: 'toolCall', id: 'call-2', name: 'read' }] };
    observeRunStreamProgress(state, { type: 'toolcall_delta', contentIndex: 0, partial: second, delta: '12345' }, emit, 300);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ toolCallId: 'call-2', receivedChars: 5 });
    observeRunStreamProgress(state, { type: 'toolcall_end', toolCall: partial.content[0] }, emit, 600);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ toolCallId: 'call-1', receivedChars: 3, complete: true });
    observeRunStreamProgress(state, { type: 'toolcall_delta', contentIndex: 7, partial, delta: 'invalid' }, emit, 900);
    expect(emit).toHaveBeenCalledTimes(3);
  });

  test('bounds retained calls without evicting unfinished work', () => {
    const state = {};
    const emit = vi.fn();
    for (let index = 0; index < 64; index++) observeRunStreamProgress(state, {
      type: 'toolcall_start', toolCall: { id: `call-${index}`, name: 'read' },
    }, emit, index);
    const calls = (state as { runProgressState: { calls: Map<string, unknown> } }).runProgressState.calls;
    const overflow = { id: 'overflow-call', name: 'read' };
    observeRunStreamProgress(state, { type: 'toolcall_start', toolCall: overflow }, emit, 65);
    expect(calls.size).toBe(64);
    expect(calls.has('call-0')).toBe(true);
    expect(calls.has(overflow.id)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(64);
    observeRunStreamProgress(state, { type: 'toolcall_end', toolCall: { id: 'call-0', name: 'read' } }, emit, 66);
    observeRunStreamProgress(state, { type: 'toolcall_start', toolCall: overflow }, emit, 67);
    expect(calls.size).toBe(64);
    expect(calls.has('call-0')).toBe(false);
    expect(calls.has(overflow.id)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(66);
  });
});

describe('one-seam locked native patch', () => {
  test('is idempotent and rejects partial/changed current source', () => {
    const next = transform(fixture, TARGET);
    expect(next).not.toBe(fixture);
    expect(transform(next, TARGET)).toBe(next);
    expect(() => transform(`// ${CONTRACT}\n${fixture}`, TARGET)).toThrow();
    expect(() => transform(next.replace('stream: "item"', 'stream: "tool"'), TARGET)).toThrow();
    expect(() => transform(next.replace('observeRunStreamProgress(ctx.state,', 'if (false) observeRunStreamProgress(ctx.state,'), TARGET)).toThrow();
    expect(() => transform(fixture.replace('const liveEditDiff', 'let liveEditDiff'), TARGET)).toThrow();
  });

  test('publishes one ordinary status item to the native bus and callback, leaving diff handling intact', () => {
    const body = functionRange(transform(fixture), 'handleMessageUpdate').text;
    const bus = vi.fn();
    const callback = vi.fn();
    const diff = vi.fn().mockReturnValue('native-diff');
    const handle = new Function('observeRunStreamProgress', 'emitAgentEvent', 'runBestEffortCallback', 'updateLiveEditDiffProgress', `${body}; return handleMessageUpdate;`)(
      observeRunStreamProgress, bus, ({ callback: invoke }: { callback: () => void }) => invoke(), diff,
    );
    const ctx = { state: {}, params: { runId: 'run-1', onAgentEvent: callback } };
    const event = { message: { role: 'assistant' }, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, partial, delta: 'abc' } };
    expect(handle(ctx, event)).toBe('native-diff');
    expect(bus).toHaveBeenCalledWith({ runId: 'run-1', stream: 'item', data: {
      itemId: 'run-stream-progress', kind: 'status', phase: 'update', title: 'Stream progress', status: 'running',
      progress: { kind: 'tool-input', toolCallId: 'call-1', name: 'write', receivedChars: 3, complete: false },
    } });
    expect(callback.mock.calls[0][0].data).toBe(bus.mock.calls[0][0].data);
    expect(JSON.stringify(bus.mock.calls)).not.toContain('private');
    bus.mockImplementation(() => { throw new Error('bus unavailable'); });
    expect(handle({ state: {}, params: ctx.params }, event)).toBe('native-diff');
    expect(diff).toHaveBeenCalledTimes(2);
  });

  test('checks source and the freshly compiled bundle, including semantic tampering', () => {
    const root = createRoot();
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(patch.applyPatch(root)).toEqual([path.normalize(TARGET)]);
    expect(patch.applyPatch(root)).toEqual([]);
    const result = buildSync({ entryPoints: [path.join(root, TARGET)], bundle: true, write: false, format: 'esm', platform: 'node', treeShaking: false });
    const bundle = result.outputFiles[0].text;
    expect(() => verifyBundle(bundle)).not.toThrow();
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), bundle);
    expect(() => patch.verifyPatch(root)).not.toThrow();
    expect(patch.applyPatch(root)).toEqual([]);
    expect(() => verifyBundle(bundle.replace('250', '500'))).toThrow();
    expect(() => verifyBundle(bundle.replace('stream: "item"', 'stream: "tool"'))).toThrow();
    expect(() => verifyBundle(bundle.replace('observeRunStreamProgress(ctx.state,', 'if (false) observeRunStreamProgress(ctx.state,'))).toThrow();
  });

  test('rejects an invalid existing bundle or duplicate owner before writing source/support', () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), 'function handleMessageUpdate() {}');
    expect(() => patch.applyPatch(root)).toThrow();
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(fixture);
    expect(fs.existsSync(path.join(root, 'dist/native-support/run-progress.mjs'))).toBe(false);
    fs.unlinkSync(path.join(root, 'gateway-bundle.mjs'));
    fs.writeFileSync(path.join(root, 'dist/duplicate.mjs'), fixture);
    expect(() => patch.applyPatch(root)).toThrow();
    expect(fs.readFileSync(path.join(root, TARGET), 'utf8')).toBe(fixture);
  });

  test('rejects a disabled source binding even when its existing bundle is correct, without writing', () => {
    const root = createRoot();
    patch.applyPatch(root);
    const sourcePath = path.join(root, TARGET);
    const bundlePath = path.join(root, 'gateway-bundle.mjs');
    const supportPath = path.join(root, 'dist/native-support/run-progress.mjs');
    const result = buildSync({ entryPoints: [sourcePath], bundle: true, write: false, format: 'esm', platform: 'node', treeShaking: false });
    fs.writeFileSync(bundlePath, result.outputFiles[0].text);
    fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8').replace(
      'observeRunStreamProgress(ctx.state,', 'if (false) observeRunStreamProgress(ctx.state,',
    ));
    const files = [sourcePath, supportPath, bundlePath];
    const before = files.map(file => fs.readFileSync(file));
    expect(() => patch.verifyPatch(root)).toThrow('stream observation changed');
    expect(() => patch.applyPatch(root)).toThrow('stream observation changed');
    files.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
  });
});
