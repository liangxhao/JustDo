import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import {
  type TeamDiscussionRoom,
  TeamDiscussionState,
} from '@shared/cowork/agent-team/teamDiscussion';
import { expect, test } from 'vitest';

import { collectRelatedRunningSessionIds } from './sessionListActivity';

const room = (pending: number): CollaborationRoomEntry => ({
  id: 'team',
  anchorSessionId: 'source',
  members: [{ agentId: 'worker', sessionId: 'peer', sessionKey: 'peer-key' }],
  rounds: [{ id: 'round', state: 'open', pending }],
});

test('projects native member activity onto its source only', () => {
  expect([...collectRelatedRunningSessionIds([room(0)], [], { peer: true })]).toEqual(['source']);
  expect([...collectRelatedRunningSessionIds([room(0)], [], {})]).toEqual([]);
  expect([...collectRelatedRunningSessionIds([room(1)], [], { unrelated: true })]).toEqual([]);
});

test.each(['open', 'closing', 'settled', 'failed', 'stopped'] as const)(
  'keeps %s receipt state separate from current member activity',
  state => {
    const historical = room(1);
    historical.rounds[0].state = state;
    expect([...collectRelatedRunningSessionIds([historical], [], {})]).toEqual([]);
    expect([...collectRelatedRunningSessionIds([historical], [], { peer: true })]).toEqual([
      'source',
    ]);
    expect([...collectRelatedRunningSessionIds([historical], [], { peer: false })]).toEqual([]);
    expect(historical.rounds[0]).toEqual({ id: 'round', state, pending: 1 });
  },
);

test.each(Object.values(TeamDiscussionState))('projects a source discussion in state %s', state => {
  const discussion = { id: 'group', sourceSessionId: 'source', state } as TeamDiscussionRoom;
  const active = [
    TeamDiscussionState.PREPARING,
    TeamDiscussionState.SUBMITTING,
    TeamDiscussionState.RUNNING,
    TeamDiscussionState.STOPPING,
  ].some(value => value === state);
  expect(collectRelatedRunningSessionIds([], [discussion], {}).has('source')).toBe(active);
  expect(
    collectRelatedRunningSessionIds([], [{ ...discussion, sourceSessionId: undefined }], {}).size,
  ).toBe(0);
});
