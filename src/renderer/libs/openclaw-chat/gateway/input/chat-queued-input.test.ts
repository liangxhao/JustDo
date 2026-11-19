import { composeBrowserGatewayPrompt } from '@shared/browser/browserMessageContext';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { projectPersistedMessagesForActiveTurn } from '../../model/history/optimistic-history-tail';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import type { GatewayMessage } from '../../types';
import { ChatController } from '../chat-controller';
import {
  queuedInputDetail,
  queuedInputSnapshot,
  refreshNativePendingInputs,
} from './chat-pending-inputs';
import { fingerprintChatInput, recordRestagedAudioDirective } from './chat-queued-input';

const sessionKey = 'agent:main:justdo:one';
const controllers: ChatController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
});

function fixture() {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) =>
    method === 'chat.send' ? { runId: params.idempotencyKey, status: 'started' } : {},
  );
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
    ], undefined, sessionKey, 'ask');
    const firstRunId = request.mock.calls[0][1].idempotencyKey;
    request.mockResolvedValueOnce({ inputReceipts: [{ runId: firstRunId, state: 'pending' }] });
    await refreshNativePendingInputs(controller.state, {
      sessionId: 'native-one',
      pendingInputs: { total: 1, items: [{
        id: 'first-input', runId: firstRunId, state: 'queued', queued: true, acceptedAt: 1,
        message: { role: 'user', content: 'first' },
      }] },
    }, vi.fn(), vi.fn());
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(true);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
    await controller.queueMessage('second', [], undefined, sessionKey, 'ask');
    expect(request).toHaveBeenNthCalledWith(
      1,
      'chat.send',
      expect.objectContaining({
        sessionKey,
        sessionId: 'native-one',
        message: 'first',
        queueMode: 'followup',
        expectedPermissionMode: 'guarded',
        suppressCommandInterpretation: true,
        deliver: false,
        justdoUserInitiated: true,
        attachments: [
          { type: 'image', mimeType: 'image/png', content: 'YWJj', fileName: 'image.png' },
        ],
      }),
    );
    expect(request.mock.calls[0][1].idempotencyKey).not.toBe(
      request.mock.calls[2][1].idempotencyKey,
    );
    expect(controller.state.chatRunId).toBe('justdo-active');
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.transcript).toBe(transcript);
    expect(controller.state.chatMessages).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.state.currentSessionId = 'new-native-incarnation';
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(false);
  });

  test('keeps separate identities for distinct drafts after two lost acknowledgements', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce(new Error('response lost'));
    await expect(controller.queueMessage('first')).rejects.toThrow();
    controller.state.chatSending = false;
    controller.state.chatRunId = null;
    await expect(controller.queueMessage('second')).rejects.toThrow();
    await controller.queueMessage('third');
    const firstId = request.mock.calls[0][1].idempotencyKey;
    const secondId = request.mock.calls[1][1].idempotencyKey;
    const thirdId = request.mock.calls[2][1].idempotencyKey;
    expect(new Set([firstId, secondId, thirdId]).size).toBe(3);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);

    await controller.queueMessage('first');
    expect(request.mock.calls[3][1].idempotencyKey).toBe(firstId);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);
    await controller.queueMessage('second');
    expect(request.mock.calls[4][1].idempotencyKey).toBe(secondId);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
  });

  test('a permission change alone does not issue a new request for the same unknown draft', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.queueMessage('first', [], undefined, sessionKey, 'ask')).rejects.toThrow();
    await expect(controller.queueMessage('first', [], undefined, sessionKey, 'auto')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);

    await controller.queueMessage('first', [], undefined, sessionKey, 'ask');

    expect(request.mock.calls[1][1].idempotencyKey).toBe(request.mock.calls[0][1].idempotencyKey);
  });

  test.each(['in_flight', 'mismatched'])('keeps an uncertain %s acknowledgement under its original ID', async outcome => {
    const { controller, request } = fixture();
    request.mockImplementationOnce(async (_method, params) => outcome === 'in_flight'
      ? { runId: params.idempotencyKey, status: 'in_flight' }
      : { runId: 'another-input', status: 'started' });
    await expect(controller.queueMessage('first')).rejects.toThrow();
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);

    await controller.queueMessage('first');

    expect(request.mock.calls[1][1].idempotencyKey).toBe(request.mock.calls[0][1].idempotencyKey);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
  });

  test('a definitively unsent retry retains the earlier uncertain request', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.queueMessage('first')).rejects.toThrow();
    request.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { requestSent: false }));
    await expect(controller.queueMessage('first')).rejects.toThrow();
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);

    await controller.queueMessage('first');

    expect(request.mock.calls.map(([, params]) => params.idempotencyKey)).toEqual(
      Array<string>(3).fill(request.mock.calls[0][1].idempotencyKey as string),
    );
  });

  test('answers an unchanged retry from an exact recovered native receipt without sending it again', async () => {
    const { controller, request } = fixture();
    request.mockRejectedValueOnce(new Error('connection lost')).mockRejectedValueOnce(new Error('response lost'));
    await expect(controller.queueMessage('first')).rejects.toThrow();
    await expect(controller.queueMessage('second')).rejects.toThrow();
    const firstId = request.mock.calls[0][1].idempotencyKey;
    const secondId = request.mock.calls[1][1].idempotencyKey;
    const emptyHistory = { sessionId: 'native-one', pendingInputs: { total: 0, items: [] } };
    request.mockResolvedValueOnce({
      sessionId: 'different-native-session', inputReceipts: [{ runId: secondId, state: 'pending' }],
    });
    await refreshNativePendingInputs(controller.state, emptyHistory, vi.fn(), vi.fn());
    request.mockResolvedValueOnce({
      sessionId: 'native-one', inputReceipts: [{ runId: firstId, state: 'consumed', consumedByEventId: 'original-row' }],
    });
    await refreshNativePendingInputs(controller.state, emptyHistory, vi.fn(), vi.fn());

    expect(request).toHaveBeenLastCalledWith('chat.history', expect.objectContaining({
      inputRunIds: expect.arrayContaining([firstId, secondId]),
    }));
    await controller.queueMessage('first');
    expect(request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(2);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(true);
    await controller.queueMessage('second');
    expect(request.mock.calls.at(-1)?.[1].idempotencyKey).toBe(secondId);
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
  });

  test.each(['input receipt', 'persisted history', 'receipt lookup history', 'live append'])(
    'recovered admission from %s only intercepts retries of its own draft', async evidence => {
      const { controller, request, event } = fixture();
      request.mockRejectedValueOnce(new Error('connection lost'));
      await expect(controller.queueMessage('First draft')).rejects.toThrow();
      const runId = request.mock.calls[0][1].idempotencyKey;
      const message = {
        role: 'user', content: 'First draft',
        __openclaw: { id: 'first-row', seq: 1, idempotencyKey: `${runId}:user` },
      };
      const history = { sessionId: 'native-one', pendingInputs: { total: 0, items: [] } };
      if (evidence === 'input receipt') {
        request.mockResolvedValueOnce({
          sessionId: 'native-one',
          inputReceipts: [{ runId, state: 'consumed', consumedByEventId: 'first-row' }],
        });
        await refreshNativePendingInputs(controller.state, history, vi.fn(), vi.fn());
      } else if (evidence === 'persisted history') {
        await refreshNativePendingInputs(controller.state, { ...history, messages: [message] }, vi.fn(), vi.fn());
      } else if (evidence === 'receipt lookup history') {
        request.mockResolvedValueOnce({ ...history, inputReceipts: [], messages: [message] });
        await refreshNativePendingInputs(controller.state, history, vi.fn(), vi.fn());
      } else {
        event('session.message', { sessionKey, sessionId: 'native-one', message, runActive: true });
      }

      expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
      expect(await controller.matchInputForRecovery('A new draft', [], sessionKey)).toBe(false);
      expect(await controller.matchInputForRecovery('First draft', [], sessionKey)).toBe(true);
      await controller.queueMessage('First draft');
      expect(request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
      expect(controller.matchInputForRecovery('First draft', [], sessionKey)).toBeNull();
    },
  );

  test('does not dispatch after the physical session changes while hashing a draft', async () => {
    const { controller, request } = fixture();
    const sending = controller.queueMessage('first');
    controller.state.currentSessionId = 'different-native-session';

    await expect(sending).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  test('fingerprints the outbound text and included attachment data', async () => {
    const file = { name: 'sample.png', mimeType: 'image/png', base64Data: 'YWJj' };
    const fingerprint = await fingerprintChatInput('Original', [file]);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await fingerprintChatInput('Original', [{ ...file }, { ...file, base64Data: '' }])).toBe(fingerprint);
    expect(await fingerprintChatInput('Original', [{ ...file, base64Data: 'Y2Jh' }])).not.toBe(fingerprint);
    expect(await fingerprintChatInput('Edited', [file])).not.toBe(fingerprint);
  });

  test('an unchanged browser draft retries with the original native input and a different context is a new input', async () => {
    const { controller, request } = fixture();
    const annotation = {
      id: 'annotated-page', modelContext: 'First annotation', title: 'Page',
      displayUrl: 'https://example.test/', markedRegionCount: 1, inspectedElement: false,
      dataUrl: '', fileName: 'page.png', addedAt: 1,
    };
    const draft = 'Describe the page';
    const original = composeBrowserGatewayPrompt(draft, [annotation]);
    const retry = composeBrowserGatewayPrompt(draft, [annotation]);
    const changed = composeBrowserGatewayPrompt(draft, [{ ...annotation, modelContext: 'Second annotation' }]);
    request.mockRejectedValueOnce(new Error('connection lost'));

    expect(retry).not.toBe(original);
    await expect(controller.queueMessage(draft, [], original)).rejects.toThrow();
    await controller.queueMessage(draft, [], changed);
    await controller.queueMessage(draft, [], retry);

    expect(request.mock.calls[1][1]).toMatchObject({ message: changed });
    expect(request.mock.calls[1][1].idempotencyKey).not.toBe(request.mock.calls[0][1].idempotencyKey);
    expect(request.mock.calls[2]).toEqual(request.mock.calls[0]);
  });

  test('a replaced external audio copy keeps the original uncertain draft without blocking edited text', async () => {
    const { controller, request } = fixture();
    const original = 'MEDIA:E:/项目/.audio-attachments-first/录音.mp3';
    const replacement = 'MEDIA:E:/项目/.audio-attachments-replacement/录音.mp3';
    const firstDraft = `Transcribe this recording\n\n${original}`;
    const retryDraft = `Transcribe this recording\n\n${replacement}`;
    request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.queueMessage(firstDraft)).rejects.toThrow();
    const firstRunId = request.mock.calls[0][1].idempotencyKey;

    recordRestagedAudioDirective(replacement, original);
    expect(await fingerprintChatInput(retryDraft, [])).toBe(await fingerprintChatInput(firstDraft, []));
    await expect(controller.queueMessage(retryDraft)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);

    const editedDraft = `Summarize this recording\n\n${replacement}`;
    await controller.queueMessage(editedDraft);
    expect(request).toHaveBeenLastCalledWith('chat.send', expect.objectContaining({ message: editedDraft }));
    expect(request.mock.calls[1][1].idempotencyKey).not.toBe(firstRunId);

    request.mockResolvedValueOnce({
      sessionId: 'native-one', inputReceipts: [{ runId: firstRunId, state: 'pending' }],
    });
    await refreshNativePendingInputs(controller.state, {
      sessionId: 'native-one', pendingInputs: { total: 0, items: [] },
    }, vi.fn(), vi.fn());
    await controller.queueMessage(retryDraft);
    expect(request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(2);
  });

  test.each([false, true])('sends a new identical draft after clearing the previous one (receipt recovered=%s)', async recovered => {
    const { controller, request } = fixture();
    const draft = 'Transcribe\n\nMEDIA:E:/项目/录音.mp3';
    let draftCurrent = true;
    request.mockRejectedValueOnce(new Error('connection lost'));
    await expect(controller.queueMessage(draft, [], undefined, sessionKey, undefined, undefined, undefined, () => draftCurrent)).rejects.toThrow();
    const priorRunId = request.mock.calls[0][1].idempotencyKey;

    if (recovered) {
      request.mockResolvedValueOnce({
        sessionId: 'native-one', inputReceipts: [{ runId: priorRunId, state: 'pending' }],
      });
      await refreshNativePendingInputs(controller.state, {
        sessionId: 'native-one', pendingInputs: { total: 0, items: [] },
      }, vi.fn(), vi.fn());
    }

    draftCurrent = false;
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
    await controller.queueMessage(draft);
    const sends = request.mock.calls.filter(([method]) => method === 'chat.send');
    expect(sends).toHaveLength(2);
    expect(sends[1][1].idempotencyKey).not.toBe(priorRunId);
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

  test('rechecks Stop after preparing the input fingerprint and before sending', async () => {
    const { controller, request } = fixture();
    let cancelled = false;
    const sending = controller.queueMessage('next', [], undefined, sessionKey, 'ask', 'native-one', () => {
      if (cancelled) throw new Error('Stopped before dispatch');
    });
    cancelled = true;

    await expect(sending).rejects.toThrow('Stopped before dispatch');
    expect(request).not.toHaveBeenCalled();
    expect(controller.hasUnconfirmedQueuedInput()).toBe(false);
  });

  test('rejects duplicate in-flight sends and does not refresh another selected session', async () => {
    const { controller, request, refresh } = fixture();
    let accept!: (value: unknown) => void;
    let markIssued!: (runId: unknown) => void;
    const issued = new Promise(resolve => { markIssued = resolve; });
    request.mockImplementationOnce((_method, params) =>
      new Promise(resolve => {
        accept = resolve;
        markIssued(params.idempotencyKey);
      }),
    );
    const sending = controller.queueMessage('first');
    const runId = await issued;
    await expect(controller.queueMessage('first')).rejects.toThrow();
    refresh.mockClear();
    controller.state.sessionKey = 'agent:main:justdo:two';
    accept({ runId, status: 'started' });
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
