import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runProgressDetail } from '../../components/timeline/run-progress-label';
import { createChatTranscriptState } from '../../model/chat-transcript-state';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { projectWaitingStatus, RUN_PROBE_INTERVAL_MS, RUN_STALL_NOTICE_MS } from '../../model/turn/run-activity';
import { readRunProgress } from '../../model/turn/run-progress';
import { ChatController } from '../chat-controller';

const sessionKey = 'agent:main:justdo:progress-test';
let controller: ChatController;
let sequence: number;
let handle: (event: { event: string; payload: unknown }) => void;
const emit = (stream: string, data: Record<string, unknown>, overrides = {}) =>
  handle({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-progress',
      sessionId: 'physical-session',
      lifecycleGeneration: 'generation-current',
      seq: ++sequence,
      ts: Date.now(),
      stream,
      data,
      ...overrides,
    },
  });
const progressItem = (progress: Record<string, unknown>) => ({
  itemId: 'run-stream-progress',
  kind: 'status',
  phase: 'update',
  status: 'running',
  progress,
});
const requestActivityItem = (at = Date.now()) => ({
  itemId: 'run-request-activity',
  kind: 'status',
  phase: 'update',
  status: 'running',
  at,
  progress: { kind: 'model-activity' },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  sequence = 0;
  controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'physical-session';
  controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
  controller.state.client = { request: vi.fn().mockResolvedValue({}), stop: vi.fn() } as never;
  controller.state.connected = true;
  controller.state.transportStatus = 'connected';
  handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
  emit('lifecycle', { phase: 'start' });
});
afterEach(() => {
  controller.disconnect();
  vi.useRealTimers();
});

describe('quiet foreground run recovery', () => {
  const nativeSession = {
    key: sessionKey,
    sessionId: 'physical-session',
    lifecycleRevision: 'session-revision',
    hasActiveRun: false,
  };

  test('recovers an ordinary missed terminal and lets the next message reach Gateway', async () => {
    const answer = {
      role: 'assistant',
      content: 'Persisted reply',
      __openclaw: { id: 'reply-1', seq: 1, runId: 'run-progress' },
    };
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') return { session: nativeSession };
      if (method === 'agent.wait') return { runId: 'run-progress', status: 'ok', endedAt: 2_000 };
      if (method === 'chat.send') return { runId: 'next-run', status: 'started' };
      return { sessionId: nativeSession.sessionId, messages: [answer] };
    });
    controller.state.client!.request = request;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-progress', timeoutMs: 0 });
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.runActivity).toBeNull();
    expect(controller.getCurrentTurnTiming()).toMatchObject({ status: 'final', endedAt: 2_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.state.chatMessages).toContainEqual(
      expect.objectContaining({ content: 'Persisted reply' }),
    );
    await controller.sendMessage('Next question');
    expect(request).toHaveBeenCalledWith('chat.send', expect.objectContaining({ message: 'Next question' }));
    expect(controller.state.chatRunId).toBe('next-run');
  });

  test.each([
    { source: 'matching run ID', activeRunIds: ['continued-run'], confirmed: true },
    { source: 'another run ID without a snapshot', activeRunIds: ['other-run'], confirmed: false },
    { source: 'matching in-flight snapshot', snapshotRunId: 'continued-run', confirmed: true },
    { source: 'another in-flight snapshot', snapshotRunId: 'other-run', confirmed: false },
  ])('recovers Stop during context preparation with $source', async ({ activeRunIds, snapshotRunId, confirmed }) => {
    const runId = 'continued-run';
    const session = { ...nativeSession, hasActiveRun: true, activeRunIds };
    const request = vi.fn(async (method: string) => {
      if (method === 'chat.send') throw new Error('Lost acknowledgement');
      if (method === 'sessions.describe') return { session };
      return { sessionId: session.sessionId, sessionInfo: session,
        ...(snapshotRunId ? { inFlightRun: { runId: snapshotRunId } } : {}),
      };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    await expect(controller.sendMessage('Continue this conversation', [], undefined, {
      clientTurnId: runId, onRequestUnknown: vi.fn(),
    })).rejects.toThrow('Lost acknowledgement');
    emit('run_status', { phase: 'preparing_context' }, { runId });
    expect(controller.state.runActivity?.stage).toBe('preparing');
    expect(controller.getActiveNativeChatRunId()).toBeNull();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(controller.getActiveNativeChatRunId()).toBe(confirmed ? runId : null);
    expect(request.mock.calls.filter(([method]) => method === 'chat.history'))
      .toHaveLength(activeRunIds?.includes(runId) ? 0 : 1);
  });

  test('recovers a finished run when the supplementary history request stalls', async () => {
    const runId = 'continued-run';
    let hasEnded = false;
    const request = vi.fn(async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
      if (method === 'chat.send') {
        if (!hasEnded) throw new Error('Lost acknowledgement');
        return { status: 'started', runId: 'next-run' };
      }
      if (method === 'sessions.describe') return { session: { ...nativeSession, hasActiveRun: !hasEnded } };
      if (method === 'agent.wait') return { runId, status: 'ok', endedAt: Date.now() };
      if (!hasEnded) {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('History unavailable')), options?.timeoutMs ?? 90_000);
        });
      }
      return { sessionId: nativeSession.sessionId, messages: [] };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    await expect(controller.sendMessage('Continue this conversation', [], undefined, {
      clientTurnId: runId, onRequestUnknown: vi.fn(),
    })).rejects.toThrow('Lost acknowledgement');
    emit('run_status', { phase: 'preparing_context' }, { runId });
    await vi.advanceTimersByTimeAsync(RUN_STALL_NOTICE_MS);

    hasEnded = true;
    await vi.advanceTimersByTimeAsync(2 * RUN_PROBE_INTERVAL_MS);

    await controller.sendMessage('New input');
    expect(controller.state.chatRunId).toBe('next-run');
  });

  test.each([false, true])('checks for a verified successor without losing prior live output (output=%s)', async hasLiveOutput => {
    const originalRun = 'continued-run';
    let activeRun = originalRun;
    let historyRun = originalRun;
    const request = vi.fn(async (method: string) => {
      if (method === 'chat.send') throw new Error('Lost acknowledgement');
      const session = { ...nativeSession, hasActiveRun: true, activeRunIds: [activeRun] };
      if (method === 'sessions.describe') return { session };
      return {
        sessionId: session.sessionId,
        sessionInfo: { ...session, activeRunIds: [historyRun] },
        inFlightRun: { runId: historyRun },
      };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    await expect(controller.sendMessage('Continue this conversation', [], undefined, {
      clientTurnId: originalRun, onRequestUnknown: vi.fn(),
    })).rejects.toThrow('Lost acknowledgement');
    emit('run_status', { phase: 'preparing_context' }, { runId: originalRun });
    await vi.advanceTimersByTimeAsync(RUN_STALL_NOTICE_MS);
    expect(controller.getActiveNativeChatRunId()).toBe(originalRun);
    if (hasLiveOutput) emit('assistant', { text: 'Visible original reply' }, { runId: originalRun });

    activeRun = 'native-successor';
    historyRun = 'other-run';
    await vi.advanceTimersByTimeAsync(hasLiveOutput ? RUN_STALL_NOTICE_MS : RUN_PROBE_INTERVAL_MS);
    expect(controller.getActiveNativeChatRunId()).toBe(originalRun);

    historyRun = activeRun;
    await vi.advanceTimersByTimeAsync(RUN_PROBE_INTERVAL_MS);

    const expectedRun = hasLiveOutput ? originalRun : activeRun;
    expect(controller.getActiveNativeChatRunId()).toBe(expectedRun);
    expect(controller.state.runActivity?.runId).toBe(expectedRun);
    if (hasLiveOutput) {
      expect(controller.state.transcript.activeTurn?.items).toContainEqual(
        expect.objectContaining({ type: 'content', text: 'Visible original reply' }),
      );
    }
    expect(controller.state.transcript.terminalRunIds.has(originalRun)).toBe(false);
    expect(controller.state.chatMessages).toContainEqual(expect.objectContaining({ content: 'Continue this conversation' }));
  });

  test.each([
    { runId: 'run-progress', status: 'timeout' },
    { runId: 'different-run', status: 'ok', endedAt: 2_000 },
    { runId: 'run-progress', status: 'ok', endedAt: 2_000, yielded: true },
  ])('shows an unconfirmed result for idle without an exact terminal (%j)', async result => {
    const request = vi.fn(async (method: string) =>
      method === 'sessions.describe' ? { session: nativeSession } : result,
    );
    controller.state.client!.request = request;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe('run-progress');
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected',
    })).toMatchObject({ kind: 'outcome-unconfirmed' });
    expect(request).not.toHaveBeenCalledWith('chat.send', expect.anything());
  });

  test('sends a distinct prepared input when an admitted idle run has no result', async () => {
    const oldRunId = 'run-progress';
    const newRunId = 'next-client-input';
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') return { session: nativeSession };
      if (method === 'agent.wait') return { runId: oldRunId, status: 'timeout' };
      if (method === 'chat.send') return { runId: newRunId, status: 'started' };
      return { sessionId: nativeSession.sessionId, messages: [] };
    });
    controller.state.client!.request = request;
    await vi.advanceTimersByTimeAsync(35_000);
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(false);
    expect(controller.state.chatRunId).toBe(oldRunId);
    await expect(controller.sendMessage('New input')).rejects.toThrow('already being sent');

    await controller.sendMessage('New input', [], undefined, {
      clientTurnId: newRunId, allowInactivePredecessor: true,
    });

    expect(request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      message: 'New input', sessionId: nativeSession.sessionId, idempotencyKey: newRunId,
    }));
    expect(controller.state.transcript.terminalRunIds.has(oldRunId)).toBe(false);
    emit('assistant', { text: 'Previous reply' });
    handle({ event: 'chat', payload: { sessionKey, runId: oldRunId, state: 'final' } });
    expect(controller.state.chatRunId).toBe(newRunId);
    expect(controller.state.runActivity?.runId).toBe(newRunId);
  });

  test.each(['lost acknowledgement', 'in-flight acknowledgement'])(
    'holds the original send without admission evidence (%s)', async acknowledgement => {
      const unknownRunId = 'unknown-submit';
      const request = vi.fn(async (method: string) => {
        if (method === 'sessions.describe') return { session: nativeSession };
        if (method === 'agent.wait') return { runId: unknownRunId, status: 'timeout' };
        if (method === 'chat.send') {
          if (acknowledgement === 'lost acknowledgement') throw new Error('Lost acknowledgement');
          return { runId: unknownRunId, status: 'in_flight' };
        }
        return { sessionId: nativeSession.sessionId, messages: [] };
      });
      controller.state.client!.request = request;
      controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
      const markUnknown = vi.fn();
      const submitted = controller.sendMessage('Previous input', [], undefined, {
        clientTurnId: unknownRunId, onRequestUnknown: markUnknown,
      });
      await expect(submitted).rejects.toThrow();
      expect(markUnknown).toHaveBeenCalledWith(unknownRunId);
      await vi.advanceTimersByTimeAsync(35_000);

      await expect(controller.sendMessage('New input', [], undefined, { allowInactivePredecessor: true }))
        .rejects.toThrow('already being sent');
      expect(controller.state.chatRunId).toBe(unknownRunId);
      expect(request.mock.calls.filter(([method]) => method === 'chat.send')).toHaveLength(1);
    },
  );

  test.each([true, false])('follows the native owner after an unknown send (active IDs present=%s)', async hasActiveRunIds => {
    const originalRun = 'justdo-unconfirmed-original';
    const followupRun = 'native-followup-run';
    const request = vi.fn(async (method: string, params: { message?: string; idempotencyKey?: string }) => {
      if (method === 'chat.send') {
        if (params.message === 'Prior input') throw new Error('Lost acknowledgement');
        return { status: 'started', runId: params.idempotencyKey };
      }
      return { sessionId: nativeSession.sessionId, messages: [] };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    const recordUnknown = vi.fn();
    await expect(controller.sendMessage('Prior input', [], undefined, {
      clientTurnId: originalRun, onRequestUnknown: recordUnknown,
    })).rejects.toThrow('Lost acknowledgement');
    await controller.queueMessage('Next input', [], undefined, sessionKey, 'ask', nativeSession.sessionId);

    expect(recordUnknown).toHaveBeenCalledWith(originalRun);
    expect(request).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      message: 'Next input', queueMode: 'followup', sessionId: nativeSession.sessionId,
    }));
    emit('assistant', { text: 'New output before ownership sync' }, { runId: followupRun });
    expect(controller.state.chatRunId).toBe(originalRun);
    const adopt = (controller as unknown as {
      applyInFlightRunSnapshot: (run: unknown, key: string, sessionId: string, previous: string, info: unknown) => void;
    }).applyInFlightRunSnapshot.bind(controller);
    adopt({ runId: followupRun }, sessionKey, nativeSession.sessionId, originalRun, {
      sessionId: nativeSession.sessionId, hasActiveRun: true, activeRunIds: [originalRun, followupRun],
    });
    expect(controller.state.chatRunId).toBe(originalRun);
    adopt({ runId: followupRun }, sessionKey, nativeSession.sessionId, originalRun, {
      sessionId: nativeSession.sessionId, hasActiveRun: true,
      ...(hasActiveRunIds ? { activeRunIds: [followupRun] } : {}),
    });
    expect(controller.state.chatRunId).toBe(followupRun);
    expect(controller.state.transcript.terminalRunIds.has(originalRun)).toBe(false);
    expect(controller.state.chatMessages).toContainEqual(expect.objectContaining({ content: 'Prior input' }));
    emit('assistant', { text: 'Late original output' }, { runId: originalRun });
    expect(controller.state.chatRunId).toBe(followupRun);

    adopt({ runId: originalRun }, sessionKey, nativeSession.sessionId, followupRun, {
      sessionId: nativeSession.sessionId, hasActiveRun: true,
      ...(hasActiveRunIds ? { activeRunIds: [originalRun] } : {}),
    });
    expect(controller.state.chatRunId).toBe(originalRun);
  });

  test.each(['deferred-reload', 'empty-history'] as const)(
    'recovers the successor of an unknown send through %s', async recovery => {
      const originalRun = 'justdo-unconfirmed-original';
      const successorRun = 'native-successor';
      const messages = recovery === 'empty-history' ? [] : [{
        role: 'user', content: 'Earlier input', __openclaw: { id: 'earlier-input', seq: 1 },
      }];
      let successorActive = false;
      const request = vi.fn(async (method: string, params?: { queueMode?: string; idempotencyKey?: string }) => {
        if (method === 'chat.send') {
          if (params?.queueMode !== 'followup') throw new Error('Lost acknowledgement');
          return { status: 'started', runId: params.idempotencyKey };
        }
        return {
          sessionId: nativeSession.sessionId,
          sessionInfo: { ...nativeSession, hasActiveRun: successorActive },
          messages,
          pendingInputs: { items: [], total: 0 },
          ...(successorActive ? {
            inFlightRun: {
              runId: successorRun,
              startedAt: Date.now(),
              events: [{
                runId: successorRun, seq: 1, sessionKey, sessionId: nativeSession.sessionId,
                ts: Date.now(), stream: 'assistant', data: { text: 'Recovered output' },
              }],
            },
          } : {}),
        };
      });
      controller.state.client!.request = request;
      controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
      await controller.loadHistory();
      await expect(controller.sendMessage('Previous input', [], undefined, {
        clientTurnId: originalRun, onRequestUnknown: vi.fn(),
      })).rejects.toThrow('Lost acknowledgement');

      successorActive = recovery === 'empty-history';
      await controller.queueMessage('Second input', [], undefined, sessionKey, 'ask', nativeSession.sessionId);
      await vi.advanceTimersByTimeAsync(0);
      if (recovery === 'deferred-reload') {
        // An ordinary debounce is already waiting for the current run to end.
        const controllerRecovery = controller as unknown as {
          scheduleDeferredHistoryReload(sessionKey: string, reason: string): void;
        };
        controllerRecovery.scheduleDeferredHistoryReload(sessionKey, 'session-message');
        successorActive = true;
        emit('lifecycle', { phase: 'start' }, { runId: successorRun });
        await vi.advanceTimersByTimeAsync(1_300);
      }

      expect(controller.state.chatRunId).toBe(successorRun);
      expect(controller.getActiveNativeChatRunId()).toBe(successorRun);
      expect(controller.state.transcript.activeTurn?.items).toEqual([
        expect.objectContaining({ type: 'content', text: 'Recovered output' }),
      ]);
      expect(controller.state.chatMessages).toContainEqual(expect.objectContaining({ content: 'Previous input' }));
      expect(controller.state.transcript.terminalRunIds.has(originalRun)).toBe(false);
    },
  );

  test.each([false, true])(
    'treats a scoped native snapshot as admission evidence after a missed start (active IDs present=%s)',
    async hasActiveRunIds => {
      const restoredRun = 'native-restored-run';
      const request = vi.fn(async (method: string) => {
        if (method === 'sessions.describe') return { session: nativeSession };
        if (method === 'agent.wait') return { runId: restoredRun, status: 'timeout' };
        if (method === 'chat.send') return { status: 'started', runId: 'next-run' };
        return {
          messages: [],
          sessionId: nativeSession.sessionId,
          sessionInfo: {
            ...nativeSession, hasActiveRun: true,
            ...(hasActiveRunIds ? { activeRunIds: [restoredRun] } : {}),
          },
          inFlightRun: { runId: restoredRun, startedAt: Date.now() },
        };
      });
      controller.state.client!.request = request;
      controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
      await controller.loadHistory();
      expect(controller.state.chatRunId).toBe(restoredRun);
      expect(controller.getActiveNativeChatRunId()).toBe(restoredRun);
      Object.assign(controller.state.client!, { generation: 2 });
      expect(controller.getActiveNativeChatRunId()).toBeNull();

      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.state.runActivity?.probeState).toBe('inactive');
      await controller.sendMessage('New input', [], undefined, { allowInactivePredecessor: true });

      expect(controller.state.chatRunId).toBe('next-run');
      expect(controller.state.transcript.terminalRunIds.has(restoredRun)).toBe(false);
    },
  );

  test('shows the durable reply when a followup finishes before the ownership read', async () => {
    const originalRun = 'justdo-unconfirmed-original';
    const successorRun = 'native-fast-successor';
    let queueAdmission = '';
    let successorFinished = false;
    let originalPersisted = false;
    const request = vi.fn(async (method: string, params?: { queueMode?: string; idempotencyKey?: string }) => {
      if (method === 'chat.send') {
        if (params?.queueMode !== 'followup') throw new Error('Lost acknowledgement');
        queueAdmission = params.idempotencyKey ?? '';
        return { status: 'started', runId: queueAdmission };
      }
      return {
        sessionId: nativeSession.sessionId,
        sessionInfo: { ...nativeSession, activeRunIds: [] },
        messages: successorFinished ? [
          { role: 'user', content: 'Second input', timestamp: 91_001, __openclaw: {
            id: 'second-input', seq: 1, runId: successorRun, idempotencyKey: `${queueAdmission}:user`,
          } },
          { role: 'assistant', content: 'Persisted successor output', timestamp: 91_002, __openclaw: {
            id: 'second-reply', seq: 2, runId: successorRun,
          } },
          ...(originalPersisted ? [{ role: 'user', content: 'Previous input', timestamp: 92_000, __openclaw: {
            id: 'original-input', seq: 3, idempotencyKey: `${originalRun}:user`,
          } }] : []),
        ] : [],
        pendingInputs: { items: [], total: 0 },
      };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    await expect(controller.sendMessage('Previous input', [], undefined, {
      clientTurnId: originalRun, onRequestUnknown: vi.fn(),
    })).rejects.toThrow('Lost acknowledgement');
    vi.setSystemTime(91_000);
    await controller.queueMessage('Second input', [], undefined, sessionKey, 'ask', nativeSession.sessionId);
    await vi.advanceTimersByTimeAsync(0);

    emit('lifecycle', { phase: 'start' }, { runId: successorRun });
    successorFinished = true;
    handle({ event: 'chat', payload: {
      sessionKey, sessionId: nativeSession.sessionId, runId: successorRun, state: 'final',
    } });
    // A native batch can invalidate history without publishing individual rows.
    handle({ event: 'sessions.changed', payload: { sessionKey, phase: 'message' } });
    await vi.advanceTimersByTimeAsync(1_300);

    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({ content: 'Previous input' }),
      expect.objectContaining({ content: 'Second input' }),
      expect.objectContaining({ content: 'Persisted successor output' }),
    ]);
    expect(controller.state.chatRunId).toBe(originalRun);
    expect(controller.state.transcript.terminalRunIds.has(originalRun)).toBe(false);

    originalPersisted = true;
    await controller.loadHistory();
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({ content: 'Second input' }),
      expect.objectContaining({ content: 'Persisted successor output' }),
      expect.objectContaining({ content: 'Previous input', __openclaw: expect.objectContaining({ id: 'original-input' }) }),
    ]);
  });

  test('adopts a native successor when the previous idle display is in a background tab', async () => {
    let successorStarted = false;
    const successorSession = () => ({
      ...nativeSession,
      hasActiveRun: successorStarted,
      activeRunIds: successorStarted ? ['native-successor'] : [],
    });
    const request = vi.fn(async (method: string, params?: { sessionKey?: string }) => {
      if (method === 'sessions.describe') return { session: successorSession() };
      if (method === 'agent.wait') return { runId: 'run-progress', status: 'timeout' };
      return params?.sessionKey === sessionKey
        ? { sessionId: nativeSession.sessionId, sessionInfo: successorSession(), messages: [] }
        : { sessionId: 'other-physical-session', messages: [] };
    });
    controller.state.client!.request = request;
    await vi.advanceTimersByTimeAsync(20_000);

    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;
    successorStarted = true;
    emit('lifecycle', { phase: 'start' }, { runId: 'native-successor' });
    emit('assistant', { text: 'New reply' }, { runId: 'native-successor' });
    emit('assistant', { text: 'Late previous reply' });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.chatRunId).toBe('native-successor');
    expect(controller.state.transcript.activeTurn?.items).toEqual([
      expect.objectContaining({ text: 'New reply' }),
    ]);
  });

  test('keeps early successor text away from an acknowledged client run until native handoff', async () => {
    const oldRunId = 'justdo-acknowledged-input';
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') return { session: nativeSession };
      if (method === 'agent.wait') return { runId: oldRunId, status: 'timeout' };
      if (method === 'chat.send') return { runId: oldRunId, status: 'started' };
      return { sessionId: nativeSession.sessionId, messages: [] };
    });
    controller.state.client!.request = request;
    controller.settleConfirmedRun(sessionKey, 'run-progress', 'aborted');
    await controller.sendMessage('Prior input', [], undefined, { clientTurnId: oldRunId });
    await vi.advanceTimersByTimeAsync(20_000);

    const successor = { runId: 'native-successor' };
    emit('assistant', { text: 'Early response' }, successor);
    expect(controller.state.transcript.activeTurn).toMatchObject({ runId: oldRunId, items: [] });
    emit('lifecycle', { phase: 'start' }, successor);
    emit('assistant', { text: 'Successor response' }, successor);

    expect(controller.state.transcript.activeTurn?.items).toEqual([
      expect.objectContaining({ runId: successor.runId, text: 'Successor response' }),
    ]);
    expect(controller.state.chatMessages).toContainEqual(expect.objectContaining({ content: 'Prior input' }));
  });

  test('keeps the yielded successor when a retired run emits a late start', async () => {
    controller.state.client!.request = vi.fn(async (method: string) =>
      method === 'sessions.describe' ? { session: nativeSession } : { runId: 'run-progress', status: 'timeout' },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    const successor = { runId: 'native-successor' };
    emit('lifecycle', { phase: 'start' }, successor);
    expect(controller.state.transcript.retiredDisplayRunIds.has('run-progress')).toBe(true);
    emit('lifecycle', {
      phase: 'end', yielded: true, livenessState: 'paused', stopReason: 'end_turn', executionSettled: true,
    }, successor);

    emit('lifecycle', { phase: 'start' });

    expect(controller.state.chatRunId).toBe(successor.runId);
    expect(controller.state.transcript.activeTurn).toMatchObject({ runId: successor.runId, status: 'running' });
    expect(controller.state.runActivity?.stage).toBe('waiting-continuation');
  });

  test('ignores a terminal receipt if native session identity changes during recovery', async () => {
    let revision = nativeSession.lifecycleRevision;
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') {
        return { session: { ...nativeSession, lifecycleRevision: revision } };
      }
      revision = 'replacement-revision';
      return { runId: 'run-progress', status: 'ok', endedAt: 2_000 };
    });
    controller.state.client!.request = request;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-progress', timeoutMs: 0 });
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.transcript.activeTurn).toMatchObject({ runId: 'run-progress', status: 'running' });
  });

  test('keeps compaction active when a previous turn receipt arrives during it', async () => {
    let resolveWait!: (result: unknown) => void;
    const wait = new Promise(resolve => { resolveWait = resolve; });
    const request = vi.fn(async (method: string) =>
      method === 'sessions.describe' ? { session: nativeSession } : wait,
    );
    controller.state.client!.request = request;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request).toHaveBeenCalledWith('agent.wait', { runId: 'run-progress', timeoutMs: 0 });

    handle({ event: 'session.operation', payload: { sessionKey, operation: 'compact', phase: 'start' } });
    resolveWait({ runId: 'run-progress', status: 'ok', endedAt: 2_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.state.compactionInFlight).toBe(true);
    expect(controller.state.chatSending).toBe(true);
  });
});

describe('native run progress through the chat controller', () => {
  test.each([
    ['yielded', true], ['already_pending', true], ['deferred', false], ['nothing_pending', false],
  ])('uses the native Yield result %s to decide whether the turn is waiting to continue', (status, waiting) => {
    const tool = { toolCallId: 'yield-call', name: 'sessions_yield' };
    emit('tool', { ...tool, phase: 'start' });
    emit('tool', { ...tool, phase: 'result', result: { details: { status } } });

    expect(controller.state.runActivity?.stage).toBe(waiting ? 'waiting-continuation' : 'waiting-model');
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(waiting);
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected', now: 61_000,
    })?.kind ?? null).toBe(waiting ? null : 'waiting-model');

    emit('item', requestActivityItem());
    expect(controller.state.runActivity?.stage).toBe('receiving-model');
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(false);
  });

  test.each([
    { paused: false, toolStartedAt: 2_500, expectedStage: 'running-tool' },
    { paused: false, toolStartedAt: 1_500, expectedStage: 'waiting-continuation' },
    { paused: true, toolStartedAt: 2_500, expectedStage: 'waiting-continuation' },
  ])('reconciles the waiting indicator with a repaired tool start (%j)', ({ paused, toolStartedAt, expectedStage }) => {
    vi.setSystemTime(2_000);
    const yieldCall = { toolCallId: 'yield-call', name: 'sessions_yield' };
    emit('tool', { ...yieldCall, phase: 'start' });
    emit('tool', { ...yieldCall, phase: 'result', result: { details: { status: 'already_pending' } } });
    if (paused) emit('lifecycle', {
      phase: 'end', yielded: true, livenessState: 'paused', stopReason: 'end_turn', executionSettled: true,
    });

    handle({ event: 'session.message', payload: {
      sessionKey, sessionId: 'physical-session', hasActiveRun: true, runId: 'run-progress', messageSeq: 1,
      message: {
        role: 'assistant', timestamp: toolStartedAt,
        __openclaw: { id: 'tool-start', seq: 1, runId: 'run-progress' },
        content: [{ type: 'toolCall', id: 'tool-call', name: 'read' }],
      },
    } });

    expect(controller.state.transcript.activeTurn?.toolById.get('tool-call')?.status).toBe('running');
    expect(controller.state.runActivity?.stage).toBe(expectedStage);
  });

  test.each([
    'native-final', 'lifecycle-fallback', 'early-successor', 'native-snapshot', 'embedded-snapshot', 'embedded-after-final',
  ] as const)(
    'keeps the paused display and admits continuation without rebinding the old turn (%s)', async handoff => {
    const paused = { phase: 'end', yielded: true, livenessState: 'paused', stopReason: 'end_turn', executionSettled: true };
    emit('lifecycle', paused, { sessionId: 'foreign-incarnation' });
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(false);

    emit('tool', { phase: 'start', toolCallId: 'yield-call', name: 'sessions_yield' });
    const previous = controller.state.transcript.activeTurn!;
    emit('lifecycle', paused);
    expect(controller.state.runActivity?.stage).toBe('waiting-continuation');
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(true);
    expect(previous.status).toBe('running');
    expect(controller.shouldSubmitFollowup('agent:main:another')).toBe(false);

    if (handoff === 'native-final' || handoff === 'embedded-after-final') {
      handle({ event: 'chat', payload: {
        sessionKey, runId: previous.runId, state: 'final', yielded: true,
      } });
    } else if (handoff === 'lifecycle-fallback') {
      await vi.advanceTimersByTimeAsync(1_600);
    }
    if (handoff === 'native-final' || handoff === 'lifecycle-fallback' || handoff === 'embedded-after-final') {
      expect(controller.state.chatSending).toBe(false);
      expect(controller.shouldSubmitFollowup(sessionKey)).toBe(true);
      expect(projectTurnItems(controller.state.transcript.activeTurn, false, null, controller.state.runActivity)
        .at(-1)).toMatchObject({ kind: 'waiting', stage: 'waiting-continuation' });
    }

    const successor = { runId: 'native-successor', lifecycleGeneration: 'successor-generation' };
    if (handoff === 'native-snapshot' || handoff === 'embedded-snapshot' || handoff === 'embedded-after-final') {
      const recovery = controller as unknown as { applyInFlightRunSnapshot: (
        run: { runId: string }, key: string, physicalId: string, requestRunId: string | null,
        native: { sessionId: string; hasActiveRun: boolean; activeRunIds?: string[] },
      ) => void };
      const requestRunId = controller.state.chatRunId;
      recovery.applyInFlightRunSnapshot(successor, sessionKey, 'physical-session', requestRunId, {
        sessionId: 'physical-session', hasActiveRun: true, activeRunIds: [previous.runId, successor.runId],
      });
      expect(controller.state.chatRunId).toBe(requestRunId);
      recovery.applyInFlightRunSnapshot(successor, sessionKey, 'physical-session', requestRunId, {
        sessionId: 'physical-session', hasActiveRun: true,
        ...(handoff === 'native-snapshot' ? { activeRunIds: [successor.runId] } : {}),
      });
      expect(controller.state.chatRunId).toBe(successor.runId);
    } else {
      emit('lifecycle', { phase: 'start' }, successor);
    }
    emit('assistant', { text: 'Continuation of the delegated work' }, successor);

    expect(previous.runId).toBe('run-progress');
    expect(previous.toolById.get('yield-call')?.status).toBe('completed');
    expect(controller.state.transcript.activeTurn).toMatchObject({ runId: successor.runId, items: [
      expect.objectContaining({ type: 'content', text: 'Continuation of the delegated work' }),
    ] });
    expect(controller.state.runActivity?.stage).toBe('responding');
    expect(controller.shouldSubmitFollowup(sessionKey)).toBe(false);
  });

  test.each([
    { beforeYield: 'missing', isError: false, expectedStatus: 'completed' },
    { beforeYield: 'running', isError: true, expectedStatus: 'failed' },
    { beforeYield: 'cancelled', isError: false, expectedStatus: 'cancelled' },
  ])('restores the late native nested result after Yield ($beforeYield)', ({ beforeYield, isError, expectedStatus }) => {
    emit('tool', { phase: 'start', name: 'tool_call', toolCallId: 'parent-tool' });
    if (beforeYield !== 'missing') emit('tool', { phase: 'start', name: 'read', toolCallId: 'nested-tool' });
    if (beforeYield === 'running') {
      emit('tool', { phase: 'update', name: 'read', toolCallId: 'nested-tool', partialResult: 'in progress' });
    }
    if (beforeYield === 'cancelled') emit('tool', { phase: 'cancel', name: 'read', toolCallId: 'nested-tool' });
    handle({ event: 'chat', payload: { sessionKey, runId: 'run-progress', state: 'final', yielded: true } });
    expect(controller.state.runActivity?.stage).toBe('waiting-continuation');
    expect(controller.state.chatSending).toBe(false);
    handle({ event: 'session.message', payload: {
      sessionKey, sessionId: 'physical-session', hasActiveRun: false, runId: 'run-progress',
      messageSeq: 2, message: {
        role: 'custom', customType: 'openclaw.nested-tool.v1', display: true, excludeFromContext: true,
        timestamp: 1_000, __openclaw: { id: 'nested-result', seq: 2, runId: 'run-progress' },
        content: [
          { type: 'toolCall', id: 'nested-tool', name: 'read', parentToolCallId: 'parent-tool' },
          { type: 'toolResult', role: 'toolResult', toolCallId: 'nested-tool', toolName: 'read',
            parentToolCallId: 'parent-tool', isError, content: [{ type: 'text', text: 'result' }] },
        ],
      },
    } });

    expect(controller.state.transcript.activeTurn?.toolById.get('nested-tool')).toMatchObject({
      status: expectedStatus, output: 'result', presentation: { parentToolCallId: 'parent-tool' },
    });
    expect(controller.state.chatMessages).toContainEqual(expect.objectContaining({
      __openclaw: expect.objectContaining({ id: 'nested-result' }),
    }));
  });

  test('keeps hidden model output active without inventing tool identity or character counts', () => {
    emit('run_status', { phase: 'starting_model' });
    for (let index = 1; index <= 65; index++) {
      vi.setSystemTime(1_000 + index * 1_000);
      emit('item', requestActivityItem());
    }

    expect(controller.state.runActivity).toMatchObject({
      stage: 'receiving-model', hasRunningTool: false,
      lastAgentEventAt: 66_000, lastModelActivityAt: 66_000,
      progress: { kind: 'model-activity' },
    });
    expect(controller.state.runActivity?.progress).not.toHaveProperty('receivedChars');
    expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected', now: 66_000,
    })).toBeNull();
    const items = projectTurnItems(
      controller.state.transcript.activeTurn, true, null, controller.state.runActivity,
    );
    const waiting = items[items.length - 1];
    expect(waiting).toMatchObject({ kind: 'waiting', stage: 'receiving-model' });
    expect(runProgressDetail(controller.state.runActivity!, 66_000)).toBeTruthy();
  });

  test('retains counted model observations when generic request activity follows', () => {
    emit('item', progressItem({ kind: 'model', receivedChars: 500 }));
    vi.setSystemTime(2_000);
    emit('item', requestActivityItem());
    expect(controller.state.runActivity).toMatchObject({
      stage: 'receiving-model', lastModelActivityAt: 2_000,
      progress: { kind: 'model-stream', receivedChars: 500 },
    });
  });

  test('rejects stale and foreign request activity through the same native ownership gates', () => {
    emit('run_status', { phase: 'starting_model' });
    for (const override of [
      { runId: 'old-run' }, { sessionId: 'old-session' },
      { lifecycleGeneration: 'old-generation' },
      { sessionKey: 'agent:main:justdo:another-session' }, { seq: 1 },
    ]) emit('item', requestActivityItem(), override);
    expect(controller.state.runActivity?.stage).toBe('starting-model');
  });

  test.each([
    ['preparing_workspace', 'preparing-workspace'],
    ['preparing_context', 'preparing'],
    ['memory_flushing', 'memory-flushing'],
    ['starting_model', 'starting-model'],
  ])('renders the native %s stage', (phase, stage) => {
    emit('run_status', { phase });
    expect(controller.state.runActivity?.stage).toBe(stage);
    const items = projectTurnItems(
      controller.state.transcript.activeTurn,
      true,
      null,
      controller.state.runActivity,
    );
    expect(items[items.length - 1]).toMatchObject({ kind: 'waiting', stage });
  });

  test('keeps long arguments active without pretending that the tool has started', () => {
    for (let index = 0; index < 80; index++) {
      vi.setSystemTime(1_000 + index * 500);
      emit(
        'item',
        progressItem({
          kind: 'tool-input',
          name: 'write',
          toolCallId: 'call-1',
          receivedChars: index * 1_000,
        }),
      );
      emit('tool', {
        phase: 'input_delta',
        name: 'write',
        toolCallId: 'call-1',
        diff: { added: index, removed: 0 },
      });
    }
    expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      hasRunningTool: false,
      progress: { receivedChars: 79_000, toolCallId: 'call-1' },
    });
    expect(
      projectWaitingStatus({
        activity: controller.state.runActivity,
        transportStatus: 'connected',
      }),
    ).toBeNull();
    emit(
      'item',
      progressItem({
        kind: 'tool-input',
        name: 'write',
        toolCallId: 'call-1',
        receivedChars: 80_000,
        complete: true,
      }),
    );
    expect(controller.state.runActivity?.stage).toBe('preparing-tool');
    emit('tool', {
      phase: 'start',
      name: 'write',
      toolCallId: 'call-1',
      args: { path: 'fixture.txt' },
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      hasRunningTool: true,
      progress: { kind: 'tool' },
    });
  });

  test('shows the native retry count and countdown, then clears them when work resumes', () => {
    emit('run_status', {
      phase: 'retrying',
      reason: 'overloaded',
      retryAttempt: 2,
      maxRetries: 3,
      delayMs: 8_000,
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'retrying',
      retryAttempt: 2,
      maxRetries: 3,
      retryAt: 9_000,
    });
    expect(runProgressDetail(controller.state.runActivity!, 5_000)).toContain('4');
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    expect(controller.state.runActivity).toMatchObject({ stage: 'receiving-model' });
    expect(controller.state.runActivity).not.toHaveProperty('retryAt');
    expect(controller.state.runActivity).not.toHaveProperty('retryAttempt');
  });

  test('updates model counters without alternating a visible thinking/reply label', () => {
    emit('thinking', { text: 'Synthetic public thinking' });
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'thinking',
      progress: { receivedChars: 150 },
    });
    emit('assistant', { text: 'Synthetic visible reply' });
    emit('item', progressItem({ kind: 'model', receivedChars: 200 }));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'responding',
      progress: { receivedChars: 200 },
    });
  });

  test('surfaces public tool progress and command output without another transcript copy', () => {
    emit('tool', {
      phase: 'start',
      name: 'exec',
      toolCallId: 'command-1',
      args: { command: 'synthetic test' },
    });
    emit('item', {
      kind: 'tool',
      phase: 'update',
      itemId: 'tool:command-1',
      toolCallId: 'command-1',
      progressText: 'Running validation',
    });
    expect(controller.state.runActivity?.progress).toMatchObject({
      kind: 'tool',
      summary: 'Running validation',
    });
    emit('command_output', { toolCallId: 'command-1', output: 'test output', phase: 'delta' });
    expect(controller.state.runActivity?.progress).toMatchObject({ kind: 'tool', outputChars: 11 });
    expect(
      controller.state.transcript.activeTurn?.items.filter(item => item.type === 'tool'),
    ).toHaveLength(1);
    emit('tool', { phase: 'result', toolCallId: 'command-1', result: 'Completed' });
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
    expect(controller.state.runActivity).not.toHaveProperty('progress');
  });

  test('preserves native ownership and rejects stale or unrelated progress', () => {
    emit('run_status', { phase: 'starting_model' });
    for (const override of [
      { runId: 'old-run' },
      { sessionId: 'old-session' },
      { lifecycleGeneration: 'old-generation' },
      { sessionKey: 'agent:main:justdo:another-session' },
      { seq: 1 },
    ])
      emit('item', progressItem({ kind: 'model', receivedChars: 3 }), override);
    expect(controller.state.runActivity?.stage).toBe('starting-model');
    handle({
      event: 'chat',
      payload: {
        sessionKey,
        runId: 'run-progress',
        state: 'final',
        message: { role: 'assistant', content: 'Done' },
      },
    });
    emit('item', progressItem({ kind: 'model', receivedChars: 1 }));
    expect(controller.state.runActivity).toBeNull();
    expect(controller.state.chatSending).toBe(false);
  });

  test('shows native compaction without a stalled-model notice', () => {
    emit('compaction', { phase: 'start', eventId: 'compaction-1' });
    expect(controller.state.runActivity?.stage).toBe('compacting');
    vi.setSystemTime(120_000);
    expect(
      projectWaitingStatus({
        activity: controller.state.runActivity,
        transportStatus: 'connected',
      }),
    ).toBeNull();
    emit('compaction', { phase: 'end', eventId: 'compaction-1' });
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
  });

  test('restores progress through ordinary native snapshots without rewinding newer live work', () => {
    const applySnapshot = (
      controller as unknown as {
        applyInFlightRunSnapshot(
          snapshot: unknown,
          key: string,
          id: string,
          runId: string,
          info: unknown,
        ): void;
      }
    ).applyInFlightRunSnapshot.bind(controller);
    const replay = (seq: number, stream: string, data: Record<string, unknown>, overrides = {}) =>
      applySnapshot(
        {
          runId: 'run-progress',
          events: [
            {
              runId: 'run-progress',
              sessionKey,
              sessionId: 'physical-session',
              lifecycleGeneration: 'generation-current',
              seq,
              stream,
              ts: Date.now(),
              data,
              ...overrides,
            },
          ],
        },
        sessionKey,
        'physical-session',
        'run-progress',
        { hasActiveRun: true, activeRunIds: ['run-progress'] },
      );
    replay(
      10,
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      progress: { receivedChars: 5_000 },
    });
    vi.setSystemTime(30_000);
    replay(11, 'item', requestActivityItem(1_250));
    expect(controller.state.runActivity).toMatchObject({
      stage: 'generating-tool-input',
      progress: { receivedChars: 5_000 },
      lastModelActivityAt: 1_250,
    });
    expect(projectWaitingStatus({
      activity: controller.state.runActivity, transportStatus: 'connected', now: 30_000,
    })).not.toBeNull();
    emit('thinking', { text: 'Older queued visible text' }, { seq: 5 });
    expect(controller.state.runActivity?.stage).toBe('generating-tool-input');
    emit('tool', { phase: 'start', toolCallId: 'call-1', name: 'write', args: {} }, { seq: 12 });
    expect(controller.state.runActivity?.stage).toBe('running-tool');
    replay(11, 'item', requestActivityItem(1_250));
    expect(controller.state.runActivity?.lastModelActivityAt).toBe(30_000);
    replay(
      10,
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    replay(
      20,
      'run_status',
      { phase: 'starting_model' },
      { lifecycleGeneration: 'old-generation' },
    );
    replay(21, 'run_status', { phase: 'starting_model' }, { sessionId: 'old-session' });
    expect(controller.state.runActivity?.stage).toBe('running-tool');
    expect(
      controller.state.transcript.activeTurn?.items.filter(item => item.type === 'tool'),
    ).toHaveLength(1);
  });

  test('keeps background progress current after the tool starts and returns', async () => {
    emit(
      'item',
      progressItem({
        kind: 'tool-input',
        toolCallId: 'call-1',
        name: 'write',
        receivedChars: 5_000,
      }),
    );
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;
    emit('tool', { phase: 'start', toolCallId: 'call-1', name: 'write', args: {} });
    emit('tool', { phase: 'result', toolCallId: 'call-1', name: 'write', result: 'Done' });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;
    expect(controller.state.runActivity?.stage).toBe('waiting-model');
    expect(controller.state.runActivity).not.toHaveProperty('progress');
    expect(controller.state.transcript.activeTurn?.toolById.get('call-1')?.status).toBe(
      'completed',
    );
  });

  test.each([false, true])(
    'retains background request activity with existing tool counters: %s',
    async detailed => {
      if (detailed) emit('item', progressItem({
        kind: 'tool-input', toolCallId: 'call-1', name: 'tool_call', receivedChars: 5_000,
      }));
      controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
      const away = controller.switchSession('agent:main:justdo:another-session');
      await vi.advanceTimersByTimeAsync(5_000);
      await away;
      const observedAt = Date.now();
      emit('item', requestActivityItem(observedAt));
      const returned = controller.switchSession(sessionKey);
      await vi.advanceTimersByTimeAsync(5_000);
      await returned;

      expect(controller.state.runActivity).toMatchObject({
        stage: detailed ? 'generating-tool-input' : 'receiving-model',
        lastModelActivityAt: observedAt,
        progress: detailed
          ? { kind: 'tool-input', receivedChars: 5_000 }
          : { kind: 'model-activity' },
      });
      expect(controller.state.transcript.activeTurn?.toolById.size).toBe(0);
    },
  );

  test('does not wake a silent announce run for content-free native progress', () => {
    controller.disconnect();
    controller = new ChatController();
    controller.state.sessionKey = sessionKey;
    controller.state.currentSessionId = 'physical-session';
    controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
    handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
    const listener = vi.fn();
    controller.onStream(listener);
    const owner = { runId: 'announce:v1:agent:main:subagent:silent-child' };

    emit('lifecycle', { phase: 'start' }, owner);
    emit('run_status', { phase: 'starting_model' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 0 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_RE' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 8 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_REPLY' }, owner);
    emit('lifecycle', { phase: 'end' }, owner);

    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.runActivity).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  test('starts a dormant announce when visible content follows many content-free updates', () => {
    controller.disconnect();
    controller = new ChatController();
    controller.state.sessionKey = sessionKey;
    controller.state.currentSessionId = 'physical-session';
    controller.state.transcript = createChatTranscriptState(sessionKey, 'physical-session');
    handle = (controller as unknown as { handleEvent: typeof handle }).handleEvent.bind(controller);
    const owner = { runId: 'announce:v1:agent:main:subagent:visible-child' };

    emit('lifecycle', { phase: 'start' }, owner);
    vi.setSystemTime(5_000);
    for (let index = 0; index < 150; index++)
      emit('item', progressItem({ kind: 'model', receivedChars: index }), owner);
    expect(controller.state.transcript.activeTurn).toBeNull();
    emit('assistant', { text: 'Visible child summary' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 200 }), owner);

    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe(owner.runId);
    expect(controller.state.transcript.activeTurn).toMatchObject({
      runId: owner.runId,
      startedAt: 1_000,
      items: [expect.objectContaining({ type: 'content', text: 'Visible child summary' })],
    });
    expect(controller.state.runActivity).toMatchObject({
      stage: 'responding',
      progress: { kind: 'model-stream', receivedChars: 200 },
    });
  });

  test('does not wake a cached session from dormant-announce progress metadata', async () => {
    handle({
      event: 'chat',
      payload: {
        sessionKey,
        runId: 'run-progress',
        state: 'final',
        message: { role: 'assistant', content: 'Done' },
      },
    });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    const owner = { runId: 'announce:v1:agent:main:subagent:silent-child' };
    emit('run_status', { phase: 'starting_model' }, owner);
    emit('item', progressItem({ kind: 'model', receivedChars: 8 }), owner);
    emit('item', requestActivityItem(), owner);
    emit('assistant', { text: 'NO_REPLY' }, owner);
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.runActivity).toBeNull();
  });

  test('retains command-output progress received while the session is in the background', async () => {
    emit('tool', { phase: 'start', toolCallId: 'command-1', name: 'exec', args: {} });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('command_output', { toolCallId: 'command-1', output: 'test output', phase: 'delta' });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      progress: { kind: 'tool', toolCallId: 'command-1', outputChars: 11 },
    });
  });

  test('keeps background public progress attached to the reporting parallel tool', async () => {
    emit('tool', { phase: 'start', toolCallId: 'command-1', name: 'exec', args: {} });
    emit('tool', { phase: 'start', toolCallId: 'command-2', name: 'exec', args: {} });
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('item', {
      kind: 'tool',
      phase: 'update',
      itemId: 'tool:command-1',
      toolCallId: 'command-1',
      progressText: 'First operation continuing',
    });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'running-tool',
      progress: {
        kind: 'tool',
        toolCallId: 'command-1',
        summary: 'First operation continuing',
      },
    });
  });

  test('retains format-retry progress received while the session is in the background', async () => {
    emit('item', progressItem({ kind: 'model', receivedChars: 150 }));
    controller.state.client!.request = vi.fn().mockResolvedValue({ messages: [] });
    const away = controller.switchSession('agent:main:justdo:another-session');
    await vi.advanceTimersByTimeAsync(5_000);
    await away;

    emit('lifecycle', {
      phase: 'progress',
      stage: 'retrying',
      reason: 'tool_call_format',
      retryAttempt: 3,
      maxRetries: 3,
      at: Date.now(),
    });
    const returned = controller.switchSession(sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await returned;

    expect(controller.state.runActivity).toMatchObject({
      stage: 'retrying',
      retryReason: 'tool_call_format',
      retryAttempt: 3,
      maxRetries: 3,
    });
    expect(controller.state.runActivity).not.toHaveProperty('progress');
  });

  test('rejects malformed counters and prototype keys', () => {
    expect(readRunProgress('item', progressItem({ kind: 'model' }))).toBeNull();
    for (const receivedChars of [-1, Infinity, 1.5, '30']) {
      expect(readRunProgress('item', progressItem({ kind: 'model', receivedChars }))).toBeNull();
    }
    expect(readRunProgress('run_status', { phase: '__proto__' })).toBeNull();
    expect(
      readRunProgress('item', progressItem({ kind: 'tool-input', receivedChars: 10 })),
    ).toBeNull();
    expect(
      readRunProgress('item', {
        ...progressItem({ kind: 'model', receivedChars: 10 }),
        itemId: 'unrelated-status',
      }),
    ).toBeNull();
  });

  test('accepts only the exact request-activity envelope with its original timestamp', () => {
    expect(readRunProgress('item', requestActivityItem(1_250))).toEqual({
      stage: 'receiving-model', modelActivity: true,
      progress: { kind: 'model-activity' }, at: 1_250,
    });
    const invalid: Record<string, unknown>[] = [
      { itemId: 'other-status' }, { kind: 'tool' }, { phase: 'end' }, { status: 'completed' },
      { progress: { kind: 'model' } }, { progress: { kind: 'tool-input' } },
      { progress: [] }, { progress: null },
      ...[undefined, -1, Infinity, 1.5, '1250'].map(at => ({ at })),
    ];
    for (const override of invalid) {
      expect(readRunProgress('item', { ...requestActivityItem(), ...override })).toBeNull();
    }
    expect(readRunProgress('lifecycle', requestActivityItem())).toBeNull();
    expect(readRunProgress('item', {
      ...progressItem({ kind: 'model-activity' }), at: 1_250,
    })).toBeNull();
  });
});
