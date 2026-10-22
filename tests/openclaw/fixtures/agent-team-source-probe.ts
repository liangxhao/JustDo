import {
  dispatchChannelInboundTurn,
  getGroupThreadDeliverySession,
  resolveGroupThreadConfig,
  runGroupThread,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchReplyWithBufferedBlockDispatcher } from 'openclaw/plugin-sdk/reply-runtime';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import { discussionChannel } from '../../../plugins/extensions/agent-team/discussion/discussion-channel';

const channel = 'justdo-team';
const sourceKey = 'agent:alice:justdo:source-probe';
const peerId = 'source-probe';
export default {
  kind: 'bundled-channel-entry' as const,
  id: 'agent-team',
  name: 'Source participation fixture',
  configSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  loadChannelPlugin: () => discussionChannel,
  register(api: OpenClawPluginApi) {
    let pending:
      | {
          controller: AbortController;
          promise: Promise<void>;
          state: string;
          error?: string;
          runs: unknown[];
          deliveries: unknown[];
          sourceKey?: string;
        }
      | undefined;
    const snapshot = (key = sourceKey) => {
      const entry = getSessionEntry({ sessionKey: key, readConsistency: 'latest' });
      if (!entry) throw new Error('missing source');
      return {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        permissionMode: entry.permissionMode,
        delivery: entry.delivery,
        sessionRoot: entry.sessionRoot,
      };
    };
    api.registerGatewayMethod(
      'sourceProbe.status',
      ({ params, respond }) => {
        respond(true, {
          source: snapshot(typeof params.key === 'string' ? params.key : pending?.sourceKey),
          state: pending?.state,
          error: pending?.error,
          runs: pending?.runs,
          deliveries: pending?.deliveries,
        });
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'sourceProbe.stop',
      async ({ respond }) => {
        pending?.controller.abort();
        await pending?.promise;
        respond(true, { state: pending?.state });
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'sourceProbe.start',
      async ({ params, respond }) => {
        if (pending?.state === 'running') {
          respond(false, undefined, { code: 'invalid_request', message: 'busy' });
          return;
        }
        const controller = new AbortController();
        const internal = params.variant === 'internal';
        const summary = params.variant === 'summary';
        const currentSourceKey = summary
          ? 'agent:alice:justdo:summary-probe'
          : internal
            ? 'agent:alice:justdo:source-internal-probe'
            : sourceKey;
        const current = {
          sourceKey: currentSourceKey,
          controller,
          promise: Promise.resolve(),
          state: 'running',
          error: undefined as string | undefined,
          runs: [] as unknown[],
          deliveries: [] as unknown[],
        };
        pending = current;
        const cfg = {
          ...api.config,
          broadcast: {
            strategy: 'sequential' as const,
            [`${channel}:${peerId}`]: { agents: ['alice', 'bob'], maxRounds: 1, maxTurns: 2 },
          },
        };
        const group = resolveGroupThreadConfig({ cfg, channel, peerId });
        if (!group) throw new Error('group unavailable');
        const runInternal = async () => {
          const entry = getSessionEntry({
            sessionKey: currentSourceKey,
            readConsistency: 'latest',
          });
          if (!entry) throw new Error('missing internal source');
          const body = summary ? 'SOURCE_SUMMARY_READ' : 'SOURCE_GROUP_READ';
          return dispatchReplyWithBufferedBlockDispatcher({
            cfg,
            ctx: {
              Body: body,
              RawBody: body,
              CommandBody: body,
              AgentId: 'alice',
              SessionKey: currentSourceKey,
              RuntimePolicySessionKey: currentSourceKey,
              Provider: 'webchat',
              Surface: 'webchat',
              ChatType: 'direct',
              OriginatingChannel: 'webchat',
              From: 'source-probe',
              MessageSid: String(params.id),
              CommandAuthorized: false,
              InputProvenance: {
                kind: 'inter_session',
                sourceSessionKey: `agent:bob:${channel}:group:${peerId}`,
                sourceChannel: channel,
                sourceTool: 'team_discussion',
              },
            },
            toolsAllow: ['read'],
            replyOptions: {
              abortSignal: controller.signal,
              toolsAllow: ['read'],
              expectedExistingSessionId: entry.sessionId,
              pinExpectedExistingSession: true,
              onAgentRunStart: runId => {
                current.runs.push({
                  runId,
                  identity: getGroupThreadDeliverySession() ?? {
                    agentId: 'alice',
                    sessionKey: currentSourceKey,
                  },
                });
              },
            },
            dispatcherOptions: {
              deliver: async payload => {
                current.deliveries.push({
                  text: payload.text,
                  identity: getGroupThreadDeliverySession() ?? {
                    agentId: 'alice',
                    sessionKey: currentSourceKey,
                  },
                });
              },
            },
          });
        };
        current.promise = (async () => {
          try {
            if (summary) {
              await runInternal();
              current.state = controller.signal.aborted ? 'cancelled' : 'completed';
              return;
            }
            const result = await runGroupThread({
              cfg,
              group,
              channel,
              peerId,
              messageId: String(params.id),
              text: 'SOURCE_GROUP_READ',
              abortSignal: controller.signal,
              runTurn: async turn => {
                if (internal && turn.agentId === 'alice') return runInternal();
                const sessionKey =
                  turn.agentId === 'alice'
                    ? currentSourceKey
                    : `agent:bob:${channel}:group:${peerId}`;
                const entry = getSessionEntry({
                  agentId: turn.agentId,
                  sessionKey,
                  readConsistency: 'latest',
                });
                if (!entry) throw new Error('member unavailable');
                return dispatchChannelInboundTurn({
                  cfg,
                  channel,
                  accountId: 'default',
                  route: { agentId: turn.agentId, sessionKey },
                  ctxPayload: {
                    Body: 'SOURCE_GROUP_READ',
                    RawBody: 'SOURCE_GROUP_READ',
                    CommandBody: 'SOURCE_GROUP_READ',
                    From: peerId,
                    To: peerId,
                    SessionKey: sessionKey,
                    Provider: channel,
                    Surface: channel,
                    ChatType: 'group',
                    OriginatingChannel: channel,
                    OriginatingTo: peerId,
                    NativeChannelId: peerId,
                    AccountId: 'default',
                    MessageSid: `${params.id}-${turn.agentId}`,
                    CommandAuthorized: false,
                  },
                  replyOptions: {
                    abortSignal: controller.signal,
                    toolsAllow: ['read'],
                    onAgentRunStart: runId => {
                      current.runs.push({ runId, identity: getGroupThreadDeliverySession() });
                    },
                  },
                  dispatchReplyFromConfig: value =>
                    api.runtime.channel.reply.dispatchReplyFromConfig({
                      ...value,
                      replyOptions: {
                        ...value.replyOptions,
                        toolsAllow: ['read'],
                        expectedExistingSessionId: entry.sessionId,
                        pinExpectedExistingSession: true,
                      },
                    }),
                  delivery: {
                    deliver: async payload => {
                      current.deliveries.push({
                        text: payload.text,
                        identity: getGroupThreadDeliverySession(),
                      });
                      return {
                        visibleReplySent: true,
                        messageIds: [`delivery-${current.deliveries.length}`],
                      };
                    },
                  },
                });
              },
            });
            current.state = controller.signal.aborted
              ? 'cancelled'
              : result.failedTurns
                ? 'failed'
                : 'completed';
          } catch (error) {
            current.state = controller.signal.aborted ? 'cancelled' : 'failed';
            current.error = String(error);
          }
        })();
        respond(true, { accepted: true });
        // Hold Gateway admission ownership after acknowledgement until native work settles.
        await current.promise;
      },
      { scope: 'operator.admin' },
    );
  },
};
