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
  test('hides authoritative messages already represented by a running tool turn', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    const tool = {
      id: 'tool-1',
      runId: 'run-1',
      firstSeq: 2,
      lastSeq: 3,
      startedAt: 2,
      updatedAt: 3,
      type: 'tool' as const,
      status: 'completed' as const,
      toolCallId: 'call-yield-1',
      name: 'sessions_yield',
    };
    turn.items.push(tool);
    turn.toolById.set(tool.toolCallId, tool);
    const previous = { role: 'assistant', content: 'Earlier progress.' };
    const persistedAssistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First batch completed 3/5.' },
        { type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' },
      ],
    };
    const persistedToolResult = {
      role: 'toolResult',
      toolCallId: 'call-yield-1',
      content: 'yielded',
    };

    expect(
      projectPersistedMessagesForActiveTurn(
        [previous, persistedAssistant, persistedToolResult],
        turn,
      ),
    ).toEqual([previous]);
  });

  test('keeps authoritative messages unrelated to the running tool turn', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    const unrelated = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-older', name: 'read' }],
    };

    expect(projectPersistedMessagesForActiveTurn([unrelated], turn)).toEqual([unrelated]);
  });

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

  test('hides a persisted Tool duplicate until a settled active turn is retired', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    turn.status = 'final';
    const tool = {
      id: 'tool-1',
      runId: 'run-1',
      firstSeq: 2,
      lastSeq: 3,
      startedAt: 2,
      updatedAt: 3,
      type: 'tool' as const,
      status: 'completed' as const,
      toolCallId: 'call-yield-1',
      name: 'sessions_yield',
      output: 'joined',
    };
    turn.items.push(tool);
    turn.toolById.set(tool.toolCallId, tool);
    const unrelated = { role: 'assistant', content: 'Earlier progress.' };
    const persistedCall = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' }],
    };
    const persistedResult = {
      role: 'toolResult',
      toolCallId: 'call-yield-1',
      content: 'joined',
    };

    expect(
      projectPersistedMessagesForActiveTurn([unrelated, persistedCall, persistedResult], turn),
    ).toEqual([unrelated]);
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

  test('keeps authoritative tool calls exactly once after retiring the live projection', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    turn.status = 'final';
    const persisted = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'dispatch work' },
        { type: 'text', text: 'Starting the worker.' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'sessions_spawn',
          arguments: { task: 'Generate the PDF' },
        },
      ],
    };

    expect(retireSettledActiveTurn(state, [persisted])).toBe(true);
    expect(projectPersistedMessagesForActiveTurn([persisted], state.activeTurn)).toEqual([
      persisted,
    ]);
    expect(
      persisted.content.filter(
        block => block.type === 'toolCall' && 'id' in block && block.id === 'call-1',
      ),
    ).toHaveLength(1);
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
