import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import { hydrateToolPrecedingSegments, reduceAgentEvent } from './agent-event-reducer';
import {
  beginAssistantTurn,
  createChatTranscriptState,
  type ToolItem,
} from './chat-transcript-state';

function setup(type: 'thinking' | 'content') {
  let id = 0;
  const dependencies = { now: () => 100, createId: (prefix: string) => `${prefix}-${++id}` };
  const state = createChatTranscriptState('session-1', null);
  const turn = beginAssistantTurn(state, { runId: 'run-1', startedAt: 100 }, dependencies);
  const tool: ToolItem = {
    id: 'tool-1',
    runId: 'run-1',
    firstSeq: 0,
    lastSeq: 0,
    startedAt: 200,
    updatedAt: 200,
    type: 'tool',
    status: 'running',
    name: 'sessions_yield',
    toolCallId: 'tool-1',
    agentSequencePending: true,
  };
  turn.items.push(tool);
  turn.toolById.set(tool.toolCallId, tool);
  hydrateToolPrecedingSegments(
    turn,
    tool,
    [{ type, text: 'Repeated words, fully recovered.' }],
    0,
    200,
    dependencies,
  );
  const emit = (
    seq: number,
    firstSeq: number,
    text: string,
    timestamp: number,
    startedAt = timestamp,
  ) => {
    const event: NormalizedAgentEvent = {
      runId: 'run-1',
      sessionKey: 'session-1',
      sessionId: null,
      lifecycleGeneration: null,
      agentId: null,
      spawnedBy: null,
      agentSeq: seq,
      frameSeq: null,
      deliveryEvent: 'agent',
      stream: type === 'content' ? 'assistant' : 'thinking',
      timestamp,
      data: {
        text,
        progressSegmentFirstSeq: firstSeq,
        progressSegmentStartedAt: startedAt,
        replace: true,
      },
    };
    return reduceAgentEvent(state, event, dependencies, {
      replaySnapshot: true,
      allowSequenceBackfill: true,
    });
  };
  return { turn, emit };
}

test.each(['thinking', 'content'] as const)(
  'keeps a new post-Tool %s segment separate from identically worded recovered history',
  type => {
    const { turn, emit } = setup(type);

    expect(emit(12, 10, 'Repeated words', 300)).toBe('applied');

    expect(
      turn.items.map(item => [
        item.type,
        'text' in item ? item.text : item.type === 'tool' ? item.toolCallId : null,
      ]),
    ).toEqual([
      [type, 'Repeated words, fully recovered.'],
      ['tool', 'tool-1'],
      [type, 'Repeated words'],
    ]);
  },
);

test.each(['thinking', 'content'] as const)(
  'binds an unambiguous earlier %s segment to recovered pre-Tool history without duplication',
  type => {
    const { turn, emit } = setup(type);

    expect(emit(5, 2, 'Repeated words', 150)).toBe('applied');

    expect(turn.items).toHaveLength(2);
    expect(turn.items[0]).toMatchObject({
      type,
      firstSeq: 2,
      text: 'Repeated words, fully recovered.',
    });
    expect(emit(6, 2, 'Repeated words, fully recovered.', 160)).toBe('applied');
    expect(turn.items).toHaveLength(2);
  },
);

test.each(['thinking', 'content'] as const)(
  'accepts a later authoritative shortening of a recovered %s owner',
  type => {
    const { turn, emit } = setup(type);
    emit(5, 2, 'Repeated words', 150);

    emit(20, 2, 'Repeated', 300);

    expect(turn.items[0]).toMatchObject({ type, firstSeq: 2, text: 'Repeated' });
    expect(turn.items).toHaveLength(2);
  },
);

test.each(['thinking', 'content'] as const)(
  'accepts a newer recovery correction of a bound %s owner retaining its first-seen timestamp',
  type => {
    const { turn, emit } = setup(type);
    emit(5, 2, 'Repeated words', 150);

    emit(20, 2, 'Repeated', 300, 150);

    expect(turn.items[0]).toMatchObject({
      type,
      firstSeq: 2,
      text: 'Repeated',
      startedAt: 150,
      updatedAt: 300,
    });
    expect(turn.items).toHaveLength(2);
  },
);

test.each(['thinking', 'content'] as const)(
  'binds an earlier %s owner first recovered after its Tool and applies the latest correction',
  type => {
    const { turn, emit } = setup(type);

    emit(20, 2, 'Repeated', 300, 150);

    expect(turn.items[0]).toMatchObject({
      type,
      firstSeq: 2,
      text: 'Repeated',
      startedAt: 150,
      updatedAt: 300,
    });
    expect(turn.items.map(item => item.type)).toEqual([type, 'tool']);
  },
);

test.each(['thinking', 'content'] as const)(
  'does not rebind a known %s segment to another owner sharing its text',
  type => {
    const { turn, emit } = setup(type);
    emit(5, 2, 'Repeated words', 150);

    emit(8, 7, 'Repeated words', 170);

    expect(turn.items.filter(item => item.type === type).map(item => item.firstSeq)).toEqual([
      2, 7,
    ]);
    expect(turn.items.map(item => item.type)).toEqual([type, type, 'tool']);
  },
);
