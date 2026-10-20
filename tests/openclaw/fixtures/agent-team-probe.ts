import { discussionChannel } from '../../../plugins/extensions/agent-team/discussion/discussion-channel';
import agentTeamPlugin from '../../../plugins/extensions/agent-team';
// Loaded only by the isolated Gateway probe, never by the application manifest.
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { withAppNative } from '../../../packages/app-plugin-sdk/native';

import { executeGroupDiscussion } from '../../../plugins/extensions/agent-team/discussion/discussion-execution';
import {
  teamDiscussionSessionKey,
  TeamDiscussionState,
} from '../../../plugins/extensions/agent-team/contracts/teamDiscussion';

const plugin = {
  kind: 'bundled-channel-entry' as const,
  description: 'Optional task collaboration and local group discussions',
  configSchema: { type: 'object' as const, additionalProperties: false, properties: {} },
  loadChannelPlugin: () => discussionChannel,
  id: 'agent-team',
  name: 'Agent Team integration fixture',
  register(api: OpenClawPluginApi) {
    agentTeamPlugin.register(api);
    let metrics = {
      started: new Set<string>(),
      settled: new Set<string>(),
      active: new Set<string>(),
      peak: 0,
    };
    api.runtime.events.onAgentEvent(event => {
      if (event.stream !== 'lifecycle') return;
      if (event.data.phase === 'start') {
        metrics.started.add(event.runId);
        metrics.active.add(event.runId);
        metrics.peak = Math.max(metrics.peak, metrics.active.size);
      } else if (
        event.data.executionSettled === true &&
        ['end', 'error'].includes(String(event.data.phase))
      ) {
        metrics.settled.add(event.runId);
        metrics.active.delete(event.runId);
      }
    });
    api.registerGatewayMethod(
      'teamProbe.metrics',
      ({ params, respond }) => {
        if (params.reset)
          metrics = { started: new Set(), settled: new Set(), active: new Set(), peak: 0 };
        respond(true, {
          started: metrics.started.size,
          settled: metrics.settled.size,
          active: metrics.active.size,
          peak: metrics.peak,
        });
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'teamProbe.sessionPolicy',
      ({ params, respond }) => {
        const entry = getSessionEntry({
          sessionKey: String(params.key),
          readConsistency: 'latest',
        }) as
          | {
              sessionId?: string;
              delivery?: unknown;
              pluginExtensions?: { 'plan-mode'?: { state?: { enabled?: boolean } } };
              toolOverrides?: unknown;
            }
          | undefined;
        respond(true, {
          sessionId: entry?.sessionId,
          delivery: entry?.delivery,
          planEnabled: entry?.pluginExtensions?.['plan-mode']?.state?.enabled === true,
          toolOverrides: entry?.toolOverrides,
        });
      },
      { scope: 'operator.admin' },
    );
    let pending:
      { controller: AbortController; promise: Promise<void>; stopped: boolean } | undefined;
    api.registerGatewayMethod(
      'teamProbe.stop',
      async ({ respond }) => {
        pending?.controller.abort();
        await pending?.promise;
        respond(true, { stopped: pending?.stopped === true });
      },
      { scope: 'operator.admin' },
    );
    api.registerGatewayMethod(
      'teamProbe.run',
      async ({ params, respond }) => {
        try {
          const roomId = 'fixture';
          const agentIds = ['alice', 'bob'];
          const members = agentIds.map(agentId => {
            const entry = getSessionEntry({
              agentId,
              sessionKey: teamDiscussionSessionKey(roomId, agentId),
            });
            if (
              !entry?.sessionId ||
              !entry.lifecycleRevision ||
              !entry.sessionRoot ||
              !entry.permissionMode
            ) {
              throw new Error(`Missing prepared member: ${agentId}`);
            }
            return {
              agentId,
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              sessionRoot: entry.sessionRoot,
              permissionMode: entry.permissionMode,
            };
          });
          const executions: unknown[] = [];
          const references: unknown[] = [];
          const outcomes: Array<{ agentId: string; outcome: string }> = [];
          const controller = new AbortController();
          const hold = params.hold === true;
          const promise = executeGroupDiscussion({
            cfg: structuredClone(api.runtime.config.current()),
            room: {
              id: roomId,
              title: 'Fixture',
              members: agentIds.map(agentId => ({ agentId, name: agentId })),
              rounds: 1,
              revision: 1,
              generation: 0,
              state: TeamDiscussionState.READY,
              createdAt: 1,
              updatedAt: 1,
              cwd: members[0].sessionRoot,
              permissionMode: 'ask',
            },
            send: {
              roomId,
              requestId: hold ? 'held-request' : 'fixture-request',
              expectedRevision: 1,
              message: hold
                ? 'HOLD_FIXTURE'
                : typeof params.message === 'string'
                  ? params.message
                  : 'Give a short fixture answer.',
              selectedAgentIds: [],
              rounds: hold ? 2 : 1,
            },
            discussionId: hold ? 'held-discussion' : 'fixture-discussion',
            members,
            channelRuntime: api.runtime.channel,
            onAgentEvent: api.runtime.events.onAgentEvent,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
            onExecution: execution => executions.push(execution),
            onOutcome: (agentId, outcome) => outcomes.push({ agentId, outcome: String(outcome) }),
            onReference: reference => references.push(reference),
          });
          if (hold) {
            pending = {
              controller,
              stopped: false,
              promise: promise.catch(error => {
                if (!controller.signal.aborted) throw error;
                pending!.stopped = true;
              }),
            };
            respond(true, { accepted: true });
            // Acknowledging is independent of retaining native work ownership.
            // Returning now closes the Gateway request's admission scope.
            await pending.promise;
            return;
          }
          await promise;
          respond(true, { executions, references, outcomes });
        } catch (error) {
          api.logger.error(
            `[teamProbe] ${error instanceof Error ? (error.stack ?? error.message) : 'Fixture failed'}`,
          );
          respond(false, undefined, {
            code: 'invalid_request',
            message: error instanceof Error ? error.message : 'Fixture failed',
          });
        }
      },
      { scope: 'operator.admin' },
    );
  },
};
export default withAppNative(plugin, dispatchGatewayMethod);
