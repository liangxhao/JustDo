import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

const sessionKey = 'agent:main:justdo:native-recovery';
const runId = 'run-native-recovery';
const controllers: ChatController[] = [];

type ProgressEvent = {
  runId: string;
  seq: number;
  stream: string;
  data: Record<string, unknown>;
};

function setup() {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  const internal = controller as unknown as {
    suspendedRunId: string | null;
    handleEvent(event: { event: string; payload: unknown }): void;
    applyInFlightRunSnapshot(
      snapshot: unknown,
      key: string,
      id: null,
      requestRunId: string | null,
      info: unknown,
    ): void;
  };
  const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
    internal.handleEvent({ event: 'agent', payload: { runId, seq, stream, data, sessionKey } });
  const snapshot = (text: string, events: ProgressEvent[] = []) =>
    internal.applyInFlightRunSnapshot(
      { runId, text, events },
      sessionKey,
      null,
      controller.state.chatRunId,
      { hasActiveRun: true, activeRunIds: [runId] },
    );
  const contents = () =>
    controller.state.transcript.activeTurn?.items
      .filter(item => item.type === 'content')
      .map(item => item.text);
  return { controller, internal, emit, snapshot, contents };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

test('restores a native text-only snapshot and continues native assistant updates', () => {
  const { controller, snapshot, emit, contents } = setup();
  snapshot('Hello');
  expect(contents()).toEqual(['Hello']);
  expect(controller.state.runActivity?.stage).toBe('responding');
  expect(controller.state.transcript.activeTurn?.lastAgentSeq).toBe(-1);
  emit(1, 'assistant', { text: 'Hello again' });
  expect(contents()).toEqual(['Hello again']);
});

test('uses the native buffer when the retained assistant event is only a sequence marker', () => {
  const { snapshot, contents } = setup();
  snapshot('Complete buffer', [{ runId, seq: 8, stream: 'assistant', data: {} }]);
  expect(contents()).toEqual(['Complete buffer']);
});

test('does not regress newer live content or clear it for a budget-omitted native buffer', () => {
  const { internal, emit, snapshot, contents } = setup();
  emit(1, 'assistant', { text: 'Hello' });
  internal.suspendedRunId = runId;
  snapshot('Hello again');
  expect(contents()).toEqual(['Hello again']);
  emit(3, 'assistant', { text: 'Hello again today' });
  snapshot('Hello');
  snapshot('');
  expect(contents()).toEqual(['Hello again today']);
});

test('does not revive retracted live content from an unversioned buffer', () => {
  const { controller, internal, emit, snapshot, contents } = setup();
  emit(1, 'assistant', { text: 'obsolete' });
  internal.handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId,
      state: 'delta',
      replace: true,
      seq: 2,
      message: { role: 'assistant', content: '' },
    },
  });
  expect(controller.state.transcript.activeTurn?.assistantSuppressionSeq).toBeDefined();
  snapshot('obsolete');
  expect(contents()).toEqual(['']);
});

test('does not undo an authoritative empty native Agent replacement', () => {
  const { emit, snapshot, contents } = setup();
  emit(1, 'assistant', { text: 'obsolete' });
  emit(2, 'assistant', { text: '', replace: true });
  snapshot('obsolete');
  expect(contents()).toEqual(['']);
});

test('removes already persisted same-run content from the native cumulative buffer', () => {
  const { controller, snapshot, contents } = setup();
  controller.state.transcript.persistedMessages = [
    {
      role: 'assistant',
      content: 'First answer.',
      __openclaw: { id: 'm1', runId },
    },
  ];
  snapshot('First answer.Second answer.');
  expect(contents()).toEqual(['Second answer.']);
  snapshot('First answer.Second answer.');
  expect(contents()).toEqual(['Second answer.']);
});

test('does not duplicate completed live content across a native Tool boundary', () => {
  const { internal, emit, snapshot, contents, controller } = setup();
  emit(1, 'assistant', { text: 'Before tool.' });
  emit(2, 'tool', { toolCallId: 'read-1', name: 'read', phase: 'start' });
  internal.suspendedRunId = runId;
  snapshot('Before tool.After tool.');
  expect(contents()).toEqual(['Before tool.', 'After tool.']);
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'content',
    'tool',
    'content',
  ]);
});

test.each([
  { persisted: ['Repeat.'], completed: ['Repeat.'], buffer: 'Repeat.Repeat.', reply: 'Repeat.' },
  {
    persisted: ['Earlier.', 'First.'],
    completed: ['First.'],
    buffer: 'Earlier.First.Next.',
    reply: 'Next.',
  },
  { persisted: ['Earlier.'], completed: ['First.'], buffer: 'Earlier.First.Next.', reply: 'Next.' },
  {
    persisted: ['First.'],
    completed: ['First.', 'Second.'],
    buffer: 'First.Second.Next.',
    reply: 'Next.',
  },
])(
  'consumes persisted/live overlap once across Tools: %j',
  ({ persisted, completed, buffer, reply }) => {
    const { internal, emit, snapshot, contents, controller } = setup();
    completed.forEach((text, index) => {
      emit(index * 2 + 1, 'assistant', { text });
      emit(index * 2 + 2, 'tool', { toolCallId: `read-${index}`, name: 'read', phase: 'start' });
    });
    controller.state.transcript.persistedMessages = persisted.map((content, index) => ({
      role: 'assistant',
      content,
      __openclaw: { id: `persisted-${index}`, runId },
    }));
    internal.suspendedRunId = runId;

    snapshot(buffer);
    snapshot(buffer);

    expect(contents()).toEqual([...completed, reply]);
  },
);

test('restores native typed Tool progress without any custom segment metadata', () => {
  const { controller, snapshot } = setup();
  snapshot('', [
    { runId, seq: 1, stream: 'tool', data: { toolCallId: 'read-1', name: 'read', phase: 'start' } },
    {
      runId,
      seq: 2,
      stream: 'item',
      data: {
        kind: 'tool',
        phase: 'update',
        itemId: 'tool:read-1',
        toolCallId: 'read-1',
        progressText: 'Reading 50%',
      },
    },
  ]);
  expect(controller.state.transcript.activeTurn?.toolById.get('read-1')).toMatchObject({
    status: 'running',
    progressText: 'Reading 50%',
  });
});

test('replays native Preamble owners while admitting earlier queued Thinking', () => {
  const { controller, emit, snapshot, contents } = setup();
  snapshot('', [
    {
      runId,
      seq: 3,
      stream: 'item',
      data: {
        kind: 'preamble',
        itemId: 'commentary-1',
        phase: 'end',
        progressText: 'Waiting for agents',
      },
    },
  ]);
  emit(1, 'thinking', { text: 'The tasks are ready' });
  emit(2, 'item', {
    kind: 'preamble',
    itemId: 'commentary-1',
    phase: 'update',
    progressText: 'Waiting',
  });
  expect(contents()).toEqual(['Waiting for agents']);
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'content',
  ]);
});
