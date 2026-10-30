import {
  discussionRecord as record,
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  type TeamDiscussionExecution,
  TeamDiscussionGateway as RequiredTeamDiscussionGateway,
  type TeamDiscussionSend,
} from './discussionInput';

export * from './discussionInput';

export const TeamDiscussionGateway = {
  ...RequiredTeamDiscussionGateway,
  Summary: 'teamDiscussion.summary',
  Close: 'teamDiscussion.close',
  Validate: 'teamDiscussion.validate',
  Health: 'teamDiscussion.health',
  Start: 'teamDiscussion.start',
  Status: 'teamDiscussion.status',
  Prepare: 'teamDiscussion.prepare',
  Stop: 'teamDiscussion.stop',
  History: 'teamDiscussion.history',
} as const;

/** Group discussions have independent identities; they never reuse peer rooms. */
export const TEAM_DISCUSSION_CHANNEL = 'agent-team';

export interface TeamDiscussionMessage {
  id: string;
  discussionId: string;
  sequence: number;
  agentId?: string;
  role: 'user' | 'assistant';
  origin?: 'organizer';
  text: string;
  timestamp: number;
  mediaUrls: string[];
}

export interface TeamDiscussionSource {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
}

/** Exact batch locators, never a request to read arbitrary native sessions. */
export function parseTeamDiscussionIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    value.some(id => !isTeamDiscussionId(id)) ||
    new Set(value).size !== value.length
  )
    throw new Error('teamDiscussionInvalidInput');
  return [...value];
}

export function teamDiscussionSessionKey(roomId: string, agentId: string): string {
  if (!isTeamDiscussionId(roomId) || !isTeamDiscussionAgentId(agentId)) {
    throw new Error('teamDiscussionInvalidInput');
  }
  return `agent:${agentId}:${TEAM_DISCUSSION_CHANNEL}:group:${roomId}`;
}

export function parseTeamDiscussionSessionKey(
  value: unknown,
): { roomId: string; agentId: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^agent:([a-z0-9][a-z0-9_-]{0,63}):agent-team:group:([a-zA-Z0-9_-]{1,128})$/.exec(
    value,
  );
  return match ? { agentId: match[1], roomId: match[2] } : null;
}

export type TeamDiscussionPendingState =
  | 'receiving'
  | 'receiving_unknown'
  | 'queued'
  | 'dispatching'
  | 'unknown'
  | 'blocked'
  | 'dispatched'
  | 'cancelled'
  | 'failed';

/** Product metadata only. Pending body stays in the native inert session. */
export interface TeamDiscussionPendingInput {
  requestId: string;
  state: TeamDiscussionPendingState;
  createdAt: number;
  rounds: number;
  selectedAgentIds: string[];
  reason?: string;
  /** Read-only native projection, never part of product persistence. */
  message?: string;
}

export const TeamDiscussionState = {
  PREPARING: 'preparing',
  PREPARE_FAILED: 'prepare_failed',
  READY: 'ready',
  SUBMITTING: 'submitting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  INTERRUPTED: 'interrupted',
  DELETING: 'deleting',
} as const;

export type TeamDiscussionState = (typeof TeamDiscussionState)[keyof typeof TeamDiscussionState];

export interface TeamDiscussionMember {
  agentId: string;
  name: string;
  sessionId?: string;
  lifecycleRevision?: string;
  deleted?: boolean;
  ownership?: 'source';
  sessionKey?: string;
}

export interface TeamDiscussionRoom {
  id: string;
  title: string;
  members: TeamDiscussionMember[];
  rounds: number;
  revision: number;
  generation: number;
  state: TeamDiscussionState;
  activeDiscussionId?: string;
  sourceSessionId?: string;
  latestRun?: TeamDiscussionRunSummary;
  pendingInputs?: TeamDiscussionPendingInput[];
  summarySource?: TeamDiscussionSource;
  linkedTaskIds?: string[];
  cwd: string;
  permissionMode: 'ask' | 'auto' | 'full';
  readOnly?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Gateway-only identity supplied by Main, never accepted in renderer/model send input. */
export type TeamDiscussionInitiator =
  { kind: 'user' } | { kind: 'organizer'; agentId: string; name: string };

export function parseTeamDiscussionInitiator(value: unknown): TeamDiscussionInitiator {
  if (value === undefined) return { kind: 'user' };
  const input = record(value);
  if (input.kind === 'user' && Object.keys(input).length === 1) return { kind: 'user' };
  if (
    input.kind === 'organizer' &&
    Object.keys(input).every(key => ['kind', 'agentId', 'name'].includes(key)) &&
    isTeamDiscussionAgentId(input.agentId) &&
    typeof input.name === 'string' &&
    input.name.trim() &&
    input.name.length <= 200
  )
    return { kind: 'organizer', agentId: input.agentId, name: input.name };
  throw new Error('teamDiscussionInvalidInput');
}

export interface TeamDiscussionRunSummary {
  discussionId: string;
  requestId: string;
  state: string;
}

export interface TeamDiscussionSummary {
  discussionId: string;
  state: 'pending' | 'running' | 'stopping' | 'delivered' | 'failed' | 'cancelled' | 'unknown';
  runId?: string;
}

export interface TeamDiscussionReadResult {
  room: TeamDiscussionRoom;
  messages: TeamDiscussionMessage[];
  historyUnavailable: boolean;
  executions: TeamDiscussionExecution[];
  previousCursor?: string;
  discussionIds?: string[];
  latestRun?: TeamDiscussionRunSummary;
  runs?: TeamDiscussionRunSummary[];
  organizer?: { agentId: string; name: string; sourceSessionId: string };
  summary?: TeamDiscussionSummary;
}

export function assertTeamDiscussionRecipients(
  room: TeamDiscussionRoom,
  send: TeamDiscussionSend,
): void {
  if (room.id !== send.roomId || room.revision !== send.expectedRevision) {
    throw new Error('teamDiscussionStaleRevision');
  }
  if (send.selectedAgentIds.some(id => !room.members.some(member => member.agentId === id))) {
    throw new Error('teamDiscussionInvalidMembers');
  }
}

export function discussionMemberSessionKey(room: TeamDiscussionRoom, agentId: string): string {
  const member = room.members.find(item => item.agentId === agentId);
  if (member?.ownership !== 'source') return teamDiscussionSessionKey(room.id, agentId);
  const source = room.summarySource;
  if (
    !source ||
    source.agentId !== agentId ||
    member.sessionId !== source.sessionId ||
    member.lifecycleRevision !== source.lifecycleRevision ||
    member.sessionKey !== source.sessionKey ||
    source.sessionKey !== `agent:${agentId}:justdo:${room.sourceSessionId}`
  )
    throw new Error('teamDiscussionSessionChanged');
  return source.sessionKey;
}
