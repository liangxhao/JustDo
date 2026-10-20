import {
  parseTeamDiscussionSessionKey,
  type TeamDiscussionExecution,
  type TeamDiscussionRoom,
} from '../../../contracts/teamDiscussion';
import { CoworkInteractionKind } from '@app-plugin/sdk/interactions';

import type { CoworkInteractionRequest } from '@app-plugin/sdk/application';

/** Only exact room identities establish group attention; free-text @user is not a request. */
export function discussionQuestionAgents(
  room: TeamDiscussionRoom,
  interactions: readonly CoworkInteractionRequest[],
): string[] {
  return [
    ...new Set(
      interactions.flatMap(interaction => {
        if (interaction.interactionKind !== CoworkInteractionKind.STRUCTURED_QUESTION) return [];
        const group = parseTeamDiscussionSessionKey(interaction.toolInput.sessionKey);
        return group?.roomId === room.id &&
          room.members.some(member => member.agentId === group.agentId && !member.deleted)
          ? [group.agentId]
          : [];
      }),
    ),
  ];
}

export function discussionRunningAgents(
  room: TeamDiscussionRoom,
  discussionId: string | undefined,
  executions: readonly TeamDiscussionExecution[],
): string[] {
  if (!discussionId || room.state !== 'running') return [];
  const latest = new Map<string, TeamDiscussionExecution>();
  for (const execution of executions) {
    if (execution.discussionId === discussionId) latest.set(execution.agentId, execution);
  }
  return room.members
    .filter(member => !member.deleted && latest.get(member.agentId)?.outcome === 'running')
    .map(member => member.agentId);
}
