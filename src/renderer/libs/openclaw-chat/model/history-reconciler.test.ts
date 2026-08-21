import { describe, expect, test } from 'vitest';

import { beginAssistantTurn, createChatTranscriptState } from './chat-transcript-state';
import {
  deterministicHistoryKey,
  extractToolCallIds,
  reconcileHistory,
} from './history-reconciler';

describe('history reconciliation', () => {
  test('finds provider spelling variants for Tool references', () => {
    expect([
      ...extractToolCallIds([{ content: [{ tool_call_id: 'a' }, { tool_use_id: 'b' }] }]),
    ]).toEqual(['a', 'b']);
  });

  test('rejects a stale shorter Gateway tail', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    state.historySource = 'gateway';
    state.persistedMessages = [
      { id: '1', role: 'user', content: 'hello' },
      { id: '2', role: 'assistant', content: 'complete' },
    ];
    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [{ id: '1', role: 'user', content: 'hello' }],
    });

    expect(result).toMatchObject({ accepted: false, reason: 'regressive-tail' });
    expect(state.persistedMessages).toHaveLength(2);
  });

  test('prevents fallback history from pruning Gateway-backed state', () => {
    const state = createChatTranscriptState('session-1', null);
    state.historySource = 'gateway';
    state.persistedMessages = [{ id: 'gateway' }];

    expect(
      reconcileHistory(state, {
        request: { sessionKey: 'session-1', sessionId: null, historyGeneration: 0 },
        source: 'sqlite-fallback',
        messages: [{ id: 'fallback' }],
      }),
    ).toMatchObject({ accepted: false, reason: 'lower-authority' });
  });

  test('invalidates an older request after a session generation change', () => {
    const state = createChatTranscriptState('session-1', null);
    state.historyGeneration = 2;

    expect(
      reconcileHistory(state, {
        request: { sessionKey: 'session-1', sessionId: null, historyGeneration: 1 },
        source: 'gateway',
        messages: [],
      }),
    ).toMatchObject({ accepted: false, reason: 'stale-request' });
  });

  test('keeps OpenClaw transcript identity stable across text changes and prepends', () => {
    const message = {
      role: 'assistant',
      content: 'first',
      __openclaw: { id: 'entry-1', seq: 7 },
    };
    const key = deterministicHistoryKey(message, 0);

    expect(deterministicHistoryKey({ ...message, content: 'updated' }, 19)).toBe(key);
  });

  test('rejects a shorter prefix by OpenClaw transcript identity even when text changed', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    state.historySource = 'gateway';
    state.persistedMessages = [
      { role: 'user', content: 'old', __openclaw: { seq: 1 } },
      { role: 'assistant', content: 'answer', __openclaw: { seq: 2 } },
    ];

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [{ role: 'user', content: 'edited', __openclaw: { seq: 1 } }],
    });

    expect(result).toMatchObject({ accepted: false, reason: 'regressive-tail' });
  });

  test('preserves an optimistic terminal tail until Gateway history replaces it', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const user = { role: 'user', content: 'hello', timestamp: 1000 };
    const optimisticFinal = {
      role: 'assistant',
      content: 'complete',
      timestamp: 2000,
      __justdoOptimisticHistoryTail: true,
    };
    state.persistedMessages = [user, optimisticFinal];

    const waiting = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [user],
      requestStartMessages: state.persistedMessages,
      currentMessages: state.persistedMessages,
    });

    expect(waiting).toMatchObject({
      accepted: true,
      messages: [user, optimisticFinal],
      preservedOptimisticTailCount: 1,
    });

    const persistedFinal = {
      role: 'assistant',
      content: 'complete with details',
      timestamp: 2100,
      __openclaw: { seq: 2 },
    };
    const settled = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [user, persistedFinal],
      requestStartMessages: state.persistedMessages,
      currentMessages: state.persistedMessages,
    });

    expect(settled).toMatchObject({
      accepted: true,
      messages: [user, persistedFinal],
      preservedOptimisticTailCount: 0,
    });
  });

  test('preserves the known prefix when an empty Gateway snapshot races an optimistic turn', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const previous = [
      { role: 'assistant', content: 'earlier answer', timestamp: 500 },
      {
        role: 'user',
        content: 'stop this run',
        timestamp: 1000,
        __justdoOptimisticHistoryTail: true,
      },
    ];
    state.persistedMessages = previous;

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [],
      requestStartMessages: previous,
      currentMessages: previous,
    });

    expect(result).toMatchObject({
      accepted: true,
      messages: previous,
      preservedOptimisticTailCount: 2,
    });
  });

  test('restores an optimistic user prompt before its interrupted overlay', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const user = {
      role: 'user',
      content: 'stop this run',
      timestamp: 1000,
      __justdoOptimisticHistoryTail: true,
    };
    const interrupted = {
      role: 'assistant',
      content: 'The run was interrupted.',
      timestamp: 1100,
      __justdoInterruptedOverlayId: 'session-1:run-1',
      __justdoOptimisticHistoryTail: true,
    };
    state.persistedMessages = [user, interrupted];

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [
        {
          ...interrupted,
          __justdoOptimisticHistoryTail: undefined,
        },
      ],
      requestStartMessages: state.persistedMessages,
      currentMessages: state.persistedMessages,
    });

    expect(result.accepted).toBe(true);
    expect(result.messages).toEqual([
      user,
      expect.objectContaining({
        role: 'assistant',
        __justdoInterruptedOverlayId: 'session-1:run-1',
      }),
    ]);
  });

  test('rejects a response overtaken by a concurrent visible update and requests catch-up', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const waiting = { role: 'assistant', content: 'waiting', timestamp: 1000 };
    const final = { role: 'assistant', content: 'complete', timestamp: 2000 };
    state.persistedMessages = [waiting, final];

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [waiting],
      requestStartMessages: [waiting],
      currentMessages: state.persistedMessages,
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: 'stale-concurrent-update',
      catchUp: 'deferred',
      messages: [waiting, final],
    });
  });

  test('accepts a concurrent update already covered by stable transcript identity', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const first = { role: 'user', content: 'hello', __openclaw: { seq: 1 } };
    const final = { role: 'assistant', content: 'complete', __openclaw: { seq: 2 } };
    state.persistedMessages = [first, final];

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [first, { ...final, content: 'complete with details' }],
      requestStartMessages: [first],
      currentMessages: state.persistedMessages,
    });

    expect(result).toMatchObject({
      accepted: true,
      messages: [first, { ...final, content: 'complete with details' }],
    });
  });

  test('keeps materialized lifecycle fallback until persisted history catches up', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const fallback = {
      role: 'assistant',
      content: 'materialized',
      __openclawStreamFallback: true,
    };
    state.persistedMessages = [fallback];

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [],
      requestStartMessages: state.persistedMessages,
      currentMessages: state.persistedMessages,
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: 'materialized-fallback',
      catchUp: 'deferred',
      messages: [fallback],
    });
  });

  test('rejects history admission while a newer active run owns the display', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const current = [{ role: 'user', content: 'new prompt' }];
    state.persistedMessages = current;

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [{ role: 'assistant', content: 'old answer' }],
      currentMessages: current,
      activeRun: true,
    });

    expect(result).toMatchObject({
      accepted: false,
      reason: 'active-run',
      catchUp: 'none',
      messages: current,
    });
  });

  test('retires a settled active turn when authoritative history takes over', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(
      state,
      { runId: 'run-1' },
      { now: () => 1000, createId: prefix => `${prefix}-1` },
    );
    turn.status = 'final';

    const result = reconcileHistory(state, {
      request: { sessionKey: 'session-1', sessionId: 'sid-1', historyGeneration: 0 },
      source: 'gateway',
      messages: [
        {
          role: 'assistant',
          content: 'persisted final',
          __openclaw: { seq: 1 },
        },
      ],
    });

    expect(result.activeTurnTakeover).toBe('retired');
    expect(state.activeTurn).toBeNull();
  });
});
