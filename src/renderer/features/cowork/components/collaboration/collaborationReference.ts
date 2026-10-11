import type {
  CollaborationDelivery,
  CollaborationMember,
  CollaborationRoom,
} from '@shared/cowork/agent-team/collaboration';

import { addDraftMessageQuote } from '@/features/cowork/coworkSlice';
import { store } from '@/store';

import {
  type CollaborationQuote,
  MESSAGE_QUOTE_KIND,
  validCollaborationQuote,
} from '../composer/messageQuote';

/** Read-only fallback: fresh managed identities, no direct peer send or source submission. */
export async function prepareCollaborationReference(
  room: CollaborationRoom,
  member: CollaborationMember,
  name: string,
  delivery: CollaborationDelivery | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent() || room.deleting || member.sessionId === room.anchorSessionId)
    throw new Error('collaborationInvalidRecipient');
  const result = await window.electron.collaboration.read(room.anchorSessionId);
  if (!result.success) throw new Error(result.error);
  const current = result.value.room;
  if (
    !isCurrent() ||
    !current ||
    current.deleting ||
    current.id !== room.id ||
    current.anchorSessionId !== room.anchorSessionId ||
    !current.members.some(
      candidate =>
        candidate.agentId === member.agentId &&
        candidate.sessionId === member.sessionId &&
        candidate.sessionKey === member.sessionKey,
    ) ||
    (delivery &&
      !result.value.deliveries.some(
        candidate =>
          candidate.id === delivery.id &&
          candidate.roomId === room.id &&
          candidate.roundId === delivery.roundId &&
          (candidate.to === member.agentId || candidate.from === member.agentId),
      ))
  )
    throw new Error('collaborationInvalidRecipient');
  const quote: CollaborationQuote = {
    kind: MESSAGE_QUOTE_KIND.COLLABORATION,
    id: `collaboration:${room.id}:${member.sessionId}:${delivery?.id ?? 'member'}`,
    text: name,
    roomId: room.id,
    sourceSessionId: room.anchorSessionId,
    targetAgentId: member.agentId,
    targetSessionId: member.sessionId,
    targetSessionKey: member.sessionKey,
    ...(delivery ? { priorRoundId: delivery.roundId, deliveryId: delivery.id } : {}),
  };
  if (
    !validCollaborationQuote(quote) ||
    store.getState().cowork.currentSession?.id !== room.anchorSessionId
  )
    throw new Error('collaborationInvalidRecipient');
  const quotes = store.getState().cowork.draftMessageQuotes[room.anchorSessionId] ?? [];
  if (quotes.some(item => item.kind === MESSAGE_QUOTE_KIND.COLLABORATION && item.id === quote.id))
    return;
  if (quotes.length >= 8) throw new Error('teamReferenceLimit');
  store.dispatch(addDraftMessageQuote({ draftKey: room.anchorSessionId, quote }));
}
