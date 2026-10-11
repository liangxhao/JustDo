/** Group discussions have independent identities; they never reuse peer rooms. */
export const TEAM_DISCUSSION_CHANNEL = 'justdo-team';
export const TEAM_DISCUSSION_MAX_MEMBERS = 6;
export const TEAM_DISCUSSION_MAX_ROUNDS = 4;
export const TEAM_DISCUSSION_MAX_PENDING_INPUTS = 3;
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
export interface TeamDiscussionHoldingIdentity {
  roomId: string;
  generation: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
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
export const TeamDiscussionIpc = {
  Participation: 'teamDiscussion:participation',
  CreateTask: 'teamDiscussion:createTask',
  List: 'teamDiscussion:list',
  Create: 'teamDiscussion:create',
  Read: 'teamDiscussion:read',
  Send: 'teamDiscussion:send',
  Enqueue: 'teamDiscussion:enqueue',
  CancelPending: 'teamDiscussion:cancelPending',
  Stop: 'teamDiscussion:stop',
  Delete: 'teamDiscussion:delete',
} as const;
export const TeamDiscussionGateway = {
  Summary: 'teamDiscussion.summary',
  OfflineControl: 'teamDiscussion.offlineControl',
  Close: 'teamDiscussion.close',
  Validate: 'teamDiscussion.validate',
  Health: 'teamDiscussion.health',
  Start: 'teamDiscussion.start',
  Status: 'teamDiscussion.status',
  Prepare: 'teamDiscussion.prepare',
  Stop: 'teamDiscussion.stop',
  History: 'teamDiscussion.history',
  HoldingPrepare: 'teamDiscussion.holdingPrepare',
  HoldingSave: 'teamDiscussion.holdingSave',
  HoldingRead: 'teamDiscussion.holdingRead',
  HoldingStatus: 'teamDiscussion.holdingStatus',
  HoldingCancel: 'teamDiscussion.holdingCancel',
  HoldingClose: 'teamDiscussion.holdingClose',
} as const;
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
export type TeamDiscussionResult<T> =
  { success: true; value: T } | { success: false; error: string };
export interface TeamDiscussionSend {
  roomId: string;
  requestId: string;
  expectedRevision: number;
  message: string;
  attachmentPaths?: string[];
  quotes?: { messageId: string; discussionId: string }[];
  selectedAgentIds: string[];
  rounds: number;
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
export interface TeamDiscussionExecution {
  discussionId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runId: string;
  outcome?: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface TeamDiscussionRunSummary {
  discussionId: string;
  requestId: string;
  state: string;
}

export interface TeamDiscussionSource {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
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

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('teamDiscussionInvalidInput');
  }
  return value as Record<string, unknown>;
};
export function isTeamDiscussionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function isTeamDiscussionAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}
export function parseTeamDiscussionRounds(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > TEAM_DISCUSSION_MAX_ROUNDS
  ) {
    throw new Error('teamDiscussionInvalidInput');
  }
  return value as number;
}
export function parseTeamDiscussionAgentIds(value: unknown, minimum = 0): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > TEAM_DISCUSSION_MAX_MEMBERS ||
    value.some(id => !isTeamDiscussionAgentId(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('teamDiscussionInvalidMembers');
  }
  return [...value] as string[];
}
export function parseTeamDiscussionSend(value: unknown): TeamDiscussionSend {
  const input = record(value);
  const allowed = [
    'roomId',
    'requestId',
    'expectedRevision',
    'message',
    'selectedAgentIds',
    'rounds',
    'attachmentPaths',
    'quotes',
  ];
  if (
    Object.keys(input).some(key => !allowed.includes(key)) ||
    !isTeamDiscussionId(input.roomId) ||
    !isTeamDiscussionId(input.requestId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    (input.expectedRevision as number) < 1 ||
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.length > 16000
  ) {
    throw new Error('teamDiscussionInvalidInput');
  }
  return {
    roomId: input.roomId,
    requestId: input.requestId,
    expectedRevision: input.expectedRevision as number,
    message: input.message,
    ...(input.attachmentPaths === undefined
      ? {}
      : { attachmentPaths: parseTeamDiscussionAttachments(input.attachmentPaths) }),
    ...(input.quotes === undefined ? {} : { quotes: parseTeamDiscussionQuotes(input.quotes) }),
    // Required even for broadcast; an invalid selection cannot default to [].
    selectedAgentIds: parseTeamDiscussionAgentIds(input.selectedAgentIds),
    rounds: parseTeamDiscussionRounds(input.rounds),
  };
}
/** Pure canonical representation; hashing belongs to the owning process. */
export function serializeTeamDiscussionSend(send: TeamDiscussionSend): string {
  return JSON.stringify([
    send.roomId,
    send.expectedRevision,
    send.message,
    [...send.selectedAgentIds].sort(),
    send.rounds,
    send.attachmentPaths ?? [],
    send.quotes ?? [],
  ]);
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
export function teamDiscussionSessionKey(roomId: string, agentId: string): string {
  if (!isTeamDiscussionId(roomId) || !isTeamDiscussionAgentId(agentId)) {
    throw new Error('teamDiscussionInvalidInput');
  }
  return `agent:${agentId}:${TEAM_DISCUSSION_CHANNEL}:group:${roomId}`;
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

export function parseTeamDiscussionAttachments(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    value.some(
      item => typeof item !== 'string' || !item.trim() || item.length > 4096 || item.includes('\0'),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error('teamDiscussionInvalidInput');
  return [...value] as string[];
}

export function parseTeamDiscussionSessionKey(
  value: unknown,
): { roomId: string; agentId: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^agent:([a-z0-9][a-z0-9_-]{0,63}):justdo-team:group:([a-zA-Z0-9_-]{1,128})$/.exec(
    value,
  );
  return match ? { agentId: match[1], roomId: match[2] } : null;
}

export function parseTeamDiscussionQuotes(
  value: unknown,
): { messageId: string; discussionId: string }[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('teamDiscussionInvalidInput');
  return value.map(item => {
    const quote = record(item);
    if (
      !isTeamDiscussionId(quote.discussionId) ||
      typeof quote.messageId !== 'string' ||
      !quote.messageId ||
      quote.messageId.length > 512 ||
      quote.messageId.includes('\0') ||
      Object.keys(quote).some(key => !['messageId', 'discussionId'].includes(key))
    )
      throw new Error('teamDiscussionInvalidInput');
    return { discussionId: quote.discussionId, messageId: quote.messageId };
  });
}
