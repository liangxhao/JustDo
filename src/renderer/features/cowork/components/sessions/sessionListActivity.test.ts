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

test('projects native member activity and unsettled deliveries onto their source only', () => {
  expect([...collectRelatedRunningSessionIds([room(0)], [], { peer: true })]).toEqual(['source']);
  expect([...collectRelatedRunningSessionIds([room(1)], [], {})]).toEqual(['source']);
  expect([...collectRelatedRunningSessionIds([room(0)], [], {})]).toEqual([]);
  const stopped = room(1);
  stopped.rounds[0].state = 'stopped';
  expect([...collectRelatedRunningSessionIds([stopped], [], {})]).toEqual([]);
});

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
