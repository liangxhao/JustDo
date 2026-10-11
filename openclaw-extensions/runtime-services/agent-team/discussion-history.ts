import path from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';

import {
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  TEAM_DISCUSSION_CHANNEL,
  TeamDiscussionGateway,
  type TeamDiscussionMessage,
  teamDiscussionSessionKey,
} from '../../../src/shared/cowork/agent-team/teamDiscussion';
import { DiscussionLedger } from './discussion-ledger';

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

/** Required Runtime Services retains history reads while Agent Team is disabled. */
export function registerDiscussionHistory(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    TeamDiscussionGateway.OfflineControl,
    ({ params, respond }) => {
      try {
        if (api.runtime.config.current().plugins?.entries?.['agent-team']?.enabled === true)
          throw new Error('teamDiscussionBusy');
        if (!isTeamDiscussionId(params.roomId)) throw new Error('teamDiscussionInvalidInput');
        if (params.operation === 'summary-status' || params.operation === 'summary-stop') {
          if (!isTeamDiscussionId(params.discussionId))
            throw new Error('teamDiscussionInvalidInput');
          const summaries = new DiscussionLedger(
            path.join(api.runtime.state.resolveStateDir(), 'agent-team', 'summary-receipts'),
            true,
          );
          let receipt = summaries.read(params.discussionId);
          if (receipt && receipt.roomId !== params.roomId)
            throw new Error('teamDiscussionInvalidInput');
          if (params.operation === 'summary-stop' && !receipt) {
            receipt = {
              roomId: params.roomId,
              discussionId: params.discussionId,
              fingerprint: 'cancelled-before-admission',
              owner: summaries.owner,
              state: 'cancelled',
              executions: [],
            };
            summaries.write(receipt);
          }
          respond(true, {
            state:
              !receipt || receipt.interrupted
                ? 'unknown'
                : receipt.state === 'completed'
                  ? 'delivered'
                  : receipt.state,
            runId: receipt?.executions[0]?.runId,
          });
          return;
        }
        const ledger = new DiscussionLedger(
          path.join(api.runtime.state.resolveStateDir(), 'agent-team', 'discussion-receipts'),
        );
        if (params.operation === 'close') {
          ledger.closeRoom(params.roomId);
          respond(true, { closed: true });
          return;
        }
        if (
          !['status', 'stop'].includes(String(params.operation)) ||
          !isTeamDiscussionId(params.discussionId)
        )
          throw new Error('teamDiscussionInvalidInput');
        let receipt = ledger.read(params.discussionId);
        if (receipt && receipt.roomId !== params.roomId)
          throw new Error('teamDiscussionInvalidInput');
        if (!receipt && params.operation === 'stop') {
          receipt = {
            roomId: params.roomId,
            discussionId: params.discussionId,
            fingerprint: 'cancelled-before-admission',
            owner: ledger.owner,
            state: 'cancelled',
            executions: [],
          };
          ledger.write(receipt);
        }
        respond(
          true,
          receipt
            ? {
                roomId: receipt.roomId,
                discussionId: receipt.discussionId,
                state: receipt.state,
                executions: receipt.executions,
              }
            : { state: 'unknown' },
        );
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionUnavailable',
        });
      }
    },
    { scope: 'operator.admin' },
  );

  api.registerGatewayMethod(
    TeamDiscussionGateway.History,
    async ({ params, respond }) => {
      try {
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
