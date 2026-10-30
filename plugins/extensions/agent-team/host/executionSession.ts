import type {
  AppExecutionSessionOwner,
  AppExecutionSessionQuery,
  AppMainHost,
} from '@app-plugin/sdk/main';

import { CollaborationDeliveryState } from '../contracts/collaboration';
import {
  discussionMemberSessionKey,
  TeamDiscussionGateway,
  TeamDiscussionState,
  type TeamDiscussionExecution,
} from '../contracts/teamDiscussion';
import { CollaborationStore } from './data/collaborationStore';
import { TeamDiscussionStore } from './data/teamDiscussionStore';

const label = (value: string) =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, 256);

/** Navigation only: every tool continues under its own exact Native session. */
export async function resolveTeamExecutionSession(
  host: AppMainHost,
  query: AppExecutionSessionQuery,
): Promise<AppExecutionSessionOwner | null> {
  if (!query.runId) return null;
  const groups = new TeamDiscussionStore(host.getDatabase());
  const peers = new CollaborationStore(host.getDatabase());
  const sessions = host.getSessions();
  const candidates = groups.list().flatMap(room => {
    const member = room.members.find(
      item =>
        !item.deleted &&
        discussionMemberSessionKey(room, item.agentId) === query.sessionKey &&
        item.sessionId === query.nativeSessionId &&
        (query.lifecycleRevision === undefined ||
          item.lifecycleRevision === query.lifecycleRevision),
    );
    if (
      !member ||
      !room.activeDiscussionId ||
      (room.sourceSessionId && !sessions.getSession(room.sourceSessionId))
    )
      return [];
    return [
      {
        room,
        member,
        fingerprint: JSON.stringify([
          room.id,
          room.revision,
          room.generation,
          room.state,
          room.activeDiscussionId,
          room.sourceSessionId,
          room.members,
        ]),
      },
    ];
  });
  const claims: {
    owner: AppExecutionSessionOwner;
    roomId: string;
    fingerprint: string;
    lifecycleRevision?: string;
  }[] = [];
  for (const candidate of candidates) {
    if (
      candidate.room.state === TeamDiscussionState.STOPPING ||
      candidate.room.state === TeamDiscussionState.DELETING
    )
      return null;
    const status = await host.requestConnectedGateway<{
      roomId?: string;
      discussionId?: string;
      executions?: TeamDiscussionExecution[];
    }>(TeamDiscussionGateway.Status, {
      roomId: candidate.room.id,
      discussionId: candidate.room.activeDiscussionId,
    });
    host.assertActive();
    const current = groups.get(candidate.room.id);
    if (
      !current ||
      JSON.stringify([
        current.id,
        current.revision,
        current.generation,
        current.state,
        current.activeDiscussionId,
        current.sourceSessionId,
        current.members,
      ]) !== candidate.fingerprint
    )
      return null;
    const execution = status.executions?.find(
      item =>
        item.runId === query.runId &&
        item.agentId === candidate.member.agentId &&
        item.sessionKey === query.sessionKey &&
        item.sessionId === query.nativeSessionId &&
        item.lifecycleRevision === candidate.member.lifecycleRevision &&
        (item.outcome === undefined || item.outcome === 'running'),
    );
    if (
      status.roomId !== current.id ||
      status.discussionId !== current.activeDiscussionId ||
      !execution
    )
      continue;
    if (current.sourceSessionId && !sessions.getSession(current.sourceSessionId)) return null;
    claims.push({
      owner: {
        ...(current.sourceSessionId ? { ownerSessionId: current.sourceSessionId } : {}),
        label: label(`${candidate.member.name} · ${current.title}`),
      },
      roomId: current.id,
      fingerprint: candidate.fingerprint,
      lifecycleRevision: candidate.member.lifecycleRevision,
    });
  }
  if (claims.length > 1) return null;
  const native = await host.requestConnectedGateway<{
    session?: {
      key?: string;
      sessionId?: string;
      lifecycleRevision?: string | null;
      activeRunIds?: string[];
    } | null;
  }>('sessions.describe', { key: query.sessionKey });
  host.assertActive();
  if (
    native.session?.key !== query.sessionKey ||
    native.session.sessionId !== query.nativeSessionId ||
    (query.lifecycleRevision !== undefined &&
      native.session.lifecycleRevision !== query.lifecycleRevision) ||
    (Array.isArray(native.session.activeRunIds) &&
      !native.session.activeRunIds.includes(query.runId))
  )
    return null;
  if (claims.length === 1) {
    const claim = claims[0];
    const current = groups.get(claim.roomId);
    if (
      !current ||
      JSON.stringify([
        current.id,
        current.revision,
        current.generation,
        current.state,
        current.activeDiscussionId,
        current.sourceSessionId,
        current.members,
      ]) !== claim.fingerprint ||
      native.session.lifecycleRevision !== claim.lifecycleRevision ||
      (current.sourceSessionId && !sessions.getSession(current.sourceSessionId))
    )
      return null;
    return claim.owner;
  }
  // Ordinary peers already have real product bindings. Missing Native run
  // metadata leaves their Core fallback intact; never read history for a label.
  if (!native.session.activeRunIds?.includes(query.runId)) return null;
  const rooms = peers
    .listRooms()
    .filter(
      room =>
        !room.deleting &&
        room.members.some(
          member =>
            member.sessionKey === query.sessionKey && member.sessionId !== room.anchorSessionId,
        ),
    );
  if (rooms.length !== 1) return null;
  const room = rooms[0];
  const member = room.members.find(item => item.sessionKey === query.sessionKey)!;
  const product = sessions.getSession(member.sessionId);
  if (
    !product ||
    product.agentId !== member.agentId ||
    (product.nativeSessionKey !== undefined && product.nativeSessionKey !== query.sessionKey) ||
    (product.historyBinding &&
      (product.historyBinding.sessionKey !== query.sessionKey ||
        product.historyBinding.nativeSessionId !== query.nativeSessionId))
  )
    return null;
  // A member detail chat is an independent product conversation. Room membership
  // alone cannot move that user's browser or question to the organizer. Only an
  // exact incoming delivery associates this Native run with a collaboration.
  const deliveries = peers.listDeliveries(room.id);
  const incoming = deliveries.filter(
    delivery => delivery.to === member.agentId && delivery.runId === query.runId,
  );
  if (incoming.length > 1) return null;
  if (incoming.length === 1) {
    const delivery = incoming[0];
    if (
      (delivery.state !== CollaborationDeliveryState.DISPATCHING &&
        delivery.state !== CollaborationDeliveryState.ACCEPTED) ||
      delivery.executionOutcome !== undefined ||
      peers.isRoundStopped(delivery.roundId)
    )
      return null;
    const owner = sessions.getSession(room.anchorSessionId);
    if (!owner) return null;
    return {
      ownerSessionId: owner.id,
      label: label(sessions.getAgent(member.agentId)?.name ?? member.agentId),
    };
  }
  return {
    ownerSessionId: product.id,
    label: label(sessions.getAgent(member.agentId)?.name ?? member.agentId),
    // An unconfirmed send can start this member before its sender reports the
    // Native run ID. Retain the exact query, but do not publish or use this
    // provisional location until a receipt-driven host refresh resolves it.
    ...(deliveries.some(
      delivery =>
        delivery.to === member.agentId &&
        !delivery.runId &&
        (delivery.state === CollaborationDeliveryState.DISPATCHING ||
          delivery.state === CollaborationDeliveryState.UNKNOWN),
    )
      ? { pending: true as const }
      : {}),
  };
}
