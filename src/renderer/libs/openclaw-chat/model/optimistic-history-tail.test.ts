import { describe, expect, test } from 'vitest';

import { beginAssistantTurn, createChatTranscriptState } from './chat-transcript-state';
import {
  markOptimisticHistoryTail,
  projectPersistedMessagesForActiveTurn,
  retireSettledActiveTurn,
} from './optimistic-history-tail';

const dependencies = {
  now: () => 1,
  createId: (prefix: string) => `${prefix}-1`,
};

describe('optimistic history tail ownership', () => {
  test('shows a completed active turn instead of its optimistic history fallback', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    turn.status = 'final';
    const user = { role: 'user', content: 'show files' };
    const optimistic = markOptimisticHistoryTail({
      role: 'assistant',
      content: 'done\nMEDIA:C:\\files\\image.png',
    });

    expect(projectPersistedMessagesForActiveTurn([user, optimistic], turn)).toEqual([user]);
  });

  test('retires the completed active turn after authoritative history replaces the fallback', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    turn.status = 'final';
    const persisted = {
      role: 'assistant',
      provider: 'openclaw',
      model: 'gateway-injected',
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', url: '/api/chat/media/outgoing/session/image/full' },
      ],
    };

    expect(retireSettledActiveTurn(state, [persisted])).toBe(true);
    expect(state.activeTurn).toBeNull();
  });

  test('keeps the completed active turn while history has not caught up', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    turn.status = 'final';
    const optimistic = markOptimisticHistoryTail({ role: 'assistant', content: 'done' });

    expect(retireSettledActiveTurn(state, [optimistic])).toBe(false);
    expect(state.activeTurn).toBe(turn);
  });
});
