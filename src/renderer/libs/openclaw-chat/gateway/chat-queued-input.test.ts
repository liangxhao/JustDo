import { afterEach, describe, expect, test, vi } from 'vitest';

import { projectPersistedMessagesForActiveTurn } from '../model/optimistic-history-tail';
import { projectTurnItems } from '../model/project-turn-items';
import type { GatewayMessage } from '../types';
import { ChatController } from './chat-controller';
import {
  queuedInputDetail,
  queuedInputSnapshot,
  refreshNativePendingInputs,
} from './chat-pending-inputs';

const sessionKey = 'agent:main:justdo:one';
const controllers: ChatController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
});

function fixture() {
  const request = vi.fn().mockResolvedValue({ status: 'started' });
  const controller = new ChatController();
  controllers.push(controller);
  Object.assign(controller.state, {
    client: { request, stop: vi.fn() },
    connected: true,
    sessionKey,
    currentSessionId: 'native-one',
    chatSending: true,
    chatRunId: 'justdo-active',
    initialHistoryReady: true,
  });
  const refresh = vi.spyOn(controller, 'loadHistory').mockResolvedValue(true);
  const event = (event: string, payload: unknown) =>
    (
      controller as unknown as { handleEvent(frame: { event: string; payload: unknown }): void }
    ).handleEvent({ event, payload });
  return { controller, request, refresh, event };
}

describe('native queued input', () => {
  test.each(['before-start', 'during-response'])(
    'shows a consumed queued user immediately %s without replacing live output',
    async timing => {
      const { controller, request, event, refresh } = fixture();
      const admissionId = 'justdo-queue-next';
      request.mockResolvedValueOnce({ inputReceipts: [{ runId: admissionId, state: 'pending' }] });
      await refreshNativePendingInputs(
        controller.state,
        {
          pendingInputs: {
            total: 1,
            items: [
              {
                id: 'input-next',
                runId: admissionId,
                state: 'queued', queued: true,
                acceptedAt: 1,
                message: { role: 'user', content: 'next prompt' },
              },
            ],
          },
        },
        vi.fn(),
        vi.fn(),
      );
      expect(queuedInputSnapshot(controller.state, []).items).toHaveLength(1);
      event('agent', {
        sessionKey,
        runId: timing === 'before-start' ? 'justdo-active' : 'native-followup',
        seq: 1,
        stream: 'lifecycle',
        data: { phase: 'start' },
      });
      event('agent', {
        sessionKey,
        runId: timing === 'before-start' ? 'justdo-active' : 'native-followup',
        seq: 2,
        stream: 'assistant',
        data: { text: 'streaming reply' },
      });
      const activeTurn = controller.state.transcript.activeTurn;
      const liveItems = projectTurnItems(activeTurn!);
      expect(liveItems.length).toBeGreaterThan(0);
      const activeRunId = controller.state.chatRunId;
      const append = {
        sessionKey,
        sessionId: 'native-one',
        messageId: 'durable-user',
        messageSeq: 1,
        runActive: true,
        message: {
          role: 'user',
          content: 'next prompt',
          __openclaw: {
            id: 'durable-user',
            seq: 1,
            idempotencyKey: `${admissionId}:user`,
          },
        },
      };
      // Persistence can race execution-start delivery and retain the old run.
      event('session.message', { ...append, sessionId: 'another-physical-session' });
      expect(controller.state.chatMessages).toEqual([]);
      event('session.message', { ...append, sessionKey: 'another-session' });
      expect(controller.state.chatMessages).toEqual([]);
      event('session.message', append);
      event('session.message', append);
      expect(controller.state.chatMessages).toHaveLength(1);
      expect(
        projectPersistedMessagesForActiveTurn(controller.state.chatMessages, activeTurn),
      ).toEqual([expect.objectContaining({ role: 'user', content: 'next prompt' })]);
      expect(
        queuedInputSnapshot(controller.state, controller.state.chatMessages as GatewayMessage[])
          .items,
      ).toEqual([]);
      expect(controller.state.transcript.activeTurn).toBe(activeTurn);
      expect(projectTurnItems(activeTurn!)).toEqual(liveItems);
      expect(controller.state.chatRunId).toBe(activeRunId);
      expect(controller.state.chatSending).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
    },
  );
  test('reads full queued details from scoped native custody and rejects another session', async () => {
    const { controller, request } = fixture();
    const text = `${'Long text '.repeat(40)}\nNext line`;
    request.mockResolvedValueOnce({ inputReceipts: [{ runId: 'queued', state: 'pending' }] });
    await refreshNativePendingInputs(
      controller.state,
      {
        pendingInputs: {
          total: 1,
          items: [
            {
              id: 'input',
              runId: 'queued',
              state: 'queued', queued: true,
              acceptedAt: 1,
              message: {
                role: 'user',
                content: text,
                __openclaw: {
                  media: [
                    { path: '/tmp/spec.pdf', fileName: 'spec.pdf', contentType: 'application/pdf' },
                  ],
                },
              },
            },
          ],
        },
      },
      vi.fn(),
      vi.fn(),
    );
    expect(queuedInputDetail(controller.state, 'input')).toEqual({
      message: expect.objectContaining({
        content: text,
        __openclaw: expect.objectContaining({ media: expect.any(Array) }),
      }),
      truncated: false,
    });
    controller.state.sessionKey = 'another-session';
    expect(queuedInputDetail(controller.state, 'input')).toBeNull();
  });
  test('sends successive inputs with native followup custody without replacing the active run', async () => {
    const { controller, request, refresh } = fixture();
    const transcript = controller.state.transcript;
    await controller.queueMessage('first', [
      { name: 'image.png', mimeType: 'image/png', base64Data: 'YWJj' },
    ]);
    await controller.queueMessage('second');
    expect(request).toHaveBeenNthCalledWith(
      1,
      'chat.send',
      expect.objectContaining({
        sessionKey,
        sessionId: 'native-one',
        message: 'first',
        queueMode: 'followup',
        suppressCommandInterpretation: true,
        deliver: false,
        justdoUserInitiated: true,
        attachments: [
          { type: 'image', mimeType: 'image/png', content: 'YWJj', fileName: 'image.png' },
        ],
      }),
    );
    expect(request.mock.calls[0][1].idempotencyKey).not.toBe(
      request.mock.calls[1][1].idempotencyKey,
    );
    expect(controller.state.chatRunId).toBe('justdo-active');
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.transcript).toBe(transcript);
    expect(controller.state.chatMessages).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('reuses the same identity after a lost acknowledgement and rejects edited retries', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.queueMessage('first')).rejects.toThrow();
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);
    controller.state.chatSending = false;
    controller.state.chatRunId = null;
    await expect(controller.queueMessage('changed')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    await controller.queueMessage('first');
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
    expect(request.mock.calls[1][1].idempotencyKey).toBe(request.mock.calls[0][1].idempotencyKey);
    await controller.queueMessage('changed');
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('allows a corrected submission after a definitive rejection', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(
      Object.assign(new Error('rejected'), { gatewayCode: 'INVALID_REQUEST' }),
    );
    await expect(controller.queueMessage('first')).rejects.toThrow('rejected');
    await controller.queueMessage('changed');
    expect(request.mock.calls[1][1].idempotencyKey).not.toBe(
      request.mock.calls[0][1].idempotencyKey,
    );
  });

  test('rejects duplicate in-flight sends and does not refresh another selected session', async () => {
    const { controller, request, refresh } = fixture();
    let accept!: (value: unknown) => void;
    request.mockReturnValueOnce(
      new Promise(resolve => {
        accept = resolve;
      }),
    );
    const sending = controller.queueMessage('first');
    await expect(controller.queueMessage('first')).rejects.toThrow();
    refresh.mockClear();
    controller.state.sessionKey = 'agent:main:justdo:two';
    accept({ status: 'started' });
    await sending;
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      controller.queueMessage('wrong session', [], undefined, sessionKey),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each(['disconnected', 'missing-identity', 'storage-error', 'compacting'])(
    'does not send when %s',
    async reason => {
      const { controller, request } = fixture();
      if (reason === 'disconnected') controller.state.connected = false;
      if (reason === 'missing-identity') controller.state.currentSessionId = null;
      if (reason === 'storage-error') controller.state.historyReadFailed = true;
      if (reason === 'compacting') controller.state.compactionInFlight = true;
      await expect(controller.queueMessage('first')).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  test('withdraws only a native pending input with exact scoped cancellation', async () => {
    const { controller, request } = fixture();
    request.mockResolvedValueOnce({ inputReceipts: [{ runId: 'queued-one', state: 'pending' }] });
    await refreshNativePendingInputs(
      controller.state,
      {
        pendingInputs: {
          total: 1,
          items: [
            {
              id: 'input-one',
              runId: 'queued-one',
              state: 'queued', queued: true,
              acceptedAt: 1,
              message: { role: 'user', content: 'next' },
            },
          ],
        },
      },
      vi.fn(),
      vi.fn(),
    );
    await controller.withdrawQueuedInput('input-one');
    expect(request).toHaveBeenLastCalledWith('chat.abort', {
      sessionKey,
      runId: 'queued-one',
      discardPendingInput: true,
    });
    expect(controller.state.chatRunId).toBe('justdo-active');
    controller.state.sessionKey = 'agent:main:justdo:two';
    await expect(controller.withdrawQueuedInput('input-one')).rejects.toThrow();
    expect(request.mock.calls.filter(([method]) => method === 'chat.abort')).toHaveLength(1);
  });

  test('queue admission and cancellation events cannot bind over the current provisional turn', async () => {
    const { controller, request, event } = fixture();
    controller.state.chatSending = false;
    controller.state.chatRunId = null;
    await controller.sendMessage('active', [], undefined, { clientTurnId: 'justdo-active' });
    await controller.queueMessage('next');
    const queuedRunId = request.mock.calls.find(([, params]) => params.queueMode)?.[1]
      .idempotencyKey;
    event('agent', {
      sessionKey,
      runId: queuedRunId,
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'progress', stage: 'queued' },
    });
    event('chat', { sessionKey, runId: queuedRunId, state: 'aborted' });
    expect(controller.state.chatRunId).toBe('justdo-active');
    expect(controller.state.transcript.activeTurn?.runId).toBe('justdo-active');
    expect(controller.state.chatSending).toBe(true);
    event('chat', {
      sessionKey,
      runId: 'justdo-active',
      state: 'final',
      message: { role: 'assistant', content: 'done' },
    });
    event('agent', {
      sessionKey,
      runId: 'native-followup',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    });
    event('agent', {
      sessionKey,
      runId: 'native-followup',
      seq: 2,
      stream: 'assistant',
      data: { text: 'next response' },
    });
    expect(controller.state.chatRunId).toBe('native-followup');
    expect(controller.state.chatSending).toBe(true);
  });
});
