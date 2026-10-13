/** Product metadata only. Message bodies and execution remain in OpenClaw. */
export const CollaborationDeliveryState = {
  QUEUED: 'queued',
  DISPATCHING: 'dispatching',
  ACCEPTED: 'accepted',
  UNKNOWN: 'unknown',
  FAILED: 'failed',
} as const;

export type CollaborationDeliveryState =
  (typeof CollaborationDeliveryState)[keyof typeof CollaborationDeliveryState];

export const COLLABORATION_MAX_MEMBERS = 12;

export const COLLABORATION_MESSAGE_BUDGET = 16;

export interface CollaborationMember {
  agentId: string;
  sessionId: string;
  sessionKey: string;
}

export interface CollaborationRoom {
  deleting?: boolean;
  id: string;
  anchorSessionId: string;
  members: CollaborationMember[];
}

/** Navigation metadata; batches reuse the room's native member conversations. */
export interface CollaborationRoomEntry extends CollaborationRoom {
  rounds: CollaborationRound[];
}

export interface CollaborationDelivery {
  /** Admission and whole-run execution are independent facts. */
  executionOutcome?: 'completed' | 'failed' | 'cancelled';
  id: string;
  roomId: string;
  roundId: string;
  from: string;
  to: string;
  toolCallId: string;
  sourceRunId: string;
  inReplyTo?: string;
  state: CollaborationDeliveryState;
  createdAt: number;
  updatedAt: number;
  runId?: string;
}

export interface CollaborationSendInput {
  to: string;
  message: string;
  inReplyTo?: string;
}

export function parseCollaborationSend(value: unknown): CollaborationSendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('collaborationInvalidMessage');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['to', 'message', 'inReplyTo'].includes(key))) {
    throw new Error('collaborationInvalidMessage');
  }
  if (
    typeof input.to !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.to) ||
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.length > 16000 ||
    (input.inReplyTo !== undefined &&
      (typeof input.inReplyTo !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.inReplyTo)))
  )
    throw new Error('collaborationInvalidMessage');
  return {
    to: input.to,
    message: input.message,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo as string } : {}),
  };
}

export function validateCollaborationRoom(room: CollaborationRoom): void {
  if (
    !room.id ||
    !room.anchorSessionId ||
    room.members.length < 2 ||
    room.members.length > COLLABORATION_MAX_MEMBERS ||
    !room.members.some(member => member.sessionId === room.anchorSessionId) ||
    new Set(room.members.map(member => member.agentId)).size !== room.members.length ||
    new Set(room.members.map(member => member.sessionId)).size !== room.members.length ||
    new Set(room.members.map(member => member.sessionKey)).size !== room.members.length ||
    room.members.some(
      member =>
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.agentId) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(member.sessionId) ||
        member.sessionKey !== `agent:${member.agentId}:justdo:${member.sessionId}`,
    )
  )
    throw new Error('collaborationInvalidMembers');
}

export function resolveCollaborationRoute(
  room: CollaborationRoom,
  sourceSessionKey: string,
  input: CollaborationSendInput,
  reply?: CollaborationDelivery,
): { source: CollaborationMember; target: CollaborationMember } {
  validateCollaborationRoom(room);
  const source = room.members.find(member => member.sessionKey === sourceSessionKey);
  const target = room.members.find(member => member.agentId === input.to);
  if (!source || !target || source === target) throw new Error('collaborationInvalidRecipient');
  if (
    input.inReplyTo &&
    (!reply ||
      reply.id !== input.inReplyTo ||
      reply.roomId !== room.id ||
      reply.to !== source.agentId ||
      reply.from !== target.agentId ||
      reply.state !== CollaborationDeliveryState.ACCEPTED)
  )
    throw new Error('collaborationInvalidReply');
  return { source, target };
}

export function canTransitionCollaborationDelivery(
  from: CollaborationDeliveryState,
  to: CollaborationDeliveryState,
): boolean {
  if (from === to) return false;
  switch (from) {
    case CollaborationDeliveryState.QUEUED:
      return (
        to === CollaborationDeliveryState.DISPATCHING || to === CollaborationDeliveryState.FAILED
      );
    case CollaborationDeliveryState.DISPATCHING:
      return (
        to === CollaborationDeliveryState.ACCEPTED ||
        to === CollaborationDeliveryState.UNKNOWN ||
        to === CollaborationDeliveryState.FAILED
      );
    case CollaborationDeliveryState.UNKNOWN:
      // Reconciliation needs native evidence. Never automatically redeliver an unknown send.
      return to === CollaborationDeliveryState.ACCEPTED || to === CollaborationDeliveryState.FAILED;
    default:
      return false;
  }
}

export interface CollaborationContinueTarget {
  sourceSessionId: string;
  sourceAgentId: string;
  roomId: string;
  targetAgentId: string;
  targetSessionId: string;
  targetSessionKey: string;
  priorDeliveryId?: string;
}

export const CollaborationGateway = {
  Requested: 'plugin.agent-team.requested',
  Resolve: 'collaboration.resolve',
  Health: 'collaboration.health',
  Messages: 'collaboration.messages',
} as const;

export interface CollaborationSnapshot {
  room?: CollaborationRoom;
  deliveries: CollaborationDelivery[];
  rounds?: CollaborationRound[];
  reviews?: CollaborationReview[];
}

export const CollaborationReviewVerdict = {
  PASSED: 'passed',
  CHANGES_REQUESTED: 'changes_requested',
  UNVERIFIED: 'unverified',
} as const;

export type CollaborationReviewVerdict =
  (typeof CollaborationReviewVerdict)[keyof typeof CollaborationReviewVerdict];

export const CollaborationReviewState = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  UNCONFIRMED: 'unconfirmed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type CollaborationReviewState =
  (typeof CollaborationReviewState)[keyof typeof CollaborationReviewState];

export interface CollaborationReviewInput {
  deliveryIds: string[];
  verdict: CollaborationReviewVerdict;
}

/** Verdict metadata only; criteria, findings and evidence remain in native history. */
export interface CollaborationReview extends CollaborationReviewInput {
  id: string;
  roomId: string;
  roundId: string;
  reviewerAgentId: string;
  reviewDeliveryId: string;
  runId: string;
  state: CollaborationReviewState;
  createdAt: number;
}

export function parseCollaborationReview(value: unknown): CollaborationReviewInput {
  const invalid = () => new Error('collaborationInvalidReview');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(key => !['deliveryIds', 'verdict'].includes(key)) ||
    !Array.isArray(input.deliveryIds) ||
    !input.deliveryIds.length ||
    input.deliveryIds.length > COLLABORATION_MESSAGE_BUDGET ||
    input.deliveryIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) ||
    new Set(input.deliveryIds).size !== input.deliveryIds.length ||
    !Object.values(CollaborationReviewVerdict).includes(input.verdict as CollaborationReviewVerdict)
  )
    throw invalid();
  return {
    deliveryIds: [...input.deliveryIds].sort() as string[],
    verdict: input.verdict as CollaborationReviewVerdict,
  };
}

export interface CollaborationRound {
  id: string;
  state: 'open' | 'closing' | 'settled' | 'failed' | 'stopped';
  pending: number;
  closingRunId?: string;
}

export interface CollaborationMessageResult {
  deliveryId: string;
  message?: unknown;
}

export interface CollaborationStopMemberInput {
  sourceSessionId: string;
  roomId: string;
  targetSessionKey: string;
  nativeSessionId: string;
  runId: string;
}

export interface CollaborationContinuePreparation {
  sourceSessionId: string;
  roomId: string;
  targetSessionKey: string;
  priorDeliveryId?: string;
}
