import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

afterEach(() => {
  vi.useRealTimers();
});

function setupCompaction() {
  vi.useFakeTimers();
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:compaction-history';
  controller.state.sessionKey = sessionKey;
  const internals = controller as unknown as {
    handleCompactionPhase(phase: string, sessionKey: string, data: Record<string, unknown>): void;
    projectLocalCompactionStatus(sessionKey: string, messages: unknown[]): unknown[];
  };
  const emit = (phase: string, itemId: string, data: Record<string, unknown> = {}) =>
    internals.handleCompactionPhase(phase, sessionKey, {
      itemId,
      ...(phase === 'end' ? { completed: true, outcome: 'completed' } : {}),
      ...data,
    });
  const project = (messages: unknown[]) =>
    internals.projectLocalCompactionStatus(sessionKey, messages);
  return { controller, emit, project };
}

test('does not replace a new compaction with a delayed marker from the previous item', () => {
  const { controller, emit, project } = setupCompaction();
  emit('start', 'first-item');
  emit('end', 'first-item');
  emit('start', 'second-item');
  const previousMarker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'first-entry', itemId: 'first-item' },
  };

  expect(project([previousMarker])).toEqual([
    previousMarker,
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction-status', phase: 'in-progress' }),
    }),
  ]);
  emit('end', 'first-item');
  expect(controller.state.compactionInFlight).toBe(true);
  emit('end', 'second-item');
  expect(project([previousMarker])).toEqual([
    previousMarker,
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction-status', phase: 'completed' }),
    }),
  ]);
});

test('replaces a completed compaction using the matching item id rather than the entry id', () => {
  const { emit, project } = setupCompaction();
  emit('start', 'current-item');
  emit('end', 'current-item');
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'distinct-entry', itemId: 'current-item' },
  };

  expect(project([marker])).toEqual([marker]);
  expect(project([])).toEqual([]);
});

test('does not infer an item identity from an unrelated transcript entry id', () => {
  const { emit, project } = setupCompaction();
  emit('start', 'current-item');
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'current-item' },
  };

  expect(project([marker])).toHaveLength(2);
});

test('keeps operation identity after an early marker without redisplaying the local card', () => {
  const { controller, emit, project } = setupCompaction();
  emit('start', 'first-item');
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'first-entry', itemId: 'first-item' },
  };
  controller.state.chatMessages = project([marker]);
  expect(controller.state.chatMessages).toEqual([marker]);
  expect(project([marker])).toEqual([marker]);
  // A duplicate start after the commit must reuse the hidden operation.
  emit('start', 'first-item');
  expect(controller.state.chatMessages).toEqual([marker]);
  expect(controller.state.compactionInFlight).toBe(true);

  emit('start', 'second-item');
  emit('end', 'first-item');
  expect(controller.state.compactionInFlight).toBe(true);
  expect(project([marker])).toEqual([
    marker,
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction-status', phase: 'in-progress' }),
    }),
  ]);
});

test('releases an early committed operation when its successful end arrives', () => {
  const { controller, emit, project } = setupCompaction();
  emit('start', 'current-item');
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'current-entry', itemId: 'current-item' },
  };
  controller.state.chatMessages = project([marker]);
  emit('end', 'current-item');

  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([marker]);
  expect(project([])).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test('preserves a failure diagnostic when an extension fails after the transcript commit', () => {
  const { controller, emit, project } = setupCompaction();
  emit('start', 'current-item');
  const marker = {
    role: 'system',
    __openclaw: { kind: 'compaction', id: 'current-entry', itemId: 'current-item' },
  };
  controller.state.chatMessages = project([marker]);
  emit('end', 'current-item', {
    completed: false,
    outcome: 'failed',
    reason: 'extension failed after commit',
  });

  const expected = [
    marker,
    expect.objectContaining({
      __openclaw: expect.objectContaining({
        kind: 'compaction-status',
        phase: 'failed',
        reason: 'extension failed after commit',
      }),
    }),
  ];
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual(expected);
  expect(project([marker])).toEqual(expected);
});
