import {
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  TEAM_DISCUSSION_CHANNEL,
} from '../../contracts/teamDiscussion';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Public group output belongs to the group timeline, not a member's execution history. */
export function isTeamDiscussionReplyMirror(message: unknown): boolean {
  const outer = asRecord(message);
  const raw = asRecord(outer?.message) ?? outer;
  const mirror = asRecord(raw?.openclawDeliveryMirror);
  const delivery = asRecord(raw?.openclawDelivery);
  if (
    raw?.role !== 'assistant' ||
    raw.provider !== 'openclaw' ||
    raw.model !== 'delivery-mirror' ||
    mirror?.kind !== 'channel-final' ||
    !isTeamDiscussionAgentId(delivery?.speakerAgentId) ||
    typeof mirror.sourceMessageId !== 'string'
  )
    return false;
  const [channel, roomId, discussionId, sequence, extra] = mirror.sourceMessageId.split(':');
  return (
    channel === TEAM_DISCUSSION_CHANNEL &&
    isTeamDiscussionId(roomId) &&
    isTeamDiscussionId(discussionId) &&
    /^[1-9]\d*$/.test(sequence ?? '') &&
    Number.isSafeInteger(Number(sequence)) &&
    extra === undefined
  );
}
