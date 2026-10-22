export const TEAM_DISCUSSION_MAX_MEMBERS = 6;

export const TEAM_DISCUSSION_MAX_ROUNDS = 4;

export const TEAM_DISCUSSION_MAX_PENDING_INPUTS = 3;

export interface TeamDiscussionHoldingIdentity {
  roomId: string;
  generation: number;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
}

export const TeamDiscussionGateway = {
  OfflineControl: 'teamDiscussion.offlineControl',
  HoldingPrepare: 'teamDiscussion.holdingPrepare',
  HoldingSave: 'teamDiscussion.holdingSave',
  HoldingRead: 'teamDiscussion.holdingRead',
  HoldingStatus: 'teamDiscussion.holdingStatus',
  HoldingCancel: 'teamDiscussion.holdingCancel',
  HoldingClose: 'teamDiscussion.holdingClose',
} as const;

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

export interface TeamDiscussionExecution {
  discussionId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  runId: string;
  outcome?: 'running' | 'completed' | 'failed' | 'cancelled';
}

export const discussionRecord = (value: unknown): Record<string, unknown> => {
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
  const input = discussionRecord(value);
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

export function parseTeamDiscussionQuotes(
  value: unknown,
): { messageId: string; discussionId: string }[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('teamDiscussionInvalidInput');
  return value.map(item => {
    const quote = discussionRecord(item);
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
