import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

afterEach(() => {
  vi.useRealTimers();
});

function setupCompactionEvents(controller: ChatController, sessionKey: string) {
  let seq = 0;
  const handle = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  return (stream: string, data: Record<string, unknown>) =>
    handle({
      event: 'agent',
      payload: { sessionKey, runId: 'run-1', seq: ++seq, stream, data },
    });
}

test.each(['completed', 'failed', 'skipped', 'aborted'] as const)(
  'applies an automatic compaction %s received after switching away',
  async outcome => {
    vi.useFakeTimers();
    const controller = new ChatController();
    const sessionKey = 'agent:main:justdo:compacting';
    controller.state.sessionKey = sessionKey;
    const emit = setupCompactionEvents(controller, sessionKey);
    emit('lifecycle', { phase: 'start' });
    emit('compaction', { phase: 'start', itemId: 'compact-1' });
    expect(controller.state.compactionInFlight).toBe(true);

    await controller.switchSession('agent:main:justdo:other');
    emit('compaction', {
      phase: 'end',
      itemId: 'compact-1',
      completed: outcome === 'completed',
      outcome,
      reason: 'native reason',
    });

    expect(controller.state.compactionInFlight).toBe(false);
    expect(controller.state.chatMessages).toEqual([]);
    await controller.switchSession(sessionKey);
    expect(controller.state.compactionInFlight).toBe(false);
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({
        __openclaw: expect.objectContaining({ kind: 'compaction-status', phase: outcome }),
      }),
    ]);
    controller.disconnect();
  },
);

test('shows a compaction that began in the background immediately on returning to the session', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:compacting';
  controller.state.sessionKey = sessionKey;
  const emit = setupCompactionEvents(controller, sessionKey);
  emit('lifecycle', { phase: 'start' });
  await controller.switchSession('agent:main:justdo:other');

  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  expect(controller.state.chatMessages).toEqual([]);
  await controller.switchSession(sessionKey);

  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      __openclaw: expect.objectContaining({ kind: 'compaction-status', phase: 'in-progress' }),
    }),
  ]);
  emit('compaction', {
    phase: 'end',
    itemId: 'compact-1',
    completed: false,
    outcome: 'failed',
  });
  expect(controller.state.compactionInFlight).toBe(false);
  controller.disconnect();
});

test('drops unconfirmed background progress on transport loss and restores it from fresh events', async () => {
  vi.useFakeTimers();
  const controller = new ChatController();
  const sessionKey = 'agent:main:justdo:compacting';
  controller.state.sessionKey = sessionKey;
  const emit = setupCompactionEvents(controller, sessionKey);
  emit('lifecycle', { phase: 'start' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  await controller.switchSession('agent:main:justdo:other');
  (controller as unknown as { handleClose(): void }).handleClose();
  await controller.switchSession(sessionKey);
  expect(controller.state.compactionInFlight).toBe(false);
  expect(controller.state.chatMessages).toEqual([]);

  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  expect(controller.state.compactionInFlight).toBe(true);
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({ __openclaw: expect.objectContaining({ phase: 'in-progress' }) }),
  ]);
  controller.disconnect();
});
