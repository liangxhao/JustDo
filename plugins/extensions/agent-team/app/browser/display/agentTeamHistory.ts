import type { CollaborationRoomEntry } from '../teamContracts';
import type { TeamDiscussionRoom } from '../../../contracts/teamDiscussion';

import { coworkService } from '../state';
import { store } from '../state';

import { OPEN_TEAM_PANEL, openTeamPanel } from '../discussions/teamDiscussionNavigation';
import {
  type FilePreviewNavigationOptions,
  runGuardedFilePreviewNavigation,
} from '../preview/filePreviewNavigation';
import {
  type AgentTeamEntry,
  AgentTeamKind,
  buildAgentTeamEntries,
  buildDiscussionTeamEntry,
} from './agentTeamEntries';

export const OPEN_TEAM_RECORDS = 'cowork:open-team-records';
export type AgentTeamHistoryEntry = AgentTeamEntry & {
  title: string;
  memberNames: string[];
  sourceSessionId?: string;
  discussion?: TeamDiscussionRoom;
  updatedAt?: number;
};

/** Only product navigation metadata; bodies remain in native history. */
export function buildAgentTeamHistory(
  collaborations: CollaborationRoomEntry[],
  discussions: TeamDiscussionRoom[],
  sessionTitles: ReadonlyMap<string, string>,
  agentNames: ReadonlyMap<string, string>,
  t: (key: string) => string,
): AgentTeamHistoryEntry[] {
  return [
    ...collaborations.flatMap(room =>
      buildAgentTeamEntries(room.anchorSessionId, [room], [], t).map(entry => ({
        ...entry,
        title: sessionTitles.get(room.anchorSessionId) || entry.label,
        memberNames: room.members.map(member => agentNames.get(member.agentId) || member.agentId),
        sourceSessionId: room.anchorSessionId,
      })),
    ),
    ...discussions.map(room => ({
      ...buildDiscussionTeamEntry(room, t),
      title: room.title,
      memberNames: room.members.filter(member => !member.deleted).map(member => member.name),
      sourceSessionId: room.sourceSessionId,
      discussion: room,
      updatedAt: room.updatedAt,
    })),
  ];
}

export async function openTeamHistoryEntry(
  entry: AgentTeamHistoryEntry,
  navigation: {
    requestTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
    isCurrent: () => boolean;
  },
): Promise<void> {
  if (entry.kind === AgentTeamKind.GROUP && entry.discussion) {
    await openTeamPanel(entry.discussion, navigation);
    return;
  }
  await runGuardedFilePreviewNavigation(
    navigation.requestTransition,
    async () => {
      if (!navigation.isCurrent() || !entry.sourceSessionId) return;
      const loaded = await coworkService.loadSession(entry.sourceSessionId, {
        canSelect: navigation.isCurrent,
        onSelected: () => {
          if (!navigation.isCurrent()) return;
          window.dispatchEvent(
            new CustomEvent(OPEN_TEAM_PANEL, {
              detail: {
                sessionId: entry.sourceSessionId,
                roomId: entry.roomId,
                teamKey: entry.key,
              },
            }),
          );
        },
      });
      if (!navigation.isCurrent()) return;
      if (!loaded) throw new Error('teamHistoryOpenFailed');
      if (store.getState().cowork.currentSession?.id !== entry.sourceSessionId) return;
    },
    { preserveTabs: true },
  );
}
