import type { CollaborationRoomEntry, CollaborationRound } from '../teamContracts';
import type { TeamDiscussionRoom } from '../../../contracts/teamDiscussion';
import { TeamDiscussionState } from '../../../contracts/teamDiscussion';

export const AgentTeamKind = { TASK: 'task', GROUP: 'group' } as const;
export type AgentTeamEntry = {
  kind: (typeof AgentTeamKind)[keyof typeof AgentTeamKind];
  key: string;
  roomId: string;
  roundId?: string;
  label: string;
  memberCount: number;
  statusKey: string;
};

export const groupTeamKey = (roomId: string): string => `group:${roomId}`;
const ROUND_STATUS: Record<CollaborationRound['state'], string> = {
  open: 'teamRecordOpen',
  closing: 'teamRecordClosing',
  settled: 'teamRecordEnded',
  failed: 'teamRecordFailed',
  stopped: 'teamRecordStopped',
};
const GROUP_STATUS: Record<TeamDiscussionRoom['state'], string> = {
  [TeamDiscussionState.PREPARING]: 'teamRecordPreparing',
  [TeamDiscussionState.PREPARE_FAILED]: 'teamRecordPrepareFailed',
  [TeamDiscussionState.READY]: 'teamRecordReady',
  [TeamDiscussionState.SUBMITTING]: 'teamRecordSubmitting',
  [TeamDiscussionState.RUNNING]: 'teamRecordRunning',
  [TeamDiscussionState.STOPPING]: 'teamRecordStopping',
  [TeamDiscussionState.INTERRUPTED]: 'teamRecordUnconfirmed',
  [TeamDiscussionState.DELETING]: 'teamRecordDeleting',
};
const RUN_STATUS: Record<NonNullable<TeamDiscussionRoom['latestRun']>['state'], string> = {
  submitting: 'teamRecordSubmitting',
  running: 'teamRecordRunning',
  stopping: 'teamRecordStopping',
  interrupted: 'teamRecordUnconfirmed',
  completed: 'teamRecordEnded',
  failed: 'teamRecordFailed',
  cancelled: 'teamRecordStopped',
};

type DiscussionTeamMetadata = Pick<
  TeamDiscussionRoom,
  'id' | 'title' | 'sourceSessionId' | 'members' | 'state' | 'latestRun'
>;
export function buildDiscussionTeamEntry(
  room: DiscussionTeamMetadata,
  t: (key: string) => string,
): AgentTeamEntry {
  return {
    kind: AgentTeamKind.GROUP,
    key: groupTeamKey(room.id),
    roomId: room.id,
    label: `${t('teamGroup')} · ${room.title}`,
    memberCount: room.members.filter(member => !member.deleted).length,
    statusKey:
      room.state === TeamDiscussionState.READY && room.latestRun
        ? (RUN_STATUS[room.latestRun.state] ?? 'teamRecordUnconfirmed')
        : (GROUP_STATUS[room.state] ?? 'teamRecordUnconfirmed'),
  };
}

/** Shared navigation identities and content-free metadata for the header menu and team tabs. */
export function buildAgentTeamEntries(
  sessionId: string,
  collaborations: readonly CollaborationRoomEntry[],
  groups: readonly DiscussionTeamMetadata[],
  t: (key: string) => string,
): AgentTeamEntry[] {
  const tasks: AgentTeamEntry[] = collaborations
    .filter(
      room =>
        room.anchorSessionId === sessionId ||
        room.members.some(member => member.sessionId === sessionId),
    )
    .flatMap(room =>
      room.rounds?.length
        ? room.rounds.map((round, index) => ({
            kind: AgentTeamKind.TASK,
            key: `task:${room.id}:${round.id}`,
            roomId: room.id,
            roundId: round.id,
            label: `${t('teamTask')} · ${index + 1}`,
            memberCount: room.members.length,
            statusKey: room.deleting ? 'teamRecordDeleting' : ROUND_STATUS[round.state],
          }))
        : [
            {
              kind: AgentTeamKind.TASK,
              key: `task:${room.id}`,
              roomId: room.id,
              label: t('teamTask'),
              memberCount: room.members.length,
              statusKey: room.deleting ? 'teamRecordDeleting' : 'teamRecordReady',
            },
          ],
    );
  return [
    ...tasks,
    ...groups
      .filter(room => room.sourceSessionId === sessionId)
      .map(room => buildDiscussionTeamEntry(room, t)),
  ];
}
