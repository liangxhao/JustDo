type TeamDiscussionResult<T> = { success: true; value: T } | { success: false; error: string };
import type { TeamDiscussionRoom, TeamDiscussionSend } from '../../contracts/teamDiscussion';
type AgentResult<T> = { success: true; value: T } | { success: false; error: string };
export interface TeamApis {
  teamDiscussion: {
    participation: (input: {
      roomId: string;
      expectedRevision: number;
      enabled: boolean;
    }) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    createTask: (input: {
      roomId: string;
      requestId: string;
    }) => Promise<TeamDiscussionResult<string>>;
    list: () => Promise<TeamDiscussionResult<TeamDiscussionRoom[]>>;
    create: (input: unknown) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    read: (
      id: string,
      beforeDiscussionId?: string,
      exactDiscussionIds?: string[],
    ) => Promise<
      TeamDiscussionResult<import('../../contracts/teamDiscussion').TeamDiscussionReadResult>
    >;
    send: (input: TeamDiscussionSend) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    enqueue: (input: TeamDiscussionSend) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    cancelPending: (input: {
      roomId: string;
      requestId: string;
    }) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    stop: (id: string) => Promise<TeamDiscussionResult<TeamDiscussionRoom>>;
    delete: (id: string) => Promise<TeamDiscussionResult<void>>;
  };
  agentTeamSettings: {
    read: () => Promise<
      TeamDiscussionResult<import('../../contracts/agentTeamSettings').AgentTeamSettingsSnapshot>
    >;
    save: (
      value: import('../../contracts/agentTeamSettings').AgentTeamSettings,
      expectedRevision: number,
    ) => Promise<
      TeamDiscussionResult<import('../../contracts/agentTeamSettings').AgentTeamSettingsSnapshot>
    >;
    readTeam: (
      kind: import('../../contracts/agentTeamSettings').AgentTeamKind,
      roomId: string,
    ) => Promise<
      TeamDiscussionResult<import('../../contracts/agentTeamSettings').AgentTeamSettingsView>
    >;
    saveTeam: (
      kind: import('../../contracts/agentTeamSettings').AgentTeamKind,
      roomId: string,
      value: import('../../contracts/agentTeamSettings').AgentTeamOverrides,
      expectedRevision: number,
    ) => Promise<
      TeamDiscussionResult<import('../../contracts/agentTeamSettings').AgentTeamSettingsView>
    >;
  };
  collaboration: {
    prepareContinuation: (
      input: import('../../contracts/collaboration').CollaborationContinuePreparation,
    ) => Promise<AgentResult<import('../../contracts/collaboration').CollaborationContinuePreparationReceipt>>;
    read: (
      sessionId: string,
    ) => Promise<AgentResult<import('../../contracts/collaboration').CollaborationSnapshot>>;
    readMessages: (
      sessionId: string,
      deliveryIds: string[],
    ) => Promise<AgentResult<import('../../contracts/collaboration').CollaborationMessageResult[]>>;
    list: () => Promise<
      AgentResult<import('../../contracts/collaboration').CollaborationRoomEntry[]>
    >;
    create: (
      sessionId: string,
      agentIds: string[],
    ) => Promise<AgentResult<import('../../contracts/collaboration').CollaborationSnapshot>>;
    stop: (sessionId: string) => Promise<AgentResult<void>>;
    stopMember: (
      input: import('../../contracts/collaboration').CollaborationStopMemberInput,
    ) => Promise<AgentResult<void>>;
  };
}
