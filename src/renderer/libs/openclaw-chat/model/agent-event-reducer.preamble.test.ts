import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import {
  hydrateToolPrecedingSegments,
  readPreambleText,
  reduceAgentEvent,
} from './agent-event-reducer';
import { createChatTranscriptState, type ToolItem } from './chat-transcript-state';

function setup() {
  let id = 0;
  const dependencies = { now: () => 100, createId: (prefix: string) => `${prefix}-${++id}` };
  const state = createChatTranscriptState('session-1', null);
  const emit = (seq: number, stream: string, data: Record<string, unknown>, replay = false) => {
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
      stream,
      timestamp: 100 + seq,
      data,
    };
    return reduceAgentEvent(state, event, dependencies, {
      replaySnapshot: replay,
      allowSequenceBackfill: replay,
    });
  };
  const preamble = (
    seq: number,
    text: string,
    itemId = 'commentary-1',
    phase = 'update',
    replay = false,
    firstSeq = seq,
  ) =>
    emit(
      seq,
      'item',
      {
        kind: 'preamble',
        title: 'Preamble',
        itemId,
        phase,
        progressText: text,
        progressSegmentFirstSeq: firstSeq,
        progressSegmentStartedAt: 100 + firstSeq,
      },
      replay,
    );
  const items = () =>
    state.activeTurn?.items.map(item => [
      item.type,
      'text' in item ? item.text : item.type === 'tool' ? item.toolCallId : null,
    ]);
  return { state, emit, preamble, items, dependencies };
}

test('displays native commentary immediately and completes it on an identical end snapshot', () => {
  const { state, preamble, items } = setup();
  preamble(1, 'Checking');
  const contentId = state.activeTurn?.items[0].id;
  preamble(2, 'Checking the results.', 'commentary-1', 'update', false, 1);

  expect(items()).toEqual([['content', 'Checking the results.']]);
  expect(state.activeTurn?.items[0]).toMatchObject({ id: contentId, status: 'streaming' });
  preamble(3, 'Checking the results.', 'commentary-1', 'end', false, 1);
  expect(state.activeTurn?.items[0]).toMatchObject({ id: contentId, status: 'completed' });
});

test('retains distinct adjacent commentary owners even when their text is identical', () => {
  const { preamble, items } = setup();
  preamble(1, 'Checking', 'first');
  preamble(2, 'Checking', 'second');
  preamble(3, 'Checking again', 'second', 'end', false, 2);

  expect(items()).toEqual([
    ['content', 'Checking'],
    ['content', 'Checking again'],
  ]);
});

test('keeps an assistant final reply separate from an unfinished commentary item', () => {
  const { emit, preamble, items } = setup();
  preamble(1, 'Checking the result.');
  emit(2, 'assistant', { text: 'The result is ready.', progressSegmentFirstSeq: 2 });

  expect(items()).toEqual([
    ['content', 'Checking the result.'],
    ['content', 'The result is ready.'],
  ]);
});

test('never absorbs a same-prefix assistant reply into a native preamble owner', () => {
  const { emit, preamble, items } = setup();
  preamble(1, 'Checking');

  emit(2, 'assistant', { text: 'Checking complete.' });

  expect(items()).toEqual([
    ['content', 'Checking'],
    ['content', 'Checking complete.'],
  ]);
});

test('recovers commentary ahead of queued Thinking and Tool events without losing their order', () => {
  const { state, emit, preamble, items } = setup();
  emit(1, 'thinking', { text: 'Initial reasoning', progressSegmentFirstSeq: 1 });
  preamble(8, 'Checking the tools.', 'commentary-1', 'end', true, 3);
  expect(state.activeTurn?.lastAgentSeq).toBe(1);
  emit(2, 'thinking', { text: 'Initial reasoning completed', progressSegmentFirstSeq: 1 });
  emit(5, 'tool', { phase: 'start', toolCallId: 'tool-1', name: 'read' });
  emit(6, 'thinking', { text: 'Review the tool', progressSegmentFirstSeq: 6 });

  expect(items()).toEqual([
    ['thinking', 'Initial reasoning completed'],
    ['content', 'Checking the tools.'],
    ['tool', 'tool-1'],
    ['thinking', 'Review the tool'],
  ]);
});

test('deduplicates recovery and delayed live updates by native commentary owner', () => {
  const { preamble, items } = setup();
  preamble(6, 'Latest commentary', 'commentary-1', 'end', true, 1);
  preamble(2, 'Older commentary', 'commentary-1', 'update', false, 1);
  preamble(6, 'Latest commentary', 'commentary-1', 'end', true, 1);
  preamble(7, 'Latest', 'commentary-1', 'end', true, 1);

  expect(items()).toEqual([['content', 'Latest']]);
});

test('completes a recovered update when its later native end arrives', () => {
  const { state, preamble, items } = setup();
  preamble(3, 'Checking', 'commentary-1', 'update', true, 1);

  preamble(4, 'Checking complete.', 'commentary-1', 'end', false, 1);

  expect(items()).toEqual([['content', 'Checking complete.']]);
  expect(state.activeTurn?.items[0]).toMatchObject({ status: 'completed', firstSeq: 1 });
});

test('keeps the native item owner when its end follows an intervening Thinking boundary', () => {
  const { emit, preamble, items } = setup();
  preamble(1, 'Checking', 'commentary-1');
  emit(2, 'thinking', { text: 'Reasoning continues', progressSegmentFirstSeq: 2 });

  preamble(3, 'Checking complete.', 'commentary-1', 'end');

  expect(items()).toEqual([
    ['content', 'Checking complete.'],
    ['thinking', 'Reasoning continues'],
  ]);
});

test('supports native preamble payloads without optional progress metadata', () => {
  const { state, emit, items } = setup();
  emit(1, 'item', {
    kind: 'preamble',
    itemId: 'native-id',
    progressText: 'Working',
    phase: 'update',
  });
  emit(2, 'item', {
    kind: 'preamble',
    itemId: 'native-id',
    progressText: 'Working now',
    phase: 'end',
  });

  expect(items()).toEqual([['content', 'Working now']]);
  expect(state.activeTurn?.items[0]).toMatchObject({ status: 'completed', firstSeq: 1 });
});

test('does not render non-preamble progress items or empty commentary', () => {
  const { emit, items } = setup();
  emit(1, 'item', {
    kind: 'answer_candidate',
    progressText: 'Private candidate',
    itemId: 'private',
  });
  emit(2, 'item', { kind: 'preamble', progressText: '   ', itemId: 'empty' });

  expect(items()).toEqual([]);
  expect(readPreambleText({ kind: 'preamble', progressText: 'Visible' })).toBe('Visible');
});

test('binds native commentary to the matching recovered history segment without duplication', () => {
  const { state, emit, preamble, items, dependencies } = setup();
  emit(1, 'thinking', { text: 'Reasoning', progressSegmentFirstSeq: 1 });
  const turn = state.activeTurn!;
  const tool: ToolItem = {
    id: 'history-tool',
    runId: 'run-1',
    type: 'tool',
    toolCallId: 'tool-1',
    name: 'read',
    status: 'running',
    firstSeq: 1,
    lastSeq: 1,
    startedAt: 110,
    updatedAt: 110,
    agentSequencePending: true,
  };
  turn.items.push(tool);
  turn.toolById.set(tool.toolCallId, tool);
  hydrateToolPrecedingSegments(
    turn,
    tool,
    [
      { type: 'thinking', text: 'Reasoning' },
      { type: 'content', text: 'Checking complete.' },
    ],
    1,
    110,
    dependencies,
  );
  const historyContentId = turn.items.find(item => item.type === 'content')?.id;

  preamble(4, 'Checking', 'commentary-1', 'update', true, 3);
  preamble(5, 'Checking complete.', 'commentary-1', 'end', false, 3);

  expect(items()).toEqual([
    ['thinking', 'Reasoning'],
    ['content', 'Checking complete.'],
    ['tool', 'tool-1'],
  ]);
  expect(turn.items[1]).toMatchObject({
    id: historyContentId,
    preambleItemId: 'commentary-1',
    firstSeq: 3,
  });
});
