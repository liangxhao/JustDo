import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

const sessionKey = 'agent:main:justdo:segment-recovery';
const runId = 'run-segment-recovery';
const controllers: ChatController[] = [];

type ProgressEvent = {
  runId: string;
  seq: number;
  stream: string;
  data: Record<string, unknown>;
};

function textEvent(seq: number, stream: 'thinking' | 'assistant', text: string, firstSeq = seq) {
  return { runId, seq, stream, data: { text, progressSegmentFirstSeq: firstSeq } };
}

function setup() {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
    handleClose(): void;
    reconcileSuspendedRun(): Promise<void>;
    applyInFlightRunSnapshot(
      snapshot: Record<string, unknown>,
      key: string,
      sessionId: string | null,
      requestRunId: string | null,
      sessionInfo: Record<string, unknown>,
    ): void;
  };
  const emit = (event: ProgressEvent) =>
    internal.handleEvent({ event: 'agent', payload: { ...event, sessionKey } });
  const snapshot = (events: ProgressEvent[], text = '') =>
    internal.applyInFlightRunSnapshot(
      { runId, events, text },
      sessionKey,
      null,
      controller.state.chatRunId,
      { hasActiveRun: true, activeRunIds: [runId] },
    );
  const items = () =>
    controller.state.transcript.activeTurn?.items.map(item => [
      item.type,
      'text' in item ? item.text : item.type === 'tool' ? item.toolCallId : null,
    ]);
  return { controller, internal, emit, snapshot, items };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

function preambleEvent(seq: number, text: string, phase = 'update', firstSeq = seq) {
  return {
    runId,
    seq,
    stream: 'item',
    data: {
      kind: 'preamble',
      itemId: 'commentary-1',
      progressText: text,
      phase,
      progressSegmentFirstSeq: firstSeq,
    },
  };
}

test('publishes native commentary before tool execution without waiting for history or run end', () => {
  const { controller, emit, items } = setup();
  const frames: unknown[] = [];
  controller.onStream(() => frames.push(items()));
  emit(textEvent(1, 'thinking', 'Preparing the tasks'));
  emit(preambleEvent(2, 'Starting five agents'));
  expect(frames[frames.length - 1]).toEqual([
    ['thinking', 'Preparing the tasks'],
    ['content', 'Starting five agents'],
  ]);
  emit(preambleEvent(3, 'Starting five agents now', 'end', 2));
  emit({
    runId,
    seq: 4,
    stream: 'tool',
    data: {
      phase: 'start',
      toolCallId: 'spawn-1',
      name: 'sessions_spawn',
      args: { task: 'Say hello' },
    },
  });
  expect(items()).toEqual([
    ['thinking', 'Preparing the tasks'],
    ['content', 'Starting five agents now'],
    ['tool', 'spawn-1'],
  ]);
  expect(controller.state.chatSending).toBe(true);
});

test('replays native commentary snapshots while admitting earlier queued Thinking', () => {
  const { emit, snapshot, items } = setup();
  snapshot([preambleEvent(3, 'Waiting for five agents', 'end', 2)]);
  emit(textEvent(1, 'thinking', 'The tasks are ready'));
  emit(preambleEvent(2, 'Waiting', 'update', 2));
  expect(items()).toEqual([
    ['thinking', 'The tasks are ready'],
    ['content', 'Waiting for five agents'],
  ]);
});

test('restores an unfinished message from segmented history after transport reconnect', async () => {
  const { controller, internal, emit, items } = setup();
  const request = vi.fn(async (method: string) => {
    if (method === 'sessions.list') return { sessions: [{ key: sessionKey, hasActiveRun: true }] };
    return {
      messages: [{ role: 'user', content: 'Say hello' }],
      sessionInfo: { hasActiveRun: true, activeRunIds: [runId] },
      inFlightRun: { runId, text: 'Hello', events: [textEvent(3, 'assistant', 'Hello', 1)] },
    };
  });
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.connected = true;
  emit(textEvent(1, 'assistant', 'Hel'));
  internal.handleClose();
  controller.state.connected = true;

  await internal.reconcileSuspendedRun();

  expect(request).toHaveBeenCalledWith('chat.startup', expect.anything());
  expect(items()).toEqual([['content', 'Hello']]);
  expect(controller.state.chatSending).toBe(true);
  emit(textEvent(4, 'assistant', 'Hello again', 1));
  expect(items()).toEqual([['content', 'Hello again']]);
});

test('retains both recovered message segments when live output resumes on the second', () => {
  const { emit, snapshot, items } = setup();
  snapshot(
    [textEvent(2, 'assistant', 'First answer.', 1), textEvent(4, 'assistant', 'Second answer.', 3)],
    'First answer.Second answer.',
  );

  emit(textEvent(5, 'assistant', 'Second answer. More', 3));

  expect(items()).toEqual([
    ['content', 'First answer.'],
    ['content', 'Second answer. More'],
  ]);
});

test('does not inject aggregate content into a Thinking-only recovery snapshot', () => {
  const { snapshot, items } = setup();

  snapshot(
    [textEvent(8, 'thinking', 'Assess the returned results.', 6)],
    'Unowned aggregate reply',
  );

  expect(items()).toEqual([['thinking', 'Assess the returned results.']]);
});

test('inserts queued Thinking and Content before a Tool recovered ahead of the live stream', () => {
  const { controller, emit, snapshot, items } = setup();
  emit(textEvent(76, 'assistant', 'Agents dispatched.'));
  snapshot([
    {
      runId,
      seq: 80,
      stream: 'tool',
      data: { phase: 'start', toolCallId: 'tool-80', name: 'sessions_yield', args: {} },
    },
  ]);
  expect(controller.state.transcript.activeTurn?.lastAgentSeq).toBe(76);

  emit(textEvent(78, 'thinking', 'Review the results.'));
  emit(textEvent(79, 'assistant', 'Two agents returned the same blessing.'));

  expect(items()).toEqual([
    ['content', 'Agents dispatched.'],
    ['thinking', 'Review the results.'],
    ['content', 'Two agents returned the same blessing.'],
    ['tool', 'tool-80'],
  ]);
});

test('duplicate and older segment snapshots never replace a newer live message', () => {
  const { emit, snapshot, items } = setup();
  emit(textEvent(1, 'assistant', 'Hel'));
  snapshot([textEvent(3, 'assistant', 'Hello', 1)]);
  snapshot([textEvent(3, 'assistant', 'Hello', 1)]);
  emit(textEvent(5, 'assistant', 'Hello again', 1));

  snapshot([textEvent(2, 'assistant', 'Hell', 1)]);
  snapshot([textEvent(3, 'assistant', 'Hello', 1)]);

  expect(items()).toEqual([['content', 'Hello again']]);
});

test('applies an authoritative shorter prefix from a newer snapshot of the same owner', () => {
  const { emit, snapshot, items } = setup();
  emit(textEvent(1, 'assistant', 'Hello'));
  const correction = textEvent(3, 'assistant', 'Hel', 1);

  snapshot([{ ...correction, data: { ...correction.data, replace: true } }]);

  expect(items()).toEqual([['content', 'Hel']]);
  emit(textEvent(2, 'assistant', 'Hello again', 1));
  expect(items()).toEqual([['content', 'Hel']]);
});
