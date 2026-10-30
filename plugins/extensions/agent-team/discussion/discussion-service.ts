import { createHash } from 'node:crypto';
import path from 'node:path';

import { createCustodyClient } from '@runtime-services/sdk/custody-client';
import { toOpenClawSessionPermissionMode } from '@runtime-services/sdk/permissions';
import { getGroupThreadDeliverySession } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { getSessionEntry, patchSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import { parseDiscussionResources } from '../contracts/agentTeamSettings';
import {
  assertTeamDiscussionRecipients,
  discussionMemberSessionKey,
  isTeamDiscussionId,
  parseTeamDiscussionAgentIds,
  parseTeamDiscussionInitiator,
  parseTeamDiscussionSend,
  TEAM_DISCUSSION_CHANNEL,
  type TeamDiscussionExecution,
  TeamDiscussionGateway,
  type TeamDiscussionRoom,
  teamDiscussionSessionKey,
} from '../contracts/teamDiscussion';
import { DiscussionLedger } from '../runtime/discussion/ledger';
import { discussionReceiptWriter } from '../runtime/discussion/receipt-runtime';
import { bindDiscussionTransport, discussionChannel } from './discussion-channel';
import { executeGroupDiscussion, type PreparedDiscussionMember } from './discussion-execution';
import {
  captureDiscussionSourcePolicy,
  discussionExecutionPolicyFingerprint,
  discussionSessionPolicy,
  discussionSessionPolicyFingerprint,
  inheritDiscussionConfig,
} from './discussion-source-policy';
import { registerDiscussionSummary } from './discussion-summary';

interface ActiveDiscussion {
  roomId: string;
  discussionId: string;
  fingerprint: string;
  state: 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled';
  controller: AbortController;
  promise: Promise<void>;
  executions: TeamDiscussionExecution[];
  settledRunIds: string[];
  cleanupComplete: boolean;
  publicReferences: { agentId: string; sessionId: string; entryId: string }[];
}

/** Native group work is owned by the existing optional Agent Team extension. */
export function registerDiscussionService(api: OpenClawPluginApi): void {
  registerDiscussionSummary(api);
  const custody = createCustodyClient(api);
  let ledger: DiscussionLedger | undefined;
  const preparing = new Map<string, Promise<void>>();
  const runs = new Map<string, ActiveDiscussion>();
  const outbound = new Map<string, (payload: ReplyPayload) => Promise<{ messageId: string }>>();
  let stopped = true;
  let serviceRevision = 0;
  type GatewayRequest = Parameters<Parameters<OpenClawPluginApi['registerGatewayMethod']>[1]>[0];
  const bindCustody = async (request: GatewayRequest) => {
    const revision = serviceRevision;
    const assertServiceCurrent = () => {
      if (stopped || revision !== serviceRevision || api.lifecycle.signal?.aborted !== false)
        throw new Error('teamDiscussionDisabled');
    };
    const assertRequestCurrent = () => {
      assertServiceCurrent();
      if (
        request.signal?.aborted ||
        request.client?.connect.client.mode !== 'backend' ||
        request.hasCurrentClientAuthority?.() !== true
      )
        throw new Error('teamDiscussionDisabled');
    };
    assertRequestCurrent();
    if (!(await custody.bind())) throw new Error('teamDiscussionDisabled');
    assertRequestCurrent();
    if (!custody.isCurrent()) throw new Error('teamDiscussionDisabled');
    return { assertServiceCurrent, assertRequestCurrent };
  };
  const sourcePolicy = (cfg: OpenClawConfig, room: TeamDiscussionRoom) =>
    captureDiscussionSourcePolicy(cfg, room, () => api.runtime.config.current() as OpenClawConfig);
  const assertPreparedMembers = (
    room: TeamDiscussionRoom,
    source: ReturnType<typeof sourcePolicy>,
  ) => {
    for (const member of room.members) {
      const entry = getSessionEntry({
        agentId: member.agentId,
        sessionKey: discussionMemberSessionKey(room, member.agentId),
        readConsistency: 'latest',
      });
      if (
        !entry ||
        entry.sessionId !== member.sessionId ||
        entry.lifecycleRevision !== member.lifecycleRevision ||
        entry.sessionRoot !== room.cwd ||
        entry.archivedAt !== undefined ||
        (member.ownership !== 'source' &&
          (entry.permissionMode !==
            (source?.entry.permissionMode ??
              toOpenClawSessionPermissionMode(room.permissionMode)) ||
            (source &&
              discussionSessionPolicyFingerprint(entry) !==
                discussionSessionPolicyFingerprint(source.entry))))
      )
        throw new Error('teamDiscussionSessionChanged');
    }
  };
  const deliver = async (to: string, payload: ReplyPayload) => {
    const roomId = to.replace(/^(?:agent-team:)?(?:group:)?/, '');
    const identity = getGroupThreadDeliverySession();
    const send = outbound.get(roomId);
    if (
      stopped ||
      !identity ||
      !send ||
      identity.sessionKey !== teamDiscussionSessionKey(roomId, identity.agentId)
    )
      throw new Error('teamDiscussionInvalidMembers');
    return { channel: TEAM_DISCUSSION_CHANNEL, ...(await send(payload)) } as const;
  };
  api.registerChannel({ plugin: discussionChannel });
  let unbindTransport: (() => void) | undefined;
  const persist = (run: ActiveDiscussion) => {
    if (!ledger) throw new Error('teamDiscussionUnavailable');
    ledger.write({
      roomId: run.roomId,
      discussionId: run.discussionId,
      fingerprint: run.fingerprint,
      owner: ledger.owner,
      state: run.state,
      executions: run.executions,
      settledRunIds: run.settledRunIds,
      cleanupComplete: run.cleanupComplete,
      publicReferences: run.publicReferences,
    });
  };
  const snapshot = (
    run: Pick<ActiveDiscussion, 'roomId' | 'discussionId' | 'state' | 'executions'>,
  ) => ({
    roomId: run.roomId,
    discussionId: run.discussionId,
    state: run.state,
    executions: run.executions,
  });
  api.registerService({
    id: 'agent-team-discussions',
    async start(context) {
      serviceRevision++;
      if (api.lifecycle.signal?.aborted !== false) throw new Error('teamDiscussionDisabled');
      ledger = new DiscussionLedger(
        path.join(context.stateDir, 'agent-team', 'discussion-receipts'),
        false,
        discussionReceiptWriter(api, 'discussion'),
      );
      stopped = false;
      unbindTransport = bindDiscussionTransport(deliver);
    },
    async stop() {
      stopped = true;
      serviceRevision++;
      unbindTransport?.();
      for (const run of runs.values())
        if (run.state === 'running' || run.state === 'unknown') run.controller.abort();
      await Promise.allSettled([...runs.values()].map(run => run.promise));
      await Promise.allSettled(preparing.values());
    },
  });
  api.registerGatewayMethod(
    TeamDiscussionGateway.Health,
    ({ respond }) => {
      respond(true, { available: !stopped, version: 1 });
    },
    { scope: 'operator.read' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.Prepare,
    async request => {
      const { params, respond } = request;
      let release: (() => void) | undefined;
      const roomId = params.roomId;
      if (!isTeamDiscussionId(roomId) || ledger?.isRoomClosed(roomId)) {
        respond(false, undefined, { code: 'invalid_request', message: 'teamDiscussionNotFound' });
        return;
      }
      if (preparing.has(roomId)) {
        respond(false, undefined, { code: 'invalid_request', message: 'teamDiscussionBusy' });
        return;
      }
      preparing.set(
        roomId,
        new Promise<void>(resolve => {
          release = resolve;
        }),
      );
      try {
        const { assertRequestCurrent: assertActive } = await bindCustody(request);
        assertActive();
        if (
          stopped ||
          api.runtime.config.current().plugins?.entries?.['agent-team']?.enabled !== true
        )
          throw new Error('teamDiscussionDisabled');
        if (
          !isTeamDiscussionId(params.roomId) ||
          typeof params.cwd !== 'string' ||
          !['ask', 'auto', 'full'].includes(String(params.permissionMode))
        )
          throw new Error('teamDiscussionInvalidInput');
        const ids = parseTeamDiscussionAgentIds(params.agentIds, 1);
        const cfg = structuredClone(api.runtime.config.current()) as OpenClawConfig;
        const room = {
          cwd: params.cwd,
          sourceSessionId: params.sourceSessionId,
          summarySource: params.summarySource,
        } as TeamDiscussionRoom;
        const source = sourcePolicy(cfg, room);
        const expected = params.members as PreparedDiscussionMember[] | undefined;
        if (
          expected !== undefined &&
          (!Array.isArray(expected) ||
            expected.length !== ids.length ||
            new Set(expected.map(member => member.agentId)).size !== ids.length ||
            expected.some(
              member =>
                !ids.includes(member.agentId) || !member.sessionId || !member.lifecycleRevision,
            ))
        )
          throw new Error('teamDiscussionInvalidMembers');
        if (
          [...runs.values()].some(
            run =>
              run.roomId === params.roomId && (run.state === 'running' || run.state === 'unknown'),
          )
        )
          throw new Error('teamDiscussionBusy');
        const members: PreparedDiscussionMember[] = [];
        for (const agentId of ids) {
          if (
            stopped ||
            ledger?.isRoomClosed(roomId) ||
            !api.runtime.config.current().agents?.entries?.[agentId]
          )
            throw new Error('teamDiscussionInvalidMembers');
          const key = teamDiscussionSessionKey(params.roomId, agentId);
          source?.assertCurrent();
          const permissionMode =
            source?.entry.permissionMode ??
            toOpenClawSessionPermissionMode(params.permissionMode as 'ask' | 'auto' | 'full');
          const identity = expected?.find(member => member.agentId === agentId);
          if (!expected)
            await api.runtime.gateway.request(
              'sessions.create',
              {
                key,
                cwd: params.cwd,
                permissionMode,
              },
              { scopes: ['operator.admin'] },
            );
          source?.assertCurrent();
          let entry = getSessionEntry({ agentId, sessionKey: key, readConsistency: 'latest' });
          if (
            !entry?.sessionId ||
            !entry.lifecycleRevision ||
            entry.sessionRoot !== params.cwd ||
            entry.archivedAt !== undefined ||
            (identity &&
              (entry.sessionId !== identity.sessionId ||
                entry.lifecycleRevision !== identity.lifecycleRevision))
          )
            throw new Error('teamDiscussionSessionChanged');
          const original = structuredClone(entry);
          const policy = source ? discussionSessionPolicy(source.entry) : { permissionMode };
          if (source && entry.sandbox === 'required')
            throw new Error('teamDiscussionSourcePolicyUnsupported');
          const assertCurrent = () => {
            assertActive();
            source?.assertCurrent();
            const current = getSessionEntry({
              agentId,
              sessionKey: key,
              readConsistency: 'latest',
            });
            if (
              stopped ||
              ledger?.isRoomClosed(roomId) ||
              api.runtime.config.current().plugins?.entries?.['agent-team']?.enabled !== true ||
              !current ||
              current.sessionId !== original.sessionId ||
              current.lifecycleRevision !== original.lifecycleRevision ||
              current.sessionRoot !== params.cwd ||
              current.archivedAt !== undefined
            )
              throw new Error('teamDiscussionSessionChanged');
          };
          if (
            Object.entries(policy).some(
              ([name, value]) =>
                JSON.stringify(entry![name as keyof typeof entry]) !== JSON.stringify(value),
            )
          ) {
            await patchSessionEntry({
              agentId,
              sessionKey: key,
              preserveActivity: true,
              requireWriteSuccess: true,
              assertCommitAllowed: assertCurrent,
              update: current => {
                assertCurrent();
                if (
                  current.sessionId !== original.sessionId ||
                  current.lifecycleRevision !== original.lifecycleRevision ||
                  discussionSessionPolicyFingerprint(current) !==
                    discussionSessionPolicyFingerprint(original)
                )
                  throw new Error('teamDiscussionSessionChanged');
                return structuredClone(policy);
              },
            });
          }
          assertCurrent();
          entry = getSessionEntry({ agentId, sessionKey: key, readConsistency: 'latest' });
          if (
            !entry?.sessionId ||
            !entry.lifecycleRevision ||
            entry.permissionMode !== permissionMode ||
            entry.sessionRoot !== params.cwd ||
            Object.entries(policy).some(
              ([name, value]) =>
                JSON.stringify(entry![name as keyof typeof entry]) !== JSON.stringify(value),
            )
          )
            throw new Error('teamDiscussionSessionChanged');
          members.push({
            agentId,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            sessionRoot: entry.sessionRoot,
            permissionMode,
          });
        }
        respond(true, { members });
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionInvalidInput',
        });
      } finally {
        release?.();
        preparing.delete(roomId);
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.Close,
    async request => {
      const { params, respond } = request;
      try {
        const { assertRequestCurrent: assertActive } = await bindCustody(request);
        assertActive();
        if (!ledger || !isTeamDiscussionId(params.roomId))
          throw new Error('teamDiscussionInvalidInput');
        const ids = parseTeamDiscussionAgentIds(params.agentIds, 1);
        ledger.closeRoom(params.roomId);
        const active = [...runs.values()].filter(run => run.roomId === params.roomId);
        for (const run of active) run.controller.abort();
        await Promise.allSettled(active.map(run => run.promise));
        await preparing.get(params.roomId);
        assertActive();
        const members = ids.map(agentId => {
          const entry = getSessionEntry({
            agentId,
            sessionKey: teamDiscussionSessionKey(params.roomId as string, agentId),
          });
          return {
            agentId,
            sessionId: entry?.sessionId,
            lifecycleRevision: entry?.lifecycleRevision,
          };
        });
        respond(true, { members });
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
    TeamDiscussionGateway.Validate,
    ({ params, respond }) => {
      try {
        const cfg = structuredClone(api.runtime.config.current()) as OpenClawConfig;
        if (stopped || cfg.plugins?.entries?.['agent-team']?.enabled !== true)
          throw new Error('teamDiscussionDisabled');
        const send = parseTeamDiscussionSend(params.send);
        const room = params.room as TeamDiscussionRoom;
        if (!room || !Array.isArray(room.members)) throw new Error('teamDiscussionInvalidMembers');
        if (ledger?.isRoomClosed(room.id)) throw new Error('teamDiscussionNotFound');
        assertTeamDiscussionRecipients(room, send);
        const ids = parseTeamDiscussionAgentIds(
          room.members.map(member => member.agentId),
          2,
        );
        if (ids.some(id => !cfg.agents?.entries?.[id]))
          throw new Error('teamDiscussionInvalidMembers');
        const source = sourcePolicy(cfg, room);
        if (api.runtime.channel.commands.isControlCommandMessage(send.message, cfg))
          throw new Error('teamDiscussionCommandsUnavailable');
        assertPreparedMembers(room, source);
        respond(true, { valid: true });
      } catch (error) {
        respond(true, {
          valid: false,
          error: error instanceof Error ? error.message : 'teamDiscussionInvalidInput',
        });
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.Start,
    async request => {
      const { params, respond } = request;
      try {
        const { assertServiceCurrent, assertRequestCurrent } = await bindCustody(request);
        assertRequestCurrent();
        const cfg = structuredClone(api.runtime.config.current()) as OpenClawConfig;
        if (stopped || cfg.plugins?.entries?.['agent-team']?.enabled !== true)
          throw new Error('teamDiscussionDisabled');
        if (!isTeamDiscussionId(params.discussionId)) throw new Error('teamDiscussionInvalidInput');
        const send = parseTeamDiscussionSend(params.send);
        const initiator = parseTeamDiscussionInitiator(params.initiator);
        if (initiator.kind === 'organizer' && !cfg.agents?.entries?.[initiator.agentId])
          throw new Error('teamDiscussionInvalidMembers');
        const room = params.room as TeamDiscussionRoom;
        if (!room || room.id !== send.roomId || !Array.isArray(room.members))
          throw new Error('teamDiscussionInvalidMembers');
        const ids = parseTeamDiscussionAgentIds(
          room.members.map(member => member.agentId),
          2,
        );
        if (ids.some(id => !cfg.agents?.entries?.[id]))
          throw new Error('teamDiscussionInvalidMembers');
        if (ledger?.isRoomClosed(room.id)) throw new Error('teamDiscussionNotFound');
        const previous = runs.get(params.discussionId) ?? ledger?.read(params.discussionId);
        const fingerprint = createHash('sha256')
          .update(
            JSON.stringify([
              send.roomId,
              send.requestId,
              send.expectedRevision,
              send.message,
              [...send.selectedAgentIds].sort(),
              send.rounds,
              send.attachmentPaths ?? [],
              initiator,
              params.members,
              ...(params.resources === undefined
                ? []
                : [parseDiscussionResources(params.resources)]),
            ]),
          )
          .digest('hex');
        if (previous) {
          if (
            previous.roomId !== room.id ||
            (previous.fingerprint !== fingerprint &&
              previous.fingerprint !== 'cancelled-before-admission')
          )
            throw new Error('teamDiscussionRequestConflict');
          respond(true, snapshot(previous));
          return;
        }
        const source = sourcePolicy(cfg, room);
        if (source) assertPreparedMembers(room, source);
        if (
          [...runs.values()].some(
            run => run.roomId === room.id && (run.state === 'running' || run.state === 'unknown'),
          )
        )
          throw new Error('teamDiscussionBusy');
        if (!Array.isArray(params.members)) throw new Error('teamDiscussionInvalidMembers');
        if (runs.size >= 256) {
          for (const [id, entry] of runs) {
            if (entry.state !== 'running' && entry.state !== 'unknown') runs.delete(id);
            if (runs.size < 256) break;
          }
          if (runs.size >= 256) throw new Error('teamDiscussionBusy');
        }
        const run: ActiveDiscussion = {
          roomId: room.id,
          discussionId: params.discussionId,
          fingerprint,
          state: 'running',
          controller: new AbortController(),
          executions: [],
          settledRunIds: [],
          cleanupComplete: false,
          publicReferences: [],
          promise: Promise.resolve(),
        };
        let dispatchFailed = false;
        const finish = () => {
          if (!run.cleanupComplete) return;
          run.state = run.executions.some(execution => !run.settledRunIds.includes(execution.runId))
            ? 'unknown'
            : run.controller.signal.aborted
              ? 'cancelled'
              : dispatchFailed ||
                  run.executions.some(execution => execution.outcome !== 'completed')
                ? 'failed'
                : 'completed';
          persist(run);
        };
        persist(run);
        runs.set(run.discussionId, run);
        run.promise = executeGroupDiscussion({
          cfg: inheritDiscussionConfig(cfg, room),
          room,
          send,
          resources:
            params.resources === undefined ? undefined : parseDiscussionResources(params.resources),
          initiator,
          discussionId: run.discussionId,
          members: params.members as PreparedDiscussionMember[],
          channelRuntime: api.runtime.channel,
          onAgentEvent: api.runtime.events.onAgentEvent,
          signal: run.controller.signal,
          assertSourceCurrent: () => {
            assertServiceCurrent();
            source?.assertExecutionCurrent();
          },
          sourceSessionPolicy: source
            ? discussionExecutionPolicyFingerprint(source.entry)
            : undefined,
          onExecution: execution => {
            run.executions.push(execution);
            persist(run);
          },
          onOutcome: (agentId, outcome) => {
            const execution = [...run.executions].reverse().find(item => item.agentId === agentId);
            if (execution) {
              execution.outcome = outcome;
              if (!run.settledRunIds.includes(execution.runId))
                run.settledRunIds.push(execution.runId);
              persist(run);
              finish();
            }
          },
          onReference: ({ agentId, sessionId, entryId }) => {
            run.publicReferences.push({ agentId, sessionId, entryId });
            persist(run);
          },
          registerOutbound: send => {
            outbound.set(room.id, send);
            return () => {
              if (outbound.get(room.id) === send) outbound.delete(room.id);
            };
          },
        })
          .catch(() => {
            dispatchFailed = true;
          })
          .then(() => {
            run.cleanupComplete = true;
            finish();
          });
        respond(true, snapshot(run));
        // Keep the Gateway admission scope alive after the accepted response.
        // Detached work would inherit a closed scope and be rejected as draining.
        await run.promise;
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionInvalidInput',
        });
      }
    },
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.Status,
    ({ params, respond }) => {
      const run = isTeamDiscussionId(params.discussionId)
        ? (runs.get(params.discussionId) ?? ledger?.snapshot(params.discussionId))
        : undefined;
      respond(true, run && run.roomId === params.roomId ? snapshot(run) : { state: 'unknown' });
    },
    { scope: 'operator.read' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.Stop,
    async request => {
      const { params, respond } = request;
      try {
        const { assertRequestCurrent: assertActive } = await bindCustody(request);
        assertActive();
        const run =
          typeof params.discussionId === 'string' ? runs.get(params.discussionId) : undefined;
        if (!run || run.roomId !== params.roomId) {
          if (
            !ledger ||
            !isTeamDiscussionId(params.discussionId) ||
            !isTeamDiscussionId(params.roomId)
          ) {
            respond(false, undefined, {
              code: 'invalid_request',
              message: 'teamDiscussionInvalidInput',
            });
            return;
          }
          const previous = ledger.read(params.discussionId);
          if (previous && previous.roomId !== params.roomId) {
            respond(false, undefined, {
              code: 'invalid_request',
              message: 'teamDiscussionInvalidInput',
            });
            return;
          }
          const receipt = previous ?? {
            roomId: params.roomId,
            discussionId: params.discussionId,
            fingerprint: 'cancelled-before-admission',
            owner: ledger.owner,
            state: 'cancelled' as const,
            executions: [],
          };
          ledger.write(receipt);
          respond(true, snapshot(receipt));
          return;
        }
        run.controller.abort();
        await run.promise;
        assertActive();
        respond(true, snapshot(run));
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionUnavailable',
        });
      }
    },
    { scope: 'operator.admin' },
  );
}
