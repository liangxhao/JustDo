import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { expect, it } from 'vitest';

import { buildAgentTeamEntries } from './agentTeamEntries';

it('shares stable identities for all linked batches and groups while omitting other sessions', () => {
  const room: CollaborationRoomEntry = {
    id: 'room',
    anchorSessionId: 'source',
    members: [],
    rounds: [
      { id: 'old', state: 'settled', pending: 0 },
      { id: 'new', state: 'closing', pending: 1 },
    ],
  };
  const groups: Pick<
    TeamDiscussionRoom,
    'id' | 'title' | 'sourceSessionId' | 'members' | 'state' | 'latestRun'
  >[] = ['source', 'source', 'source', 'unrelated'].map((sourceSessionId, index) => ({
    id: `group-${index}`,
    title: `Topic ${index}`,
    sourceSessionId,
    state: 'ready',
    members: [
      { agentId: 'a', name: 'A' },
      { agentId: 'b', name: 'B', deleted: true },
    ],
    latestRun: {
      discussionId: 'batch',
      requestId: 'request',
      state: index === 0 ? 'completed' : 'interrupted',
    },
  }));
  const entries = buildAgentTeamEntries(
    'source',
    [room, { ...room, id: 'unrelated-room', anchorSessionId: 'unrelated' }],
    groups,
    key => key,
  );
  expect(entries.map(entry => entry.key)).toEqual([
    'task:room:old',
    'task:room:new',
    'group:group-0',
    'group:group-1',
    'group:group-2',
  ]);
  expect(entries.map(entry => entry.statusKey)).toEqual([
    'teamRecordEnded',
    'teamRecordClosing',
    'teamRecordEnded',
    'teamRecordUnconfirmed',
    'teamRecordUnconfirmed',
  ]);
  expect(entries[2].memberCount).toBe(1);
  expect(buildAgentTeamEntries('missing', [room], groups, key => key)).toEqual([]);
});
