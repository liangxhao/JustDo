import { afterEach, expect, test, vi } from 'vitest';

import { isLocallyOptimisticHistoryTail } from '../../model/history/optimistic-history-tail';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { ChatController } from '../chat-controller';
import { extractSnapshotText } from '../chat-controller-support';

const sessionKey = 'agent:main:final-history-handoff';
const sessionId = 'physical-final-history-handoff';
const runId = 'run-final-history-handoff';
const controllers: ChatController[] = [];

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.disconnect());
  vi.useRealTimers();
});

function setup() {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = sessionId;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = sessionId;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  let seq = 0;
  const emit = (stream: string, data: Record<string, unknown>) => internal.handleEvent({
    event: 'agent',
    payload: { sessionKey, sessionId, runId, seq: ++seq, stream, data },
  });
  emit('lifecycle', { phase: 'start' });
  for (const text of ['A', 'B', 'C', 'D', 'E']) {
    emit('thinking', { text: `Reasoning ${text}` });
    emit('item', {
      kind: 'preamble', phase: 'end', itemId: `commentary-${text}`, progressText: text,
      assistantTextScope: { id: `message-${text}`, commentaryItemIds: [`commentary-${text}`] },
    });
    emit('tool', { phase: 'start', toolCallId: `tool-${text}`, name: 'read' });
    emit('tool', { phase: 'result', toolCallId: `tool-${text}`, name: 'read', result: 'ok' });
  }
  emit('assistant', {
    itemId: 'final-answer', text: 'F', replace: true,
    assistantTextScope: { id: 'final-message', commentaryItemIds: [] },
  });
  const durable = {
    role: 'assistant', content: [{ type: 'text', text: 'F' }], stopReason: 'stop',
    openclawDelivery: { messageScopeId: 'final-message' },
    __openclaw: { id: 'durable-final', seq: 1, runId },
  };
  const publishDurable = () => internal.handleEvent({
    event: 'session.message',
    payload: { sessionKey, sessionId, runId, hasActiveRun: true, messageSeq: 1, message: durable },
  });
  const finish = (text: string) => internal.handleEvent({
    event: 'chat',
    payload: { sessionKey, sessionId, runId, state: 'final', message: {
      role: 'assistant', content: [{ type: 'text', text }],
    } },
  });
  return { controller, durable, publishDurable, finish };
}

test.each([false, true])(
  'keeps a durable final when a later Chat completion contains all process text (background=%s)',
  async background => {
    const { controller, durable, publishDurable, finish } = setup();
    publishDurable();
    expect(controller.state.chatMessages).toEqual([durable]);
    if (background) await controller.switchSession('agent:main:other-handoff-session');

    finish('ABCDEF');

    if (background) await controller.switchSession(sessionKey);
    expect(controller.state.chatMessages).toEqual([durable]);
    expect(controller.state.chatMessages.some(isLocallyOptimisticHistoryTail)).toBe(false);
    const visible = projectTurnItems(controller.state.transcript.activeTurn)
      .flatMap(item => item.kind === 'content' ? [item.item.text] : []);
    expect(visible.some(text => text === 'ABCDEF')).toBe(false);
    expect(extractSnapshotText(controller.state.chatMessages[controller.state.chatMessages.length - 1])).toBe('F');

    controller.state.client = {
      request: vi.fn().mockResolvedValue({ messages: [durable] }), stop: vi.fn(),
    } as never;
    controller.state.connected = true;
    await controller.loadHistory(true);
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(extractSnapshotText(controller.state.chatMessages[controller.state.chatMessages.length - 1])).toBe('F');
  },
);

test('still displays a final when its durable message has not arrived', () => {
  const { controller, finish } = setup();
  finish('F');
  expect(extractSnapshotText(controller.state.chatMessages[controller.state.chatMessages.length - 1])).toBe('F');
  expect(controller.state.chatMessages.some(isLocallyOptimisticHistoryTail)).toBe(true);
});

test('automatically reads the full history before retiring the live process timeline', async () => {
  vi.useFakeTimers();
  const { controller, durable, publishDurable, finish } = setup();
  const request = vi.fn().mockResolvedValue({ messages: [durable] });
  controller.state.client = { request, stop: vi.fn() } as never;
  controller.state.connected = true;
  publishDurable();
  finish('ABCDEF');
  expect(controller.state.transcript.activeTurn?.status).toBe('final');
  expect((controller as unknown as { postFinalHistoryRecovery: unknown }).postFinalHistoryRecovery)
    .not.toBeNull();

  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state.transcript.activeTurn?.status).toBe('final');

  await vi.advanceTimersByTimeAsync(150);

  expect(request).toHaveBeenCalledWith('chat.history', expect.anything(), expect.anything());
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatMessages).toEqual([durable]);
});
