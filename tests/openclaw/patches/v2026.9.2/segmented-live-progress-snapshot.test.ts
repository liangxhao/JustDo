import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.9.2/017-segmented-live-progress-snapshot.cjs') as {
  __testing: {
    MARKER: string;
    transformProducer: (content: string, filename: string) => string;
    transformCaller: (content: string, filename: string) => string;
    transformThinkingBoundary: (content: string, filename: string) => string;
  };
};
const { findMatchingDelimiter } = require('../../../../scripts/patches/v2026.9.2/_patch-utils.js') as {
  findMatchingDelimiter: (source: string, start: number, open: string, close: string, label: string) => number;
};
const distRoot = path.resolve('vendor/openclaw-runtime/current/dist');
const runtimeFile = fs.existsSync(distRoot) ? fs.readdirSync(distRoot)
  .filter(name => /^server-chat-state-.*\.js$/u.test(name))
  .map(name => path.join(distRoot, name))
  .find(filename => fs.readFileSync(filename, 'utf8').includes('function updateChatRunProgressSnapshot(')) : undefined;
const workerFile = process.env.JUSTDO_TEST_PRISTINE_RUNTIME
  ? path.join(process.env.JUSTDO_TEST_PRISTINE_RUNTIME, 'dist', 'worker', 'worker.mjs')
  : path.join(distRoot, 'worker', 'worker.mjs');

type Event = { runId: string; seq: number; stream: string; ts: number; data: Record<string, unknown>; sessionKey?: string };
type Snapshot = { events: Event[]; byteLength: number; lastSeq: number };
type Update = (snapshot: Snapshot | undefined, event: Event, mode?: string) => Snapshot;

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const parametersStart = source.indexOf('(', start);
  const parametersEnd = findMatchingDelimiter(source, parametersStart, '(', ')', name);
  const body = source.indexOf('{', parametersEnd);
  const end = findMatchingDelimiter(source, body, '{', '}', name);
  return source.slice(start, end + 1);
}

describe.skipIf(!runtimeFile)('native segmented progress recovery on the v2026.9.2 runtime', () => {
  let original: string;
  let patched: string;
  let update: Update;
  let nativeContext: Record<string, unknown>;

  beforeAll(async () => {
    const pristineSource = process.env.JUSTDO_TEST_PRISTINE_RUNTIME
      ? path.join(process.env.JUSTDO_TEST_PRISTINE_RUNTIME, 'dist', path.basename(runtimeFile!))
      : runtimeFile!;
    original = fs.readFileSync(pristineSource, 'utf8');
    patched = patch.__testing.transformProducer(original, runtimeFile!);
    const native = await import(/* @vite-ignore */ pathToFileURL(runtimeFile!).href);
    const context = {
      jsonUtf8Bytes: (value: unknown) => Buffer.byteLength(JSON.stringify(value)),
      asNullableRecord: (value: unknown) => value && typeof value === 'object' ? value : null,
      projectLiveAssistantBufferedText: native.c,
      normalizeLiveAssistantBufferedText: native.s,
      shouldSuppressAssistantEventForLiveChat: native.d,
      CHAT_RUN_PROGRESS_MAX_EVENTS: 50,
      CHAT_RUN_PROGRESS_MAX_BYTES: 131072,
      CHAT_RUN_PROGRESS_MAX_EVENT_BYTES: 65536,
      CHAT_RUN_PROGRESS_MAX_REVIEWS_PER_TOOL: 16,
    };
    nativeContext = context;
    update = vm.runInNewContext(
      `${extractFunction(patched, 'justdoRetainLiveProgressSegment')}\n` +
      `${extractFunction(patched, 'updateChatRunProgressSnapshot')}\nupdateChatRunProgressSnapshot`, context,
    ) as Update;
  });

  const event = (seq: number, stream: string, data: Record<string, unknown>): Event => ({
    runId: 'announce:requester-settle:test', seq, stream, ts: 1000 + seq, data, sessionKey: 'agent:main:test',
  });

  test.skipIf(!fs.existsSync(workerFile))('patches the pristine npm minified worker and keeps its recovery behavior aligned', () => {
    const worker = fs.readFileSync(workerFile, 'utf8');
    const updated = patch.__testing.transformThinkingBoundary(patch.__testing.transformProducer(worker, workerFile), workerFile);
    expect(patch.__testing.transformProducer(updated, workerFile)).toBe(updated);
    expect(patch.__testing.transformThinkingBoundary(updated, workerFile)).toBe(updated);
    expect(() => patch.__testing.transformThinkingBoundary(updated.replace('justdoThinkingMessageIndex=-1', 'justdoThinkingMessageIndex=0'), workerFile)).toThrow(/partial/);
    const workerUpdate = vm.runInNewContext(
      `${extractFunction(updated, 'justdoRetainLiveProgressSegment')}\n` +
      `${extractFunction(updated, 'updateChatRunProgressSnapshot')}\nupdateChatRunProgressSnapshot`, nativeContext,
    ) as Update;
    let workerSnapshot: Snapshot | undefined;
    let mainSnapshot: Snapshot | undefined;
    for (const input of [
      event(1, 'thinking', { text: 'First', progressMessageStart: true }),
      event(2, 'thinking', { text: 'First thought', progressMessageStart: false }),
      event(3, 'usage', { inputTokens: 10 }),
      event(4, 'thinking', { text: 'Next thought', progressMessageStart: true }),
      event(5, 'assistant', { text: 'Hello', itemId: 'message' }),
      event(6, 'assistant', { text: 'Hel', replace: true, itemId: 'message' }),
    ]) {
      workerSnapshot = workerUpdate(workerSnapshot, structuredClone(input));
      mainSnapshot = update(mainSnapshot, structuredClone(input));
    }
    expect(JSON.stringify(workerSnapshot)).toBe(JSON.stringify(mainSnapshot));
  });

  test('uses native reply-delivery message identities to separate two content-only model messages across usage', () => {
    const deliveryFile = fs.readdirSync(distRoot).filter(name => /^builtin-openclaw-.*\.js$/u.test(name))
      .map(name => path.join(distRoot, name))
      .find(filename => fs.readFileSync(filename, 'utf8').includes('function createReplyDelivery('));
    expect(deliveryFile).toBeDefined();
    const deliverySource = fs.readFileSync(deliveryFile!, 'utf8');
    const nativeHelpers = deliverySource.slice(deliverySource.indexOf('const isStreamAppend ='), deliverySource.indexOf('function createReplyDelivery('));
    const emitted: Event[] = [];
    let seq = 0;
    let snapshot: Snapshot | undefined;
    const create = vm.runInNewContext(`${nativeHelpers}\n${extractFunction(deliverySource, 'createReplyDelivery')}\ncreateReplyDelivery`, {
      randomUUID: () => 'native-subscription',
      emitAgentEvent: (input: { stream: string; data: Record<string, unknown> }) => {
        const next = event(++seq, input.stream, input.data);
        emitted.push(next);
        snapshot = update(snapshot, next);
      },
    }) as (input: Record<string, unknown>) => { emitAssistantStreamData: (data: Record<string, unknown>, options?: Record<string, unknown>) => void };
    const state = { assistantTexts: [], assistantMessageStartIndex: 1, assistantMessageIndex: 1 };
    const delivery = create({ params: { runId: 'run' }, state, log: {} });
    delivery.emitAssistantStreamData({ text: 'First message', delta: 'First message' });
    snapshot = update(snapshot, event(++seq, 'usage', { inputTokens: 20 }));
    state.assistantMessageStartIndex = 2;
    state.assistantMessageIndex = 2;
    delivery.emitAssistantStreamData({ text: 'Second message', delta: 'Second message' });
    delivery.emitAssistantStreamData({ text: 'Corrected second message', delta: '', replace: true });
    expect(emitted.map(input => input.data.itemId)).toEqual([
      'native-subscription:1', 'native-subscription:2', 'native-subscription:2',
    ]);
    expect(emitted.map(input => input.data.progressSegmentFirstSeq)).toEqual([1, 3, 3]);
    expect(snapshot!.events.filter(input => input.stream === 'assistant').map(input => input.data.text)).toEqual([
      'First message', 'Corrected second message',
    ]);
  });

  test('retains native commentary preambles with stable live/recovery identity through update and end', () => {
    const deliveryFile = fs.readdirSync(distRoot).filter(name => /^builtin-openclaw-.*\.js$/u.test(name))
      .map(name => path.join(distRoot, name))
      .find(filename => fs.readFileSync(filename, 'utf8').includes('function createReplyDelivery('));
    expect(deliveryFile).toBeDefined();
    const source = fs.readFileSync(deliveryFile!, 'utf8');
    const helpers = source.slice(source.indexOf('const isStreamAppend ='), source.indexOf('function createReplyDelivery('));
    const emitted: Event[] = [];
    let seq = 0;
    let snapshot: Snapshot | undefined;
    const create = vm.runInNewContext(`${helpers}\n${extractFunction(source, 'createReplyDelivery')}\ncreateReplyDelivery`, {
      randomUUID: () => 'native-subscription',
      emitAgentEvent: (input: { stream: string; data: Record<string, unknown> }) => {
        const next = event(++seq, input.stream, input.data);
        emitted.push(next);
        snapshot = update(snapshot, next);
      },
    }) as (input: Record<string, unknown>) => { emitAssistantStreamData: (data: Record<string, unknown>, options?: Record<string, unknown>) => void };
    const state = { assistantTexts: [], assistantMessageStartIndex: 1, assistantMessageIndex: 1 };
    const delivery = create({ params: { runId: 'run' }, state, log: {} });
    delivery.emitAssistantStreamData({ text: 'Launching', delta: '', phase: 'commentary', itemId: 'preamble-1' });
    delivery.emitAssistantStreamData({ text: 'Launching five agents', delta: '', phase: 'commentary', itemId: 'preamble-1' });
    snapshot = update(snapshot, event(++seq, 'usage', { inputTokens: 20 }));
    delivery.emitAssistantStreamData({ text: 'Launching five agents', delta: '', phase: 'commentary', itemId: 'preamble-1' }, { finalMessage: true });
    expect(emitted.map(input => input.stream)).toEqual(['item', 'item', 'item']);
    expect(emitted.map(input => input.data.progressSegmentFirstSeq)).toEqual([1, 1, 1]);
    expect(snapshot!.events.filter(input => input.stream === 'item')).toEqual([expect.objectContaining({
      seq: 4, ts: 1004,
      data: expect.objectContaining({ kind: 'preamble', itemId: 'preamble-1', progressText: 'Launching five agents',
        phase: 'end', replace: true, progressSegmentFirstSeq: 1, progressSegmentStartedAt: 1001 }),
    })]);
    snapshot = update(snapshot, event(++seq, 'thinking', { text: 'Check readiness' }));
    snapshot = update(snapshot, event(++seq, 'tool', { phase: 'start', name: 'sessions_spawn', toolCallId: 'spawn' }));
    delivery.emitAssistantStreamData({ text: 'Waiting for results', delta: '', phase: 'commentary', itemId: 'preamble-2' });
    expect(snapshot!.events.filter(input => input.stream !== 'usage').map(input => [input.stream, input.data.progressText ?? input.data.text ?? input.data.name])).toEqual([
      ['item', 'Launching five agents'], ['thinking', 'Check readiness'], ['tool', 'sessions_spawn'], ['item', 'Waiting for results'],
    ]);
  });

  test('updates a named preamble after later thinking without moving either segment boundary', () => {
    let snapshot = update(undefined, event(1, 'item', { kind: 'preamble', itemId: 'commentary', phase: 'update', progressText: 'Working' }));
    snapshot = update(snapshot, event(2, 'thinking', { text: 'Check' }));
    snapshot = update(snapshot, event(3, 'item', { kind: 'preamble', itemId: 'commentary', phase: 'end', progressText: 'Working carefully' }));
    snapshot = update(snapshot, event(4, 'thinking', { text: 'Check results' }));
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events.find(input => input.stream === 'item')?.data).toMatchObject({
      progressSegmentFirstSeq: 1, progressSegmentStartedAt: 1001, phase: 'end', progressText: 'Working carefully',
    });
    expect(snapshot.events.find(input => input.stream === 'thinking')?.data).toMatchObject({
      progressSegmentFirstSeq: 2, text: 'Check results',
    });
  });

  test('marks native thinking-only message boundaries without emitting empty or silent events', () => {
    const sourceFile = fs.readdirSync(distRoot).filter(name => /^builtin-openclaw-.*\.js$/u.test(name))
      .map(name => path.join(distRoot, name))
      .find(filename => fs.readFileSync(filename, 'utf8').includes('function createStreamRendering('));
    expect(sourceFile).toBeDefined();
    const source = fs.readFileSync(sourceFile!, 'utf8');
    const updated = patch.__testing.transformThinkingBoundary(source, sourceFile!);
    expect(patch.__testing.transformThinkingBoundary(updated, sourceFile!)).toBe(updated);
    expect(() => patch.__testing.transformThinkingBoundary(updated.replace('let justdoThinkingMessageIndex = -1;', 'let justdoThinkingMessageIndex = 0;'), sourceFile!)).toThrow(/partial/);
    let snapshot: Snapshot | undefined;
    const emitted: Event[] = [];
    let seq = 0;
    const factory = vm.runInNewContext(`${extractFunction(updated, 'createStreamRendering')}\ncreateStreamRendering`, {
      createStreamingDirectiveAccumulator: () => ({ reset() {} }),
      createThinkingTagStreamState: () => ({}), createInlineCodeState: () => ({}),
      emitAgentEvent: (input: { stream: string; data: Record<string, unknown> }) => {
        const next = event(++seq, input.stream, input.data);
        snapshot = update(snapshot, next);
        emitted.push(next);
      },
    }) as (input: Record<string, unknown>) => { emitReasoningStream: (text: string) => void; resetAssistantMessageState: (index: number) => void };
    const params = { runId: 'run', silentExpected: false };
    const state = { assistantMessageIndex: 1, streamReasoning: false };
    const make = () => factory({ params, state, blockChunker: { reset() {} }, flushAssistantStream() {}, pendingBlockReplyTasks: new Set() });
    const rendering = make();
    rendering.emitReasoningStream('First');
    rendering.emitReasoningStream('First reasoning');
    rendering.resetAssistantMessageState(0);
    rendering.emitReasoningStream('Second reasoning');
    snapshot = update(snapshot, event(++seq, 'usage', { inputTokens: 3 }));
    rendering.emitReasoningStream('Second reasoning extended');
    params.silentExpected = true;
    rendering.resetAssistantMessageState(0);
    rendering.emitReasoningStream('Hidden reasoning');
    expect(emitted.map(input => input.data.progressMessageStart)).toEqual([true, false, true, false]);
    expect(emitted.map(input => input.data.progressSegmentFirstSeq)).toEqual([1, 1, 3, 3]);
    expect(snapshot!.events.filter(input => input.stream === 'thinking').map(input => input.data.text)).toEqual(['First reasoning', 'Second reasoning extended']);
  });

  test('replays multiple announce reasoning/reply segments with their live identities', () => {
    let snapshot: Snapshot | undefined;
    const inputs = [
      event(1, 'thinking', { text: 'Compare', delta: 'Compare' }),
      event(2, 'thinking', { text: 'Compare results', delta: ' results' }),
      event(3, 'assistant', { text: 'Two agents', delta: 'Two agents' }),
      event(4, 'usage', { inputTokens: 20 }),
      event(5, 'assistant', { text: 'Two agents overlap', delta: ' overlap' }),
      event(6, 'thinking', { text: 'Check remaining agents' }),
      event(7, 'assistant', { text: 'All complete' }),
    ];
    const originalData = inputs[0].data;
    for (const input of inputs) snapshot = update(snapshot, input, 'summary');
    const lanes = snapshot!.events.filter(input => input.stream !== 'usage');
    expect(lanes.map(input => [input.seq, input.stream, input.data.text, input.data.progressSegmentFirstSeq])).toEqual([
      [2, 'thinking', 'Compare results', 1],
      [5, 'assistant', 'Two agents overlap', 3],
      [6, 'thinking', 'Check remaining agents', 6],
      [7, 'assistant', 'All complete', 7],
    ]);
    expect(inputs[0].data.progressSegmentId).toBe(lanes[0].data.progressSegmentId);
    expect(lanes[0].ts).toBe(1002);
    expect(lanes[0].data.progressSegmentStartedAt).toBe(1001);
    expect(inputs[1].ts).toBe(1002);
    expect(inputs[1].data.progressSegmentStartedAt).toBe(1001);
    expect(inputs[4].data.progressSegmentId).toBe(lanes[1].data.progressSegmentId);
    expect(originalData).not.toHaveProperty('progressSegmentId');
  });

  test('does not coalesce across tools or lane switches and keeps authoritative replacements in one segment', () => {
    let snapshot: Snapshot | undefined;
    for (const input of [
      event(1, 'thinking', { text: 'A', itemId: 'same' }),
      event(2, 'tool', { phase: 'start', toolCallId: 'tool', name: 'sessions_spawn' }),
      event(3, 'thinking', { text: 'AB', itemId: 'same' }),
      event(4, 'assistant', { text: 'First' }),
      event(5, 'assistant', { text: 'Next', replace: true }),
    ]) snapshot = update(snapshot, input);
    expect(snapshot!.events.map(input => input.data.progressSegmentFirstSeq ?? input.stream)).toEqual([1, 'tool', 3, 4]);
    expect(snapshot!.events.at(-1)?.data.text).toBe('Next');
  });

  test('keeps live segment identity after an oversized snapshot and subsequent deltas', () => {
    let snapshot: Snapshot | undefined;
    const inputs = [
      event(1, 'assistant', { text: 'Start' }),
      event(2, 'assistant', { text: '字'.repeat(30000) }),
      event(3, 'assistant', { delta: 'more' }),
      event(4, 'assistant', { text: '字'.repeat(31000) }),
      event(5, 'assistant', { text: 'Short authoritative replacement', replace: true }),
    ];
    for (const input of inputs) {
      snapshot = update(snapshot, input);
      expect(input.data.progressSegmentFirstSeq).toBe(1);
      expect(input.data.progressSegmentId).toBe(inputs[0].data.progressSegmentId);
    }
    expect(snapshot!.events).toHaveLength(1);
    expect(snapshot!.events[0].data.text).toBe('Short authoritative replacement');
  });

  test('marks recovered segment text authoritative when a replacement shortens an existing prefix', () => {
    let snapshot = update(undefined, event(1, 'assistant', { text: 'Hello', itemId: 'message-1' }));
    snapshot = update(snapshot, event(2, 'assistant', { text: 'Hel', replace: true, itemId: 'message-1' }));
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0].data).toMatchObject({ text: 'Hel', replace: true, progressSegmentFirstSeq: 1 });
    snapshot = update(snapshot, event(3, 'assistant', { delta: 'p', itemId: 'message-1' }));
    expect(snapshot.events[0].data).toMatchObject({ text: 'Help', replace: true, progressSegmentFirstSeq: 1 });
  });

  test('suppresses silent replies, partial silent tokens, and runtime directives while retaining public commentary', () => {
    let snapshot: Snapshot | undefined;
    for (const input of [
      event(1, 'assistant', { delta: 'N' }),
      event(2, 'assistant', { delta: 'O_' }),
      event(3, 'assistant', { delta: 'REPLY' }),
    ]) snapshot = update(snapshot, input);
    expect(snapshot!.events).toEqual([]);
    snapshot = update(snapshot, event(4, 'assistant', { text: 'Public commentary', phase: 'commentary' }));
    snapshot = update(snapshot, event(5, 'assistant', { text: '[[reply_to_current]]Visible answer' }));
    expect(snapshot.events.map(input => input.data.text)).toEqual(['Public commentary', 'Visible answer']);
    expect(snapshot.events[0].data.phase).toBe('commentary');
    expect(JSON.stringify(snapshot.events)).not.toContain('NO_REPLY');
  });

  test('keeps bounds, retains usage, and rejects stale events without replacing text', () => {
    let snapshot: Snapshot | undefined;
    snapshot = update(snapshot, event(1, 'usage', { inputTokens: 7 }));
    for (let seq = 2; seq < 90; seq += 1) {
      snapshot = update(snapshot, event(seq, seq % 2 ? 'assistant' : 'thinking', { text: `${seq}:` + '字'.repeat(1500) }));
    }
    expect(snapshot.events.length).toBeLessThanOrEqual(50);
    expect(snapshot.byteLength).toBeLessThanOrEqual(131072);
    expect(snapshot.events.some(input => input.stream === 'usage')).toBe(true);
    const saved = JSON.stringify(snapshot);
    update(snapshot, event(2, 'thinking', { text: 'stale' }));
    expect(JSON.stringify(snapshot)).toBe(saved);
    snapshot = update(snapshot, event(90, 'assistant', { text: '字'.repeat(30000) }));
    expect(snapshot.byteLength).toBeLessThanOrEqual(131072);
    expect(snapshot.events.every(input => Buffer.byteLength(JSON.stringify(input)) <= 65536)).toBe(true);
  });

  test('evicts whole tool owners under text pressure', () => {
    let snapshot: Snapshot | undefined;
    snapshot = update(snapshot, event(1, 'tool', { phase: 'start', toolCallId: 'old', name: 'exec', args: { command: 'echo hi' } }));
    snapshot = update(snapshot, event(2, 'tool', { phase: 'result', toolCallId: 'old', result: 'done' }));
    for (let seq = 3; seq < 60; seq += 1) snapshot = update(snapshot, event(seq, seq % 2 ? 'assistant' : 'thinking', { text: String(seq) }));
    expect(snapshot.events.some(input => input.data.toolCallId === 'old')).toBe(false);
  });

  test('is exact-shape idempotent and verifies newly bundled output', () => {
    expect(patch.__testing.transformProducer(patched, runtimeFile!)).toBe(patched);
    expect(() => patch.__testing.transformProducer(patched.replace('progressBytes > 65536', 'progressBytes > 99999'), runtimeFile!)).toThrow(/partial/);
    expect(() => patch.__testing.transformProducer(patched.replace(patch.__testing.MARKER, 'JUSTDO_SEGMENTED_LIVE_PROGRESS_V2026_8_2'), runtimeFile!)).toThrow(/partial/);
    const bundled = buildSync({ stdin: { contents: patched, sourcefile: runtimeFile!, resolveDir: distRoot }, bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false }).outputFiles[0].text;
    expect(patch.__testing.transformProducer(bundled, 'gateway-bundle.mjs')).toBe(bundled);
  });
});

describe('native progress text visibility boundary', () => {
  const original = 'if (recordsInFlightProgress && !isAborted && !suppressHeartbeatToolEvents) chatRunState.recordProgressEvent(clientRunId, agentPayload, recordsEmbeddedProgress ? "summary" : "full");';
  test('accepts the current guard after bundling but rejects changed visibility semantics', () => {
    const transformed = patch.__testing.transformCaller(original, 'server-chat.js');
    const bundled = buildSync({ stdin: { contents: transformed }, bundle: true, platform: 'node', format: 'esm', write: false }).outputFiles[0].text;
    expect(patch.__testing.transformCaller(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    for (const changed of [
      bundled.replace('isControlUiVisible &&', 'isControlUiVisible ||'),
      bundled.replace('!shouldHideHeartbeatChatOutput', 'shouldHideHeartbeatChatOutput'),
      bundled.replace('isControlUiVisible', 'historicalVisibility'),
    ]) {
      expect(() => patch.__testing.transformCaller(changed, 'gateway-bundle.mjs')).toThrow(/partial/);
    }
  });
  test('retains visible announce text in summary mode and excludes hidden or heartbeat text', () => {
    const transformed = patch.__testing.transformCaller(original, 'server-chat.js');
    const run = (stream: string, visible: boolean, heartbeat: boolean): unknown[] => {
      const calls: unknown[] = [];
      vm.runInNewContext(transformed, {
        recordsInFlightProgress: true, isAborted: false, suppressHeartbeatToolEvents: false,
        evt: { stream, runId: 'run' }, isControlUiVisible: visible,
        shouldHideHeartbeatChatOutput: () => heartbeat, clientRunId: 'run', agentPayload: {},
        recordsEmbeddedProgress: true, chatRunState: { recordProgressEvent: (...args: unknown[]) => calls.push(args) },
      });
      return calls;
    };
    expect(run('thinking', true, false)).toHaveLength(1);
    expect(run('assistant', true, false)).toHaveLength(1);
    expect(run('thinking', false, false)).toHaveLength(0);
    expect(run('assistant', true, true)).toHaveLength(0);
    expect(run('tool', false, false)).toHaveLength(1);
    expect(patch.__testing.transformCaller(transformed, 'server-chat.js')).toBe(transformed);
  });
});
