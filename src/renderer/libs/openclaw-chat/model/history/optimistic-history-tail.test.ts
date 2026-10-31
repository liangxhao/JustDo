import { describe, expect, test } from 'vitest';

import { beginAssistantTurn, createChatTranscriptState } from '../chat-transcript-state';
import {
  FAILED_RUN_MESSAGE_FLAG,
  withFailureDetailsForDisplay,
  withNativeFailureSummary,
} from '../turn/failed-run-message';
import {
  markOptimisticHistoryTail,
  projectInitialHistoryForActiveTurn,
  projectPersistedMessagesForActiveTurn,
  retireSettledActiveTurn,
} from './optimistic-history-tail';

const dependencies = {
  now: () => 1,
  createId: (prefix: string) => `${prefix}-1`,
};

describe('optimistic history tail ownership', () => {
  test('groups complete native diagnostics without interpreting their wording', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    turn.status = 'error';
    turn.items.push({
      id: 'terminal',
      runId: turn.runId,
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 1,
      updatedAt: 2,
      type: 'terminal',
      status: 'error',
      message: 'La requête ne peut pas aboutir.',
    });
    const failure = {
      role: 'system',
      content: 'Managed model credentials are unavailable.',
      errorMessage: 'Managed model credentials are unavailable.',
      stopReason: 'error',
      [FAILED_RUN_MESSAGE_FLAG]: true,
      __openclaw: { id: 'failure', runId: turn.runId },
    };
    expect(projectPersistedMessagesForActiveTurn([failure], turn)).toEqual([]);
    const warned = { ...failure, errorMessage: `⚠️ ${failure.errorMessage}` };
    expect(projectPersistedMessagesForActiveTurn([warned], turn)).toEqual([]);
    const identical = withNativeFailureSummary(failure, failure.errorMessage);
    const identicalDisplay = withFailureDetailsForDisplay(turn, [identical]);
    const identicalText = identicalDisplay?.items.find(item => item.type === 'terminal')?.message;
    expect(identicalText?.split(failure.errorMessage)).toHaveLength(2);
    const fallback = withNativeFailureSummary(
      failure,
      'The agent run failed before producing a reply.',
    );
    expect(projectPersistedMessagesForActiveTurn([fallback], turn)).toEqual([]);
    const specific = withNativeFailureSummary(
      failure,
      'The AI service rejected this request. Check your account permissions.',
    );
    expect(projectPersistedMessagesForActiveTurn([specific], turn)).toEqual([]);
    expect(withFailureDetailsForDisplay(turn, [specific])?.items[0]).toMatchObject({
      message: expect.stringContaining('Check your account permissions.'),
    });
    const longFailure = {
      ...failure,
      content: 'A'.repeat(2000),
      errorMessage: 'A'.repeat(2000),
      __openclaw: { id: 'long-failure', runId: turn.runId },
    };
    // The aggregate display budget may omit a later source. Keep that source
    // visible until its complete diagnostic is represented by the live row.
    expect(projectPersistedMessagesForActiveTurn([longFailure, failure], turn)).toEqual([failure]);
    for (const unrelated of [
      { ...failure, __openclaw: { seq: 3, runId: turn.runId } },
      { ...failure, __openclaw: { id: 'other', runId: 'run-other' } },
      { ...failure, role: 'custom', customType: 'run-failed-before-reply' },
    ]) {
      expect(projectPersistedMessagesForActiveTurn([unrelated], turn)).toEqual([unrelated]);
    }
    // Coalescing presentation does not let a model error settle the live run.
    expect(retireSettledActiveTurn(state, [failure])).toBe(false);
    expect(state.activeTurn).toBe(turn);
  });

  test('loads older history without losing its last reply when the active prompt is not persisted', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current', startedAt: 1000 }, dependencies);
    const history = [
      { role: 'user', content: 'old question', timestamp: 100 },
      { role: 'assistant', content: 'old reply', timestamp: 200 },
    ];
    expect(projectInitialHistoryForActiveTurn(history, turn)).toEqual(history);
    expect(
      projectInitialHistoryForActiveTurn([{ role: 'assistant', content: 'unscoped' }], turn),
    ).toBeNull();
  });

  test('retains a failure until native history has the same run error', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    turn.status = 'error';
    const failure = {
      role: 'assistant',
      content: '',
      errorMessage: 'writer lost',
      stopReason: 'error',
      runId: turn.runId,
    };
    expect(retireSettledActiveTurn(state, [])).toBe(false);
    expect(retireSettledActiveTurn(state, [{ ...failure, runId: 'run-old' }])).toBe(false);
    expect(
      retireSettledActiveTurn(state, [{ role: 'toolResult', isError: true, runId: turn.runId }]),
    ).toBe(false);
    expect(retireSettledActiveTurn(state, [markOptimisticHistoryTail(failure)])).toBe(false);
    expect(retireSettledActiveTurn(state, [failure])).toBe(true);
    expect(state.activeTurn).toBeNull();
  });

  test.each(['system', 'custom'])(
    'keeps the whole-run error while displaying a differing native %s failure',
    role => {
      const state = createChatTranscriptState('session-1', 'sid-1');
      const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
      const error = 'LLM request failed: provider rejected the request schema or tool payload.';
      turn.status = 'error';
      turn.items.push({
        id: 'terminal',
        runId: turn.runId,
        firstSeq: 2,
        lastSeq: 2,
        startedAt: 1,
        updatedAt: 2,
        type: 'terminal',
        status: 'error',
        message: error,
      });
      const failure = {
        role,
        ...(role === 'custom' ? { customType: 'run-failed-before-reply', display: true } : {}),
        content: '400 provider schema detail.',
        errorMessage: '400 provider schema detail.',
        isError: true,
        stopReason: 'error',
        __openclaw: { id: 'native-failure', seq: 4, runId: turn.runId },
      };
      expect(retireSettledActiveTurn(state, [failure])).toBe(false);
      expect(projectPersistedMessagesForActiveTurn([failure], turn)).toEqual([failure]);
      expect(
        projectPersistedMessagesForActiveTurn([failure], { ...turn, status: 'running' }),
      ).toEqual([]);
      expect(
        projectPersistedMessagesForActiveTurn([markOptimisticHistoryTail(failure)], turn),
      ).toEqual([]);
      expect(
        projectPersistedMessagesForActiveTurn(
          [{ ...failure, __openclaw: { runId: turn.runId } }],
          turn,
        ),
      ).toEqual([]);
      const partialAssistant = {
        ...failure,
        role: 'assistant',
        content: 'partial reply already projected live',
      };
      expect(projectPersistedMessagesForActiveTurn([partialAssistant], turn)).toEqual([]);
      expect(
        projectPersistedMessagesForActiveTurn(
          [
            {
              ...partialAssistant,
              content: [
                { type: 'thinking', thinking: 'Recovered reasoning' },
                { type: 'text', text: 'Partial reply already projected live' },
              ],
            },
          ],
          turn,
        ),
      ).toEqual([]);
      expect(state.activeTurn).toBe(turn);
      expect(turn.items).toMatchObject([{ type: 'terminal', message: error }]);
    },
  );

  test('hands a matching live error over to its native custom failure receipt', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const error = 'Persisted user turn changed before replay admission';
    turn.status = 'error';
    turn.items.push({
      id: 'terminal',
      runId: turn.runId,
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 1,
      updatedAt: 2,
      type: 'terminal',
      status: 'error',
      message: error,
    });
    const receipt = {
      role: 'custom',
      customType: 'run-failed-before-reply',
      content: `Your request couldn't be completed: ${error}`,
      display: true,
      __openclaw: { id: 'failure-receipt', runId: turn.runId },
    };
    expect(retireSettledActiveTurn(state, [{ ...receipt, __openclaw: { id: 'unbound' } }])).toBe(
      false,
    );
    expect(
      retireSettledActiveTurn(state, [
        { ...receipt, __openclaw: { id: 'other', runId: 'run-other' } },
      ]),
    ).toBe(false);
    expect(retireSettledActiveTurn(state, [receipt])).toBe(true);
    expect(state.activeTurn).toBeNull();
    expect(projectPersistedMessagesForActiveTurn([receipt], state.activeTurn)).toEqual([receipt]);
  });

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

  test('keeps an older Tool when the active turn reuses its call id', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const activeTool = {
      id: 'tool-current',
      runId: 'run-current',
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 2,
      updatedAt: 2,
      type: 'tool' as const,
      status: 'running' as const,
      toolCallId: 'call-reused',
      name: 'read',
    };
    turn.items.push(activeTool);
    turn.toolById.set(activeTool.toolCallId, activeTool);
    const olderCall = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-reused', name: 'read' }],
    };
    const olderResult = {
      role: 'toolResult',
      toolCallId: 'call-reused',
      content: 'old output',
    };
    const user = { role: 'user', content: 'new turn' };

    expect(projectPersistedMessagesForActiveTurn([olderCall, olderResult, user], turn)).toEqual([
      olderCall,
      olderResult,
      user,
    ]);
  });

  test('keeps an unscoped older Tool while the current user prompt is still pending', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const activeTool = {
      id: 'tool-current',
      runId: 'run-current',
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 2,
      updatedAt: 2,
      type: 'tool' as const,
      status: 'running' as const,
      toolCallId: 'call-reused',
      name: 'read',
    };
    turn.items.push(activeTool);
    turn.toolById.set(activeTool.toolCallId, activeTool);
    const oldUser = { role: 'user', content: 'old turn' };
    const olderCall = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-reused', name: 'read' }],
    };
    const olderResult = {
      role: 'toolResult',
      toolCallId: 'call-reused',
      content: 'old output',
    };
    const pendingUser = { role: 'user', content: 'new turn' };

    expect(
      projectPersistedMessagesForActiveTurn([oldUser, olderCall, olderResult], turn, pendingUser),
    ).toEqual([oldUser, olderCall, olderResult]);
  });

  test('keeps a tail Tool duplicate whose explicit run id belongs to another run', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const activeTool = {
      id: 'tool-current',
      runId: 'run-current',
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 2,
      updatedAt: 2,
      type: 'tool' as const,
      status: 'running' as const,
      toolCallId: 'call-reused',
      name: 'read',
    };
    turn.items.push(activeTool);
    turn.toolById.set(activeTool.toolCallId, activeTool);
    const user = { role: 'user', content: 'new turn' };
    const foreignCall = {
      role: 'assistant',
      runId: 'run-foreign',
      content: [{ type: 'toolCall', id: 'call-reused', name: 'read' }],
    };

    expect(projectPersistedMessagesForActiveTurn([user, foreignCall], turn)).toEqual([
      user,
      foreignCall,
    ]);
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

  test('keeps a producer-owned session.message row hidden behind its active projection', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const previous = {
      role: 'assistant',
      content: 'previous reply',
      __openclaw: { id: 'message-1', seq: 1, runId: 'run-old' },
    };
    const user = {
      role: 'user',
      content: 'current prompt',
      __openclaw: { id: 'message-2', seq: 2, runId: 'run-current' },
    };
    const durableCurrentReply = {
      role: 'assistant',
      content: 'streamed reply',
      __openclaw: { id: 'message-3', seq: 3, runId: 'run-current' },
    };

    expect(
      projectPersistedMessagesForActiveTurn([previous, user, durableCurrentReply], turn),
    ).toEqual([previous, user]);
  });

  test('keeps active output hidden when a later user input advances the history boundary', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(state, { runId: 'run-current' }, dependencies);
    const prompt = { role: 'user', content: 'start', runId: turn.runId };
    const reply = {
      role: 'assistant',
      content: 'streamed reply',
      __openclaw: { id: 'reply', runId: turn.runId },
    };
    const nextPrompt = { role: 'user', content: 'continue', runId: 'run-next' };

    expect(projectPersistedMessagesForActiveTurn([prompt, reply, nextPrompt], turn)).toEqual([
      prompt,
      nextPrompt,
    ]);
    expect(projectPersistedMessagesForActiveTurn([prompt, reply, nextPrompt], null)).toEqual([
      prompt,
      reply,
      nextPrompt,
    ]);
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
