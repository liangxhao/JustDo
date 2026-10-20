import { recognizeAgentTeamMode } from '../../plugins/extensions/agent-team/prompt/agentTeamPrompt';
import type { AppSessionParticipants } from '../../src/main/plugins/app/sessionParticipants';

/** Legacy coordinator fixtures feed the new generic host boundary, never production IPC. */
export function behaviorSessionParticipants(
  collaboration?: any,
  launch?: any,
): AppSessionParticipants {
  const room = (id: string) => collaboration?.read?.(id.replace(/(?:-peer)+$/u, ''))?.room;
  return {
    isDeleting: (id: string) => collaboration?.isSourceDeleting?.(id) ?? false,
    isManaged: (id: string) => !!room(id),
    expandResources: (ids: string[]) => [
      ...new Set(
        ids.flatMap(id => room(id)?.members?.map((member: any) => member.sessionId) ?? [id]),
      ),
    ],
    acquireDeletion: (ids: string[]) => collaboration?.acquireSourceDeletion?.(ids) ?? (() => {}),
    prepareDelete: async () => {},
    confirmDeleted: () => {},
    deleteManaged: (id: string) => collaboration?.deleteTask?.(id) ?? false,
    matches: (prompt: string) => !!launch && recognizeAgentTeamMode(prompt) !== undefined,
    register: (input: unknown) => launch?.register?.(input),
    markSubmissionStarted: (id: string, turn: string) => launch?.markSubmissionStarted?.(id, turn),
    abortBeforeSend: (id: string, turn: string) => launch?.abortBeforeSend?.(id, turn) ?? true,
    cancel: async (id: string, turn: string) => launch?.cancel?.(id, turn),
    releaseIfSettled: (id: string) => launch?.releaseIfSettled?.(id) ?? Promise.resolve(true),
  } as unknown as AppSessionParticipants;
}
