import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import { confirmRecoveredToolSequence, reduceAgentEvent } from './agent-event-reducer';
import {
  beginAssistantTurn,
  type ContentItem,
  createChatTranscriptState,
  type ThinkingItem,
  type ToolItem,
} from './chat-transcript-state';

test.each(['thinking', 'content'] as const)(
  'moving a recovered Tool before later %s does not complete that later owner',
  type => {
    const dependencies = { now: () => 1000, createId: (prefix: string) => prefix };
    const state = createChatTranscriptState('session-1', null);
    const turn = beginAssistantTurn(state, { runId: 'run-1' }, dependencies);
    const base = {
      id: 'text',
      runId: 'run-1',
      firstSeq: 5,
      lastSeq: 5,
      startedAt: 1500,
      updatedAt: 1500,
      text: 'After the tool',
    };
    const text: ThinkingItem | ContentItem =
      type === 'thinking'
        ? { ...base, type, status: 'running' }
        : {
            ...base,
            type,
            status: 'streaming',
            sourceMode: 'snapshot',
            followingToolCallId: 'tool-1',
          };
    const tool: ToolItem = {
      id: 'tool',
      runId: 'run-1',
      type: 'tool',
      status: 'completed',
      name: 'read',
      toolCallId: 'tool-1',
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 1000,
      updatedAt: 1400,
      agentSequenceUnconfirmed: true,
    };
    turn.items.push(text, tool);
    turn.toolById.set(tool.toolCallId, tool);

    confirmRecoveredToolSequence(turn, tool, 3, 1300);

    expect(turn.items).toEqual([tool, text]);
    expect(text.status).toBe(type === 'thinking' ? 'running' : 'streaming');
    expect(text).not.toHaveProperty('followingToolCallId');
  },
);

test('a delayed canonical Tool start corrects ordering without undoing its newer terminal result', () => {
  const dependencies = { now: () => 1000, createId: (prefix: string) => prefix };
  const state = createChatTranscriptState('session-1', null);
  const event = (seq: number, phase: string): NormalizedAgentEvent => ({
    runId: 'run-1',
    sessionKey: 'session-1',
    sessionId: null,
    lifecycleGeneration: null,
    agentId: null,
    spawnedBy: null,
    agentSeq: seq,
    frameSeq: null,
    deliveryEvent: 'agent',
    stream: 'tool',
    timestamp: 1000 + seq,
    data: {
      phase,
      name: 'read',
      toolCallId: 'tool-1',
      ...(phase === 'result' ? { result: 'Final result', isError: true } : { args: {} }),
    },
  });
  reduceAgentEvent(state, event(10, 'result'), dependencies);

  expect(reduceAgentEvent(state, event(8, 'start'), dependencies)).toBe('applied');

  expect(state.activeTurn!.toolById.get('tool-1')).toMatchObject({
    firstSeq: 8,
    lastSeq: 10,
    status: 'failed',
    output: 'Final result',
  });
  expect(state.activeTurn!.lastAgentSeq).toBe(10);
  expect(reduceAgentEvent(state, event(9, 'result'), dependencies)).toBe('ignored-sequence');
});
