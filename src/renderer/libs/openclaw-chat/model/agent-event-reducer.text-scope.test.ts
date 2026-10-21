import { type NormalizedAgentEvent, readAssistantTextScope } from '@shared/openclaw/agentEvent';
import { describe, expect, it } from 'vitest';

import { hydrateToolPrecedingSegments, reduceAgentEvent } from './agent-event-reducer';
import { createChatTranscriptState } from './chat-transcript-state';
import { projectTurnItems } from './project-turn-items';

function setup() {
  const state = createChatTranscriptState('session', null);
  let id = 0;
  let seq = 0;
  const emit = (
    stream: string,
    data: Record<string, unknown>,
    replay = false,
    sequence?: number,
  ) => {
    const event: NormalizedAgentEvent = {
      runId: 'run',
      sessionKey: 'session',
      sessionId: null,
      lifecycleGeneration: null,
      agentId: null,
      spawnedBy: null,
      agentSeq: sequence ?? ++seq,
      frameSeq: null,
      deliveryEvent: 'agent',
      stream,
      timestamp: 100 + seq,
      data,
    };
    return reduceAgentEvent(
      state,
      event,
      { now: () => 100 + seq, createId: () => `item-${++id}` },
      { replaySnapshot: replay, allowSequenceBackfill: replay },
    );
  };
  const body = (text: string, scope = 'message-1', complete?: string[]) =>
    emit('assistant', {
      text,
      itemId: `assistant-${scope}`,
      assistantTextScope: {
        id: scope,
        ...(complete !== undefined ? { commentaryItemIds: complete } : {}),
      },
    });
  const preamble = (text: string, scope = 'message-1', owner = 'commentary-1') =>
    emit('item', {
      kind: 'preamble',
      phase: 'update',
      itemId: owner,
      progressText: text,
      assistantTextScope: { id: scope },
    });
  const visible = () =>
    projectTurnItems(state.activeTurn).flatMap(item =>
      item.kind === 'content' ? [item.item.text] : [],
    );
  return { state, emit, body, preamble, visible };
}

describe('native message text scope projection', () => {
  it('atomically transfers a preview to its commentary without waiting for a native retraction', () => {
    const { body, preamble, visible, state } = setup();
    body('Checking.');
    expect(visible()).toEqual(['Checking.']);
    preamble('Checking.');
    expect(visible()).toEqual(['Checking.']);
    expect(state.activeTurn?.status).toBe('running');
  });

  it('replaces provisional commentary when a tool call is rolled back', () => {
    const { body, preamble, visible } = setup();
    body('Restored final.');
    preamble('Restored final.');
    body('Restored final.', 'message-1', []);
    expect(visible()).toEqual(['Restored final.']);
  });

  it('preserves the hidden prefix when Gateway delivers the final as a delta', () => {
    const { body, preamble, emit, visible } = setup();
    body('Checking.');
    preamble('Checking.');
    emit('assistant', {
      delta: ' More.',
      itemId: 'assistant-message-1',
      assistantTextScope: { id: 'message-1', commentaryItemIds: [] },
    });
    expect(visible()).toEqual(['Checking. More.']);
  });

  it.each(['Checking.', 'Checking. More.'])(
    'uses the full message-end snapshot after history restored %s',
    recovered => {
      const { state, body, preamble, emit, visible } = setup();
      body('Checking.');
      preamble('Checking.');
      emit('tool', { phase: 'start', toolCallId: 'read-1', name: 'read' });
      const turn = state.activeTurn!;
      hydrateToolPrecedingSegments(
        turn,
        turn.toolById.get('read-1')!,
        [{ type: 'content', text: recovered }],
        3,
        200,
        { now: () => 200, createId: () => 'recovered' },
      );
      emit('assistant', {
        text: 'Checking. More.',
        delta: ' More.',
        replace: true,
        itemId: 'assistant-message-1',
        assistantTextScope: { id: 'message-1', commentaryItemIds: [] },
      });
      expect(visible()).toEqual(['Checking. More.']);
    },
  );

  it('retains valid commentary before the final answer in the same message', () => {
    const { body, preamble, visible } = setup();
    body('Checking.');
    preamble('Checking.');
    body('Done.', 'message-1', ['commentary-1']);
    expect(visible()).toEqual(['Checking.', 'Done.']);
  });

  it('preserves identical text from independent native messages', () => {
    const { preamble, body, visible } = setup();
    preamble('Same text.', 'message-1');
    body('Same text.', 'message-2', []);
    expect(visible()).toEqual(['Same text.', 'Same text.']);
  });

  it('keeps a preview hidden while its source message remains commentary', () => {
    const { body, preamble, visible } = setup();
    body('Checking.');
    preamble('Checking.');
    body('Checking again.');
    expect(visible()).toEqual(['Checking.']);
  });

  it('does not resurrect retired commentary from a later or replayed provisional event', () => {
    const { body, preamble, emit, visible } = setup();
    body('Final.');
    preamble('Final.');
    body('Final.', 'message-1', []);
    preamble('Final.');
    emit(
      'item',
      {
        kind: 'preamble',
        phase: 'end',
        itemId: 'commentary-1',
        progressText: 'Final.',
        assistantTextScope: { id: 'message-1' },
      },
      true,
      2,
    );
    expect(visible()).toEqual(['Final.']);
  });

  it('remembers a completion with no text before a delayed commentary owner is restored', () => {
    const { emit, preamble, visible } = setup();
    emit('assistant', {
      itemId: 'assistant-message-1',
      assistantTextScope: {
        id: 'message-1',
        commentaryItemIds: [],
      },
    });
    preamble('Rolled back.');
    expect(visible()).toEqual([]);
  });

  it('does not infer identity from identical strings without explicit scope evidence', () => {
    const { emit, visible } = setup();
    emit('assistant', { text: 'Same.', itemId: 'body' });
    emit('item', {
      kind: 'preamble',
      phase: 'update',
      itemId: 'commentary',
      progressText: 'Same.',
    });
    expect(visible()).toEqual(['Same.', 'Same.']);
  });

  it('refuses conflicting scope claims for a known native owner', () => {
    const { body, emit, visible } = setup();
    body('Original.');
    emit('assistant', {
      text: 'Wrong owner.',
      itemId: 'assistant-message-1',
      assistantTextScope: { id: 'message-2' },
    });
    expect(visible()).toEqual(['Original.']);
  });

  it('does not reopen a completed body with a provisional delivery', () => {
    const { body, visible } = setup();
    body('Final.', 'message-1', []);
    body('Old preview.');
    expect(visible()).toEqual(['Final.']);
  });

  it('distinguishes missing completion evidence from an explicitly empty retained set', () => {
    expect(readAssistantTextScope({ assistantTextScope: { id: 'message-1' } })).toEqual({
      id: 'message-1',
    });
    expect(
      readAssistantTextScope({ assistantTextScope: { id: 'message-1', commentaryItemIds: [] } }),
    ).toEqual({ id: 'message-1', commentaryItemIds: [] });
    expect(
      readAssistantTextScope({
        assistantTextScope: { id: 'message-1', commentaryItemIds: [null] },
      }),
    ).toBeNull();
  });

  it('keeps a retired preview hidden after native tool history hydrates its text', () => {
    const { state, body, preamble, emit } = setup();
    body('Checking.');
    preamble('Checking.');
    emit('tool', { phase: 'start', toolCallId: 'read-1', name: 'read' });
    const turn = state.activeTurn!;
    const tool = turn.toolById.get('read-1')!;
    hydrateToolPrecedingSegments(turn, tool, [{ type: 'content', text: 'Checking.' }], 4, 200, {
      now: () => 200,
      createId: () => 'recovered',
    });
    expect(
      projectTurnItems(turn).flatMap(item => (item.kind === 'content' ? [item.item.text] : [])),
    ).toEqual(['Checking.']);
  });

  it('does not promote old hydrated preview text when a budget-limited final has no text', () => {
    const { state, body, preamble, emit } = setup();
    body('Old interim.');
    preamble('Old interim.');
    emit('tool', { phase: 'start', toolCallId: 'read-1', name: 'read' });
    const turn = state.activeTurn!;
    hydrateToolPrecedingSegments(
      turn,
      turn.toolById.get('read-1')!,
      [{ type: 'content', text: 'Old interim.' }],
      3,
      200,
      { now: () => 200, createId: () => 'recovered' },
    );
    emit(
      'assistant',
      {
        itemId: 'assistant-message-1',
        assistantTextSnapshot: true,
        assistantTextScope: { id: 'message-1', commentaryItemIds: [] },
      },
      true,
      4,
    );
    expect(projectTurnItems(turn).filter(item => item.kind === 'content')).toEqual([]);
    emit(
      'assistant',
      {
        text: 'Actual final.',
        itemId: 'assistant-message-1',
        assistantTextScope: { id: 'message-1', commentaryItemIds: [] },
      },
      false,
      5,
    );
    expect(
      projectTurnItems(turn).flatMap(item => (item.kind === 'content' ? [item.item.text] : [])),
    ).toEqual(['Actual final.']);
  });

  it('does not restore a history-filled preview when final commentary arrives later', () => {
    const { state, body, preamble, emit } = setup();
    body('Checking.');
    preamble('Checking.');
    body('', 'message-1', ['commentary-1']);
    const preview = state.activeTurn!.items.find(
      item => item.type === 'content' && item.assistantItemId,
    )!;
    if (preview.type === 'content') preview.text = 'Checking.';
    emit('item', {
      kind: 'preamble',
      phase: 'end',
      itemId: 'commentary-1',
      progressText: 'Checking.',
      assistantTextScope: { id: 'message-1', commentaryItemIds: ['commentary-1'] },
    });
    expect(
      projectTurnItems(state.activeTurn).flatMap(item =>
        item.kind === 'content' ? [item.item.text] : [],
      ),
    ).toEqual(['Checking.']);
  });
});
