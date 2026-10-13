import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import {
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  TEAM_DISCUSSION_CHANNEL,
  TeamDiscussionGateway,
  type TeamDiscussionMessage,
  teamDiscussionSessionKey,
} from '../contracts/teamDiscussion';

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const messageText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return Array.isArray(value)
    ? value
        .flatMap(block => {
          const item = asRecord(block);
          return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
        })
        .join('\n')
    : '';
};

/** Project native public discussion messages while Agent Team is enabled. */
export function registerDiscussionHistory(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    TeamDiscussionGateway.History,
    async ({ params, respond }) => {
      try {
        const plugins = api.runtime.config.current().plugins;
        if (
          plugins?.enabled === false ||
          plugins?.entries?.['agent-team']?.enabled !== true ||
          plugins?.deny?.includes('agent-team') ||
          (plugins?.allow?.length && !plugins.allow.includes('agent-team'))
        )
          throw new Error('Agent Team is disabled.');
        if (
          !isTeamDiscussionId(params.roomId) ||
          !Array.isArray(params.members) ||
          params.members.length > 6 ||
          !Array.isArray(params.discussionIds) ||
          params.discussionIds.length > 100 ||
          params.discussionIds.some(id => !isTeamDiscussionId(id))
        )
          throw new Error('teamDiscussionInvalidInput');
        const roomId = params.roomId;
        const order = new Map((params.discussionIds as string[]).map((id, index) => [id, index]));
        const seenInputs = new Set<string>();
        const messages: TeamDiscussionMessage[] = [];
        for (const value of params.members) {
          const member = asRecord(value);
          if (!isTeamDiscussionAgentId(member.agentId) || !isTeamDiscussionId(member.sessionId))
            throw new Error('teamDiscussionInvalidMembers');
          const key =
            typeof member.sessionKey === 'string'
              ? member.sessionKey
              : teamDiscussionSessionKey(roomId, member.agentId);
          if (
            key !== teamDiscussionSessionKey(roomId, member.agentId) &&
            !new RegExp(`^agent:${member.agentId}:justdo:[a-zA-Z0-9_-]+$`).test(key)
          )
            throw new Error('teamDiscussionInvalidMembers');
          const entries = await readVisibleSessionTranscriptMessageEntries({
            agentId: member.agentId,
            sessionId: member.sessionId,
            sessionKey: key,
          });
          for (const entry of entries) {
            const message = asRecord(entry.message);
            const native = asRecord(message.__openclaw);
            const transport = asRecord(native.transport);
            const mirror = asRecord(message.openclawDeliveryMirror);
            const isUser =
              message.role === 'user' &&
              (transport.channel === TEAM_DISCUSSION_CHANNEL || mirror.kind === 'channel-input');
            const isPublicReply = message.role === 'assistant' && mirror.kind === 'channel-final';
            const source = isUser
              ? mirror.kind === 'channel-input'
                ? mirror.sourceMessageId
                : transport.messageId
              : isPublicReply
                ? mirror.sourceMessageId
                : undefined;
            if (typeof source !== 'string') continue;
            const prefix = `justdo-team:${roomId}:`;
            if (!source.startsWith(prefix)) continue;
            const parts = source.slice(prefix.length).split(':');
            const discussionId = parts[0];
            if (!order.has(discussionId)) continue;
            const sequence = isUser ? 0 : Number(parts[1]);
            if (
              (isUser && parts.length !== 1) ||
              (!isUser && (parts.length !== 2 || !Number.isSafeInteger(sequence) || sequence < 1))
            )
              continue;
            if (isUser && seenInputs.has(source)) continue;
            if (isUser) seenInputs.add(source);
            const delivery = asRecord(message.openclawDelivery);
            // Native inbound attachments live in the canonical media envelope;
            // public delivery mirrors carry their own outbound media facts.
            const inboundMedia =
              isUser && Array.isArray(native.media)
                ? native.media.flatMap(value => {
                    const fact = asRecord(value);
                    const location =
                      typeof fact.path === 'string' && fact.path.trim()
                        ? fact.path
                        : typeof fact.url === 'string'
                          ? fact.url
                          : undefined;
                    return location?.trim() ? [location] : [];
                  })
                : [];
            messages.push({
              id: `${member.agentId}:${entry.entryId}`,
              discussionId,
              sequence,
              ...(isUser
                ? {}
                : {
                    agentId: isTeamDiscussionAgentId(delivery.speakerAgentId)
                      ? delivery.speakerAgentId
                      : member.agentId,
                  }),
              role: isUser ? 'user' : 'assistant',
              text: messageText(message.content),
              timestamp: typeof message.timestamp === 'number' ? message.timestamp : 0,
              mediaUrls: [
                ...new Set([
                  ...inboundMedia,
                  ...(Array.isArray(delivery.mediaUrls)
                    ? delivery.mediaUrls.filter((url): url is string => typeof url === 'string')
                    : []),
                ]),
              ],
            });
          }
        }
        messages.sort(
          (left, right) =>
            order.get(left.discussionId)! - order.get(right.discussionId)! ||
            left.sequence - right.sequence ||
            left.id.localeCompare(right.id),
        );
        respond(true, { messages });
      } catch {
        respond(false, undefined, {
          code: 'invalid_request',
          message: 'teamDiscussionHistoryUnavailable',
        });
      }
    },
    { scope: 'operator.read' },
  );
}
