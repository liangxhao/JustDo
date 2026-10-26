import {
  MESSAGE_COMMENTARY_SNAPSHOT,
  type NormalizedAgentEvent,
  readAssistantTextScope,
} from '@shared/openclaw/agentEvent';
import { describe, expect, it } from 'vitest';

import { collectActiveContentText } from '../../gateway/chat-controller-support';
import { createChatTranscriptState } from '../chat-transcript-state';
import { projectTurnItems } from '../timeline/project-turn-items';
import { reduceAgentEvent } from './agent-event-reducer';

function setup() {
  const state = createChatTranscriptState('session', null);
  let nextId = 0;
  let seq = 0;
  const emit = (stream: string, data: Record<string, unknown>, sequence = ++seq, replay = false) => {
    seq = Math.max(seq, sequence);
    const event: NormalizedAgentEvent = {
      runId: 'run', sessionKey: 'session', sessionId: null, lifecycleGeneration: null,
      agentId: null, spawnedBy: null, agentSeq: sequence, frameSeq: null,
      deliveryEvent: 'agent', stream, timestamp: sequence + 100, data,
    };
    return reduceAgentEvent(state, event, {
      now: () => sequence + 100, createId: () => `item-${++nextId}`,
    }, { replaySnapshot: replay, allowSequenceBackfill: replay });
  };
  const preamble = (itemId: string, text: string, scope = 'source', extra: object = {}) => emit('item', {
    kind: 'preamble', phase: 'update', itemId, progressText: text,
    assistantTextScope: { id: scope, commentarySnapshot: MESSAGE_COMMENTARY_SNAPSHOT }, ...extra,
  });
  const complete = (ids: string[], text = '') => emit('assistant', {
    itemId: 'answer', text, replace: true,
    assistantTextScope: { id: 'source', commentaryItemIds: ids },
  });
  const visible = () => projectTurnItems(state.activeTurn).flatMap(item =>
    item.kind === 'content' ? [item.item.text] : []);
  return { state, emit, preamble, complete, visible };
}

describe('explicit whole-message commentary snapshots', () => {
  it('shows the latest complete snapshot without deleting either native owner or text', () => {
    const { state, preamble, complete, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    expect(visible()).toEqual(['First.\nSecond.']);
    expect(collectActiveContentText(state.activeTurn)).toBe('First.\nSecond.');
    expect(state.activeTurn?.items.filter(item => item.type === 'content').map(item => item.text))
      .toEqual(['First.', 'First.\nSecond.']);
    complete(['first', 'second'], 'Done.');
    expect(visible()).toEqual(['First.\nSecond.', 'Done.']);
  });

  it('uses the last text event rather than the original owner or array position', () => {
    const { state, emit, preamble, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    preamble('first', 'First.\nSecond.\nCorrection.');
    emit('thinking', { text: 'Working.' });
    emit('tool', { phase: 'start', toolCallId: 'tool', name: 'read' });
    expect(visible()).toEqual(['First.\nSecond.\nCorrection.']);
    expect(state.activeTurn?.items.find(item => item.type === 'content' && item.preambleItemId === 'first'))
      .toMatchObject({ firstSeq: 1, lastTextSeq: 3 });
  });

  it('does not let an older snapshot restored after a newer owner win', () => {
    const { emit, preamble, visible } = setup();
    preamble('second', 'First.\nSecond.', 'source');
    preamble('second', 'First.\nSecond.\nLatest.', 'source');
    emit('item', {
      kind: 'preamble', phase: 'end', itemId: 'first', progressText: 'First.',
      assistantTextScope: { id: 'source', commentarySnapshot: MESSAGE_COMMENTARY_SNAPSHOT },
    }, 0, true);
    expect(visible()).toEqual(['First.\nSecond.\nLatest.']);
  });

  it('respects retained IDs and can restore the earlier retained snapshot', () => {
    const { preamble, complete, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    complete(['first']);
    expect(visible()).toEqual(['First.']);
  });

  it('keeps an ordinary answer after rollback and rejects late commentary resurrection', () => {
    const { preamble, complete, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    complete([], 'Restored answer.');
    preamble('second', 'First.\nSecond.');
    expect(visible()).toEqual(['Restored answer.']);
  });

  it('retains independent preambles and identical text in other native messages', () => {
    const { emit, preamble, visible } = setup();
    preamble('first', 'Same.');
    preamble('second', 'Same. More.');
    emit('item', { kind: 'preamble', phase: 'end', itemId: 'independent', progressText: 'Independent.',
      assistantTextScope: { id: 'source' } });
    preamble('other-message', 'Same.', 'other-source');
    expect(visible()).toEqual(['Same. More.', 'Independent.', 'Same.']);
  });

  it('does not retain a snapshot marker when that owner receives a block update', () => {
    const { emit, preamble, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    emit('item', { kind: 'preamble', phase: 'update', itemId: 'second', progressText: 'Second.',
      assistantTextScope: { id: 'source' } });
    expect(visible()).toEqual(['First.', 'Second.']);
  });

  it('does not revive old commentary when the latest snapshot explicitly retracts its text', () => {
    const { preamble, visible } = setup();
    preamble('first', 'First.');
    preamble('second', 'First.\nSecond.');
    preamble('second', '', 'source', { replace: true });
    expect(visible()).toEqual([]);
  });

  it('ignores unknown marker values while preserving the original source facts', () => {
    expect(readAssistantTextScope({ assistantTextScope: {
      id: 'source', commentarySnapshot: 'block', commentaryItemIds: [],
    } })).toEqual({ id: 'source', commentaryItemIds: [] });
    expect(readAssistantTextScope({ assistantTextScope: {
      commentarySnapshot: MESSAGE_COMMENTARY_SNAPSHOT,
    } })).toBeNull();
    expect(readAssistantTextScope({ assistantTextScope: {
      id: 'source', commentarySnapshot: MESSAGE_COMMENTARY_SNAPSHOT,
    } })).toEqual({ id: 'source', commentarySnapshot: MESSAGE_COMMENTARY_SNAPSHOT });
  });
});
