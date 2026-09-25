import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:justdo:transport-order';
const runId = 'run-transport-order';

function setup() {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  const emit = (
    deliveryEvent: 'agent' | 'session.tool',
    seq: number,
    stream: string,
    data: Record<string, unknown>,
  ) =>
    internal.handleEvent({
      event: deliveryEvent,
      payload: { sessionKey, runId, seq, ts: 100 + seq, stream, data },
    });
  return { controller, emit };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
});

test('publishes an empty assistant replacement immediately', () => {
  const { controller, emit } = setup();
  const notify = vi.spyOn(
    controller as never as { notifyStream(kind?: string): void },
    'notifyStream',
  );
  emit('agent', 1, 'assistant', { text: 'obsolete', progressSegmentFirstSeq: 1 });
  notify.mockClear();
  emit('agent', 2, 'assistant', { text: '', replace: true, progressSegmentFirstSeq: 1 });
  expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({ text: '' });
  expect(notify).toHaveBeenCalledWith('terminal');
});

test.each([false, true])(
  'honors native chat suppression after assistant snapshots (background: %s)',
  async background => {
    const { controller, emit } = setup();
    emit('agent', 1, 'assistant', { text: 'obsolete', progressSegmentFirstSeq: 1 });
    if (background) await controller.switchSession('agent:main:justdo:other');
    const retract = (seq: number) =>
      (
        controller as unknown as {
          handleEvent(event: { event: string; payload: unknown }): void;
        }
      ).handleEvent({
        event: 'chat',
        payload: {
          sessionKey,
          runId,
          seq,
          state: 'delta',
          deltaText: '',
          replace: true,
          message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
        },
      });
    retract(2);
    if (background) await controller.switchSession(sessionKey);
    expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({ text: '' });
    emit('agent', 2, 'assistant', { text: 'delayed obsolete', progressSegmentFirstSeq: 1 });
    expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({ text: '' });
    emit('agent', 3, 'assistant', { text: 'new answer', progressSegmentFirstSeq: 1 });
    retract(2);
    expect(controller.state.transcript.activeTurn?.items[0]).toMatchObject({ text: 'new answer' });
  },
);

test.each([false, true])(
  'retracts content behind a newer tool (background: %s)',
  async background => {
    const { controller, emit } = setup();
    emit('agent', 1, 'assistant', { text: 'obsolete', progressSegmentFirstSeq: 1 });
    emit('session.tool', 3, 'tool', { phase: 'start', name: 'read', toolCallId: 'tool-1' });
    if (background) await controller.switchSession('agent:main:justdo:other');
    (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        runId,
        seq: 2,
        state: 'delta',
        replace: true,
        deltaText: '',
        message: { content: '' },
      },
    });
    emit('agent', 2, 'assistant', { text: 'late obsolete', progressSegmentFirstSeq: 1 });
    if (background) await controller.switchSession(sessionKey);
    expect(controller.state.transcript.activeTurn?.items).toMatchObject([
      { type: 'content', text: '' },
      { type: 'tool', status: 'running' },
    ]);
    emit('agent', 4, 'assistant', { text: 'new answer', progressSegmentFirstSeq: 4 });
    const items = controller.state.transcript.activeTurn!.items;
    expect(items[items.length - 1]).toMatchObject({
      text: 'new answer',
    });
  },
);

test('renders typed tool progress without history polling and lets the result replace it', () => {
  const { controller, emit } = setup();
  const reload = vi.spyOn(
    controller as never as {
      scheduleDeferredHistoryReload(sessionKey: string, reason: string): void;
    },
    'scheduleDeferredHistoryReload',
  );
  emit('agent', 1, 'tool', { name: 'read', phase: 'start', toolCallId: 'tool-1' });
  reload.mockClear();
  emit('agent', 3, 'usage', { inputTokens: 20 });
  emit('agent', 2, 'item', {
    kind: 'tool',
    phase: 'update',
    itemId: 'tool:tool-1',
    toolCallId: 'tool-1',
    progressText: 'Reading 50%',
  });
  const tool = controller.state.transcript.activeTurn!.toolById.get('tool-1')!;
  expect(tool).toMatchObject({ status: 'running', progressText: 'Reading 50%' });
  expect(tool.output).toBeUndefined();
  expect(reload).not.toHaveBeenCalled();
  emit('session.tool', 4, 'tool', {
    phase: 'result',
    toolCallId: 'tool-1',
    result: 'complete file',
  });
  expect(tool).toMatchObject({ status: 'completed', output: 'complete file' });
  expect(tool.progressText).toBeUndefined();
  emit('agent', 5, 'item', {
    kind: 'tool',
    phase: 'update',
    itemId: 'tool:tool-1',
    toolCallId: 'tool-1',
    progressText: 'late progress',
  });
  expect(tool.progressText).toBeUndefined();
  expect(tool.output).toBe('complete file');
});

test('renders earlier Thinking and native commentary after a session.tool delivery overtakes them', () => {
  const { controller, emit } = setup();
  emit('agent', 1, 'assistant', { text: 'Starting', progressSegmentFirstSeq: 1 });
  emit('session.tool', 20, 'tool', {
    name: 'sessions_spawn',
    phase: 'start',
    toolCallId: 'tool-1',
    args: {},
  });

  emit('agent', 18, 'thinking', { text: 'Check task naming', progressSegmentFirstSeq: 18 });
  emit('agent', 19, 'item', {
    kind: 'preamble',
    itemId: 'commentary-1',
    phase: 'end',
    progressText: 'taskName must use lowercase letters.',
    progressSegmentFirstSeq: 19,
  });

  expect(
    controller.state.transcript.activeTurn?.items.map(item => [
      item.type,
      'text' in item ? item.text : item.type === 'tool' ? item.toolCallId : null,
    ]),
  ).toEqual([
    ['content', 'Starting'],
    ['thinking', 'Check task naming'],
    ['content', 'taskName must use lowercase letters.'],
    ['tool', 'tool-1'],
  ]);
});

test('does not let a newer usage event hide earlier commentary from another paced delivery', () => {
  const { controller, emit } = setup();
  emit('agent', 1, 'assistant', { text: 'Starting', progressSegmentFirstSeq: 1 });
  emit('agent', 20, 'usage', { inputTokens: 20 });

  emit('agent', 19, 'item', {
    kind: 'preamble',
    itemId: 'commentary-1',
    phase: 'end',
    progressText: 'taskName must use lowercase letters.',
    progressSegmentFirstSeq: 19,
  });

  expect(
    controller.state.transcript.activeTurn?.items
      .filter(item => item.type === 'content')
      .map(item => item.text),
  ).toEqual(['Starting', 'taskName must use lowercase letters.']);
});

test('backfills background progress without changing the selected session', async () => {
  const { controller, emit } = setup();
  emit('agent', 1, 'lifecycle', { phase: 'start' });
  await controller.switchSession('agent:main:justdo:other');
  emit('session.tool', 20, 'tool', { name: 'read', phase: 'start', toolCallId: 'tool-1' });
  emit('agent', 18, 'thinking', { text: 'Earlier reasoning', progressSegmentFirstSeq: 18 });
  expect(controller.state.transcript.activeTurn).toBeNull();
  await controller.switchSession(sessionKey);
  expect(controller.state.transcript.activeTurn?.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  expect(controller.state.transcript.activeTurn?.lastAgentSeq).toBe(20);
});

test('does not roll back a newer snapshot of the same progress owner or accept unidentified stale text', () => {
  const { controller, emit } = setup();
  emit('agent', 1, 'lifecycle', { phase: 'start' });
  emit('agent', 20, 'usage', {});
  emit('agent', 19, 'thinking', { text: 'Full reasoning', progressSegmentFirstSeq: 17 });
  const turn = controller.state.transcript.activeTurn!;
  expect(turn.items.map(item => ('text' in item ? item.text : null))).toEqual(['Full reasoning']);
  emit('agent', 18, 'thinking', { text: 'Full', progressSegmentFirstSeq: 17, replace: true });
  emit('agent', 16, 'thinking', { text: 'Unidentified old text' });
  emit('agent', 15, 'thinking', { text: 'Invalid owner', progressSegmentFirstSeq: 99 });
  expect(turn.items.map(item => ('text' in item ? item.text : null))).toEqual(['Full reasoning']);
  expect(turn.lastAgentSeq).toBe(20);
});

test('does not revive a terminal run with delayed identified progress', () => {
  const { controller, emit } = setup();
  emit('agent', 1, 'lifecycle', { phase: 'start' });
  emit('agent', 20, 'lifecycle', { phase: 'error', error: 'Stopped' });
  const before = controller.state.transcript.activeTurn?.items.slice();
  emit('agent', 18, 'thinking', { text: 'Earlier reasoning', progressSegmentFirstSeq: 18 });
  expect(controller.state.transcript.activeTurn?.items).toEqual(before);
  expect(controller.state.chatSending).toBe(false);
});
