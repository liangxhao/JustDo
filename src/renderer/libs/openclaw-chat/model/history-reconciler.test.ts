import { describe, expect, test } from 'vitest';

import { createChatTranscriptState } from './chat-transcript-state';
import { extractToolCallIds, reconcileHistory } from './history-reconciler';

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
});
