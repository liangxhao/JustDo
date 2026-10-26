import { afterEach, describe, expect, it, vi } from 'vitest';

import { beginAssistantTurn } from '../../model/chat-transcript-state';
import { ChatController } from '../chat-controller';
import { readChatContextUsageSnapshot } from '../chat-controller-support';

const sessionKey = 'agent:main:justdo:context-test';

afterEach(() => vi.useRealTimers());

function setup() {
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = 'sid-current';
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = 'sid-current';
  const notify = vi.fn();
  controller.subscribe(notify);
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);
  const row = {
    sessionKey,
    sessionId: 'sid-current',
    updatedAt: 100,
    totalTokens: 80_000,
    totalTokensFresh: true,
    contextTokens: 200_000,
    modelProvider: 'openai',
    model: 'gpt-test',
  };
  handleEvent({ event: 'sessions.changed', payload: row });
  notify.mockClear();
  return { controller, handleEvent, row, notify };
}

describe('Gateway context usage projections', () => {
  it('projects budget changes even when the token snapshot and timestamp stay the same', () => {
    const { controller, handleEvent, row, notify } = setup();
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        session: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 100_000 } },
      },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBe(100_000);
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 120_000 } },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBe(120_000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('drops a cleared prompt budget and restores the native context limit', () => {
    const { controller, handleEvent, row } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, contextBudgetStatus: { promptBudgetBeforeReserve: 100_000 } },
    });
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, updatedAt: 200, contextBudgetStatus: null },
    });
    expect(controller.state.contextUsage?.promptBudgetTokens).toBeUndefined();
    expect(controller.state.contextUsage?.contextTokens).toBe(200_000);
  });

  it('retires accurate usage when Gateway projects unavailable usage without totalTokens', () => {
    const { controller, handleEvent, row } = setup();
    const { totalTokens: _totalTokens, ...unknownRow } = row;
    handleEvent({
      event: 'sessions.changed',
      payload: { ...unknownRow, updatedAt: 200, totalTokensFresh: false },
    });
    expect(controller.state.contextUsage?.totalTokens).toBeNull();
    handleEvent({ event: 'sessions.changed', payload: { ...row, updatedAt: 150 } });
    expect(controller.state.contextUsage?.totalTokens).toBeNull();
    handleEvent({
      event: 'sessions.changed',
      payload: { ...row, updatedAt: 300, totalTokens: 12_000 },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(12_000);
  });

  it('preserves usage for lifecycle patches that omit usage', () => {
    const { controller, handleEvent } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-current',
        updatedAt: 200,
        phase: 'lifecycle',
        status: 'running',
      },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
  });

  it('rejects a late message usage snapshot from a previous native session', () => {
    const { controller, handleEvent, row, notify } = setup();
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        session: { ...row, sessionId: 'sid-old', updatedAt: 200, totalTokens: 190_000 },
      },
    });
    expect(controller.state.contextUsage?.sessionId).toBe('sid-current');
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps approximate totals and ignores invalid budget fields', () => {
    expect(
      readChatContextUsageSnapshot(
        {
          totalTokens: 42_000,
          totalTokensFresh: false,
          contextBudgetStatus: { promptBudgetBeforeReserve: Infinity },
        },
        sessionKey,
      ),
    ).toMatchObject({ totalTokens: 42_000, totalTokensFresh: false });
    expect(readChatContextUsageSnapshot({ totalTokens: 0 }, sessionKey)?.totalTokens).toBe(0);
  });

  it('rejects old native identity carried only in the message envelope', () => {
    const { controller, handleEvent, row } = setup();
    const { sessionId: _sessionId, ...session } = row;
    handleEvent({
      event: 'session.message',
      payload: {
        sessionKey,
        sessionId: 'sid-old',
        session: { ...session, updatedAt: 200, totalTokens: 190_000 },
      },
    });
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
  });

  it('clears usage when a reset keeps the same public session identity', () => {
    const { controller, handleEvent, notify } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { sessionKey, sessionId: 'sid-current', reason: 'reset' },
    });
    expect(controller.state.contextUsage).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].contextUsage).toBeNull();
    controller.disconnect();
  });

  it('immediately publishes cleared usage when reset rotates native identity', () => {
    const { controller, handleEvent, notify } = setup();
    handleEvent({
      event: 'sessions.changed',
      payload: { sessionKey, sessionId: 'sid-new', reason: 'reset' },
    });
    expect(controller.state.contextUsage).toBeNull();
    expect(controller.state.currentSessionId).toBe('sid-new');
    expect(notify).toHaveBeenCalledTimes(1);
    controller.disconnect();
  });

  it('adopts a completed compaction successor only after authoritative history arrives', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    let resolveHistory!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => (resolveHistory = resolve)));
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.chatMessages = [{ role: 'user', content: 'previous history' }];
    const successor = { ...row, key: sessionKey, sessionId: 'sid-successor', totalTokens: 20_000 };
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    expect(controller.state.currentSessionId).toBe('sid-current');
    expect(controller.state.chatMessages).toEqual([{ role: 'user', content: 'previous history' }]);
    expect(request).toHaveBeenCalledWith('chat.history', expect.objectContaining({ sessionKey }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const messages = [{ role: 'user', content: 'successor history' }];
    resolveHistory({ messages, sessionId: 'sid-successor', sessionInfo: successor });
    await vi.runAllTimersAsync();
    expect(controller.state.currentSessionId).toBe('sid-successor');
    expect(controller.state.contextUsage?.totalTokens).toBe(20_000);
    expect(controller.state.chatMessages).toEqual(messages);
    controller.state.client = null;
    controller.disconnect();
  });

  it('keeps the live turn across an authoritative successor that owns the same run', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    const turn = beginAssistantTurn(
      controller.state.transcript,
      { runId: 'run-live' },
      {
        now: () => 100,
        createId: prefix => `${prefix}-live`,
      },
    );
    turn.items.push({
      type: 'content',
      id: 'answer-live',
      runId: 'run-live',
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 100,
      updatedAt: 100,
      status: 'streaming',
      sourceMode: 'snapshot',
      text: 'visible live answer',
    });
    controller.state.chatSending = true;
    controller.state.chatRunId = turn.runId;
    const successor = {
      ...row,
      key: sessionKey,
      sessionId: 'sid-successor',
      totalTokens: 20_000,
      hasActiveRun: true,
      activeRunIds: ['run-live'],
    };
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: 'successor history' }],
      sessionId: 'sid-successor',
      sessionInfo: successor,
    });
    controller.state.client = { request } as never;
    controller.state.connected = true;
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    await vi.runAllTimersAsync();
    expect(controller.state.currentSessionId).toBe('sid-successor');
    expect(controller.state.transcript.activeTurn).toBe(turn);
    expect(turn.sessionId).toBe('sid-successor');
    expect(turn.items[0]).toMatchObject({ text: 'visible live answer', status: 'streaming' });
    expect(controller.state.chatRunId).toBe('run-live');
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatMessages).toEqual([{ role: 'user', content: 'successor history' }]);
    controller.state.client = null;
    controller.disconnect();
  });

  it.each([
    { compacted: false },
    {
      compacted: true,
      session: { key: 'agent:other:justdo:context-test', sessionId: 'sid-successor' },
    },
    { compacted: true, session: { key: sessionKey, sessionId: 'sid-unrelated' } },
    { compacted: true, session: undefined },
  ])('rejects an unverified compaction rotation %j', async patch => {
    const { controller, handleEvent, row } = setup();
    const request = vi.fn();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        session: { ...row, key: sessionKey, sessionId: 'sid-successor' },
        ...patch,
      },
    });
    expect(controller.state.currentSessionId).toBe('sid-current');
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
    expect(request).not.toHaveBeenCalled();
    controller.state.client = null;
    controller.disconnect();
  });

  it('rejects history that no longer proves the notified compaction successor', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    const successor = { ...row, key: sessionKey, sessionId: 'sid-successor' };
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: 'unrelated history' }],
      sessionId: 'sid-unrelated',
      sessionInfo: { ...successor, sessionId: 'sid-unrelated' },
    });
    controller.state.client = { request } as never;
    controller.state.connected = true;
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    await vi.runAllTimersAsync();
    expect(controller.state.currentSessionId).toBe('sid-current');
    expect(controller.state.contextUsage?.totalTokens).toBe(80_000);
    expect(controller.state.chatMessages).toEqual([]);
    expect(controller.state.chatLoading).toBe(false);
    controller.state.client = null;
    controller.disconnect();
  });

  it('clears predecessor usage when successor history has no usage projection', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent } = setup();
    const successor = { key: sessionKey, sessionId: 'sid-successor' };
    controller.state.client = {
      request: vi.fn().mockResolvedValue({
        messages: [],
        sessionId: 'sid-successor',
        sessionInfo: successor,
      }),
    } as never;
    controller.state.connected = true;
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    await vi.runAllTimersAsync();
    expect(controller.state.currentSessionId).toBe('sid-successor');
    expect(controller.state.contextUsage).toBeNull();
    controller.state.client = null;
    controller.disconnect();
  });

  it('does not carry an unowned live turn into the compaction successor', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    beginAssistantTurn(
      controller.state.transcript,
      { runId: 'run-predecessor' },
      {
        now: () => 100,
        createId: prefix => `${prefix}-previous`,
      },
    );
    controller.state.chatSending = true;
    controller.state.chatRunId = 'run-predecessor';
    controller.state.compactionInFlight = true;
    const successor = { ...row, key: sessionKey, sessionId: 'sid-successor', hasActiveRun: false };
    controller.state.client = {
      request: vi.fn().mockResolvedValue({
        messages: [],
        sessionId: 'sid-successor',
        sessionInfo: successor,
      }),
    } as never;
    controller.state.connected = true;
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    await vi.runAllTimersAsync();
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.compactionInFlight).toBe(false);
    controller.state.client = null;
    controller.disconnect();
  });

  it('ignores a compaction successor snapshot after an explicit reset changes generation', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    let resolveHistory!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => (resolveHistory = resolve)));
    controller.state.client = { request } as never;
    controller.state.connected = true;
    const successor = { ...row, key: sessionKey, sessionId: 'sid-successor' };
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    handleEvent({
      event: 'sessions.changed',
      payload: { sessionKey, sessionId: 'sid-reset', reason: 'reset' },
    });
    resolveHistory({ messages: [], sessionId: 'sid-successor', sessionInfo: successor });
    // Settle the accepted request before the reset's deferred fresh read.
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.currentSessionId).toBe('sid-reset');
    expect(controller.state.contextUsage).toBeNull();
    controller.state.client = null;
    controller.disconnect();
  });

  it('reconciles a compaction successor queued behind an existing history read', async () => {
    vi.useFakeTimers();
    const { controller, handleEvent, row } = setup();
    let resolvePrevious!: (value: unknown) => void;
    const successor = { ...row, key: sessionKey, sessionId: 'sid-successor', totalTokens: 20_000 };
    const messages = [{ role: 'user', content: 'successor history' }];
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise(resolve => (resolvePrevious = resolve)))
      .mockResolvedValue({ messages, sessionId: 'sid-successor', sessionInfo: successor });
    controller.state.client = { request } as never;
    controller.state.connected = true;
    const previousLoad = controller.loadHistory();
    handleEvent({
      event: 'sessions.changed',
      payload: {
        sessionKey,
        sessionId: 'sid-successor',
        reason: 'compact',
        compacted: true,
        session: successor,
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    resolvePrevious({
      messages: [],
      sessionId: 'sid-current',
      sessionInfo: { ...row, key: sessionKey },
    });
    await previousLoad;
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.state.currentSessionId).toBe('sid-successor');
    expect(controller.state.contextUsage?.totalTokens).toBe(20_000);
    expect(controller.state.chatMessages).toEqual(messages);
    controller.state.client = null;
    controller.disconnect();
  });

  it.each([false, true])(
    'publishes successor history before %s live-tool or custody notifications',
    async withLiveTool => {
      vi.useFakeTimers();
      const { controller, handleEvent, row } = setup();
      const messages: unknown[] = [{ role: 'user', content: 'successor history' }];
      if (withLiveTool) {
        const turn = beginAssistantTurn(
          controller.state.transcript,
          { runId: 'run-live' },
          {
            now: () => 100,
            createId: prefix => `${prefix}-live`,
          },
        );
        const tool = {
          type: 'tool' as const,
          id: 'tool-live',
          runId: 'run-live',
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 100,
          updatedAt: 100,
          status: 'running' as const,
          toolCallId: 'call-live',
          name: 'sessions_yield',
        };
        turn.items.push(tool);
        turn.toolById.set(tool.toolCallId, tool);
        controller.state.chatSending = true;
        controller.state.chatRunId = 'run-live';
        messages.push({
          role: 'assistant',
          runId: 'run-live',
          timestamp: 110,
          content: [
            {
              type: 'toolCall',
              id: 'call-live',
              name: 'sessions_yield',
              arguments: { task: 'wait' },
            },
          ],
        });
      }
      const successor = {
        ...row,
        key: sessionKey,
        sessionId: 'sid-successor',
        hasActiveRun: withLiveTool,
        activeRunIds: withLiveTool ? ['run-live'] : [],
      };
      const request = vi.fn().mockResolvedValue({
        messages,
        sessionId: 'sid-successor',
        sessionInfo: successor,
        ...(!withLiveTool ? { pendingInputs: { items: [], total: 0, queuedCount: 0 } } : {}),
      });
      controller.state.client = { request } as never;
      controller.state.connected = true;
      const observations: { sessionId: string | null; messages: unknown[] }[] = [];
      const observe = () =>
        observations.push({
          sessionId: controller.state.currentSessionId,
          messages: [...controller.state.chatMessages],
        });
      controller.subscribe(observe);
      controller.onStream(observe);
      handleEvent({
        event: 'sessions.changed',
        payload: {
          sessionKey,
          sessionId: 'sid-successor',
          reason: 'compact',
          compacted: true,
          session: successor,
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const successorObservations = observations.filter(
        observation => observation.sessionId === 'sid-successor',
      );
      expect(successorObservations.length).toBeGreaterThan(0);
      expect(successorObservations.every(observation => observation.messages.length > 0)).toBe(
        true,
      );
      expect(
        successorObservations.every(observation => observation.messages[0] === messages[0]),
      ).toBe(true);
      controller.state.client = null;
      controller.disconnect();
    },
  );
});
