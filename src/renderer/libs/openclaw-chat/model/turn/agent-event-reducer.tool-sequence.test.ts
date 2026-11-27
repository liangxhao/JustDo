import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import {
  beginAssistantTurn,
  type ContentItem,
  createChatTranscriptState,
  type ThinkingItem,
  type ToolItem,
} from '../chat-transcript-state';
import { confirmRecoveredToolSequence, reduceAgentEvent } from './agent-event-reducer';

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

test.each([
  { deliveryEvent: 'agent', phase: 'result', mode: 'full', expected: 'presentation-repaired' },
  { deliveryEvent: 'session.tool', phase: 'start', mode: 'full', expected: 'presentation-repaired' },
  { deliveryEvent: 'session.tool', phase: 'start', mode: 'summary', expected: 'applied' },
] as const)(
  'a delayed $deliveryEvent $phase restores a nested tool parent omitted by $mode in-flight recovery',
  ({ deliveryEvent, phase, mode, expected }) => {
    const dependencies = { now: () => 1000, createId: (prefix: string) => prefix };
    const state = createChatTranscriptState('session-1', null);
    const turn = beginAssistantTurn(
      state,
      { runId: 'run-1', lifecycleGeneration: 'current' },
      dependencies,
    );
    const call = { name: 'read', toolCallId: 'nested-tool' };
    const start: NormalizedAgentEvent = {
      runId: 'run-1',
      sessionKey: 'session-1',
      sessionId: null,
      lifecycleGeneration: null,
      agentId: null,
      spawnedBy: null,
      agentSeq: 8,
      frameSeq: null,
      deliveryEvent: 'agent',
      stream: 'tool',
      timestamp: 1008,
      data: { ...call, phase: 'start', args: { file: 'notes.md' } },
    };
    const result: NormalizedAgentEvent = {
      ...start,
      agentSeq: 10,
      timestamp: 1010,
      data: { ...call, phase: 'result', result: 'File unavailable', isError: true },
    };
    const snapshot = { replaySnapshot: true, allowSequenceBackfill: true };
    reduceAgentEvent(
      state,
      mode === 'summary' ? { ...start, data: { ...call, phase: 'start' } } : start,
      dependencies,
      snapshot,
    );
    reduceAgentEvent(
      state,
      mode === 'summary' ? { ...result, data: { ...call, phase: 'result' } } : result,
      dependencies,
      snapshot,
    );
    if (deliveryEvent === 'session.tool') {
      reduceAgentEvent(
        state,
        { ...start, agentSeq: 12, stream: 'run_status', data: { phase: 'starting_model' } },
        dependencies,
      );
    }
    expect(turn.toolById.get('nested-tool')?.presentation?.parentToolCallId).toBeUndefined();
    const canonical = phase === 'start' ? start : result;
    const live = {
      ...canonical,
      deliveryEvent,
      lifecycleGeneration: 'current',
      data: { ...canonical.data, parentToolCallId: 'parent-tool' },
    };
    const options = { allowSequenceBackfill: deliveryEvent === 'session.tool' };
    expect(
      reduceAgentEvent(state, { ...live, lifecycleGeneration: 'retired' }, dependencies, options),
    ).toBe('ignored-run');
    expect(reduceAgentEvent(state, {
      ...live,
      agentSeq: phase === 'result' ? 9 : live.agentSeq,
      data: { ...call, phase, parentToolCallId: call.toolCallId },
    }, dependencies, options)).toBe('ignored-sequence');

    expect(reduceAgentEvent(state, live, dependencies, options)).toBe(expected);

    const tool = turn.toolById.get('nested-tool');
    expect(tool).toMatchObject({
      presentation: { parentToolCallId: 'parent-tool' },
      input: { file: 'notes.md' },
      status: mode === 'summary' ? 'completed' : 'failed',
      firstSeq: 8,
      lastSeq: 10,
    });
    expect(tool?.output).toBe(mode === 'summary' ? undefined : 'File unavailable');
    expect(reduceAgentEvent(state, live, dependencies, options)).toBe('ignored-sequence');
  },
);
