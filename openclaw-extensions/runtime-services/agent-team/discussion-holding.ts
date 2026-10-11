import { createHash } from 'node:crypto';
import path from 'node:path';

import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptRawDelta,
} from 'openclaw/plugin-sdk/session-transcript-runtime';

import {
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  parseTeamDiscussionSend,
  serializeTeamDiscussionSend,
  TeamDiscussionGateway,
  type TeamDiscussionHoldingIdentity,
  type TeamDiscussionSend,
} from '../../../src/shared/cowork/agent-team/teamDiscussion';
import {
  DiscussionHoldingLedger,
  type HoldingReceipt,
  type HoldingSlot,
} from './discussion-holding-ledger';

// Preserve the established native session identity and its import/cleanup filters.
export const DISCUSSION_HOLDING_HARNESS = 'justdo-team-holding';
export const DISCUSSION_HOLDING_CUSTOM_TYPE = 'agent-team-holding-input';
const HOLDING_OWNER = 'runtime-services';
const fingerprint = (send: TeamDiscussionSend) =>
  createHash('sha256').update(serializeTeamDiscussionSend(send)).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('teamDiscussionInvalidInput');
  return value as Record<string, unknown>;
};
const generation = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('teamDiscussionInvalidInput');
  return value as number;
};
export const discussionHoldingSessionKey = (roomId: string, epoch: number, agentId: string) =>
  `agent:${agentId}:harness:${DISCUSSION_HOLDING_HARNESS}:${roomId}:${epoch}`;
const requestKey = (roomId: string, epoch: number, requestId: string) =>
  `agent-team-holding:${roomId}:${epoch}:${requestId}`;
const parseIdentity = (value: unknown): TeamDiscussionHoldingIdentity => {
  const input = record(value);
  if (
    !isTeamDiscussionId(input.roomId) ||
    !isTeamDiscussionAgentId(input.agentId) ||
    typeof input.sessionId !== 'string' ||
    !input.sessionId ||
    input.sessionId.length > 256 ||
    typeof input.lifecycleRevision !== 'string' ||
    !input.lifecycleRevision ||
    input.lifecycleRevision.length > 256
  )
    throw new Error('teamDiscussionInvalidInput');
  const epoch = generation(input.generation);
  const key = discussionHoldingSessionKey(input.roomId, epoch, input.agentId);
  if (input.sessionKey !== key) throw new Error('teamDiscussionInvalidInput');
  return {
    roomId: input.roomId,
    generation: epoch,
    agentId: input.agentId,
    sessionKey: key,
    sessionId: input.sessionId,
    lifecycleRevision: input.lifecycleRevision,
  };
};
type Handler = Parameters<OpenClawPluginApi['registerGatewayMethod']>[1];

/** Required Runtime Services owns native custody; optional Team enablement controls body access. */
export function registerDiscussionHolding(api: OpenClawPluginApi): void {
  let ledger: DiscussionHoldingLedger | undefined;
  let stopped = true;
  let serviceEpoch = 0;
  const preparing = new Map<string, Promise<TeamDiscussionHoldingIdentity>>();
  const assertRunning = () => {
    if (!ledger || stopped) throw new Error('teamDiscussionDisabled');
    return ledger;
  };
  const assertActive = () => {
    const store = assertRunning();
    const plugins = api.runtime.config.current().plugins;
    if (
      plugins?.enabled === false ||
      plugins?.entries?.['agent-team']?.enabled !== true ||
      plugins.deny?.includes('agent-team') ||
      (plugins.allow?.length && !plugins.allow.includes('agent-team'))
    )
      throw new Error('teamDiscussionDisabled');
    return store;
  };
  const current = (identity: TeamDiscussionHoldingIdentity) =>
    api.runtime.agent.session.getSessionEntry({
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      readConsistency: 'latest',
    });
  const ownsEntry = (slot: HoldingSlot, entry: ReturnType<typeof current>) => {
    if (!entry) return false;
    const extension = entry.pluginExtensions?.[HOLDING_OWNER];
    if (!extension || typeof extension !== 'object' || Array.isArray(extension)) return false;
    const marker = (extension as Record<string, unknown>).holding;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
    const metadata = marker as Record<string, unknown>;
    return (
      entry.agentHarnessId === DISCUSSION_HOLDING_HARNESS &&
      entry.sessionRoot === slot.cwd &&
      metadata.roomId === slot.roomId &&
      metadata.generation === slot.generation
    );
  };
  const ownsCleanupEntry = (
    store: DiscussionHoldingLedger,
    slot: HoldingSlot,
    entry: ReturnType<typeof current>,
  ) => {
    if (ownsEntry(slot, entry)) return true;
    const identity = slot.identity;
    const extension = entry?.pluginExtensions?.[HOLDING_OWNER];
    if (
      !entry ||
      !identity ||
      store.room(slot.roomId)?.closed !== true ||
      slot.sessionKey !== discussionHoldingSessionKey(slot.roomId, slot.generation, slot.agentId) ||
      identity.roomId !== slot.roomId ||
      identity.generation !== slot.generation ||
      identity.agentId !== slot.agentId ||
      identity.sessionKey !== slot.sessionKey ||
      entry.sessionId !== identity.sessionId ||
      entry.lifecycleRevision !== identity.lifecycleRevision ||
      entry.agentHarnessId !== DISCUSSION_HOLDING_HARNESS ||
      entry.sessionRoot !== slot.cwd ||
      entry.modelSelectionLocked !== false ||
      entry.archivedAt === undefined ||
      (extension !== undefined &&
        (!extension || typeof extension !== 'object' || Array.isArray(extension)))
    )
      return false;
    // Normal retirement removes the owner namespace once the archived holder
    // is unlocked. Only a closed, exact durable incarnation may finish deletion;
    // a conflicting marker or restored/unconfirmed holder never qualifies.
    return extension === undefined || (extension as Record<string, unknown>).holding === undefined;
  };
  const assertIdentity = (identity: TeamDiscussionHoldingIdentity) => {
    const store = assertActive();
    store.assertOpen(identity.roomId, identity.generation);
    const slot = store.slot(identity.roomId, identity.generation);
    const entry = current(identity);
    if (
      !slot ||
      !slot.identity ||
      slot.deleted ||
      !ownsEntry(slot, entry) ||
      slot.identity.sessionId !== identity.sessionId ||
      slot.identity.lifecycleRevision !== identity.lifecycleRevision ||
      entry?.sessionId !== identity.sessionId ||
      entry.lifecycleRevision !== identity.lifecycleRevision ||
      entry.modelSelectionLocked !== true ||
      entry.archivedAt !== undefined
    )
      throw new Error('teamDiscussionSessionChanged');
    return store;
  };
  const result = (identity: TeamDiscussionHoldingIdentity, receipt: HoldingReceipt) => ({
    identity,
    requestId: receipt.requestId,
    fingerprint: receipt.fingerprint,
    state: receipt.state === 'receiving' ? 'unknown' : receipt.state,
    ...(receipt.entryId ? { entryId: receipt.entryId } : {}),
  });
  const exactInput = (params: Record<string, unknown>) => {
    const identity = parseIdentity(params.identity);
    if (
      !isTeamDiscussionId(params.requestId) ||
      typeof params.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(params.fingerprint) ||
      (params.entryId !== undefined &&
        (typeof params.entryId !== 'string' || !params.entryId || params.entryId.length > 256))
    )
      throw new Error('teamDiscussionInvalidInput');
    return {
      identity,
      requestId: params.requestId,
      fingerprint: params.fingerprint,
      entryId: params.entryId as string | undefined,
    };
  };
  const readExact = async (input: ReturnType<typeof exactInput>) => {
    const store = assertIdentity(input.identity);
    const receipt = store.receipt(
      input.identity.roomId,
      input.identity.generation,
      input.requestId,
    );
    if (!receipt || receipt.state === 'cancelled')
      throw new Error('teamDiscussionHoldingCancelled');
    if (receipt.fingerprint !== input.fingerprint)
      throw new Error('teamDiscussionExecutionConflict');
    let cursor: string | undefined;
    for (;;) {
      assertIdentity(input.identity);
      const page = await readSessionTranscriptRawDelta({
        agentId: input.identity.agentId,
        sessionKey: input.identity.sessionKey,
        sessionId: input.identity.sessionId,
        ...(cursor ? { cursor } : {}),
        maxBytes: 256 * 1024,
        maxEvents: 100,
      });
      assertIdentity(input.identity);
      const latest = store.receipt(
        input.identity.roomId,
        input.identity.generation,
        input.requestId,
      );
      if (!latest || latest.state === 'cancelled')
        throw new Error('teamDiscussionHoldingCancelled');
      if (page.kind !== 'page') throw new Error('teamDiscussionHistoryUnavailable');
      for (const row of page.events) {
        const event = row.event as { type?: unknown; id?: unknown; message?: unknown };
        if (
          event.type !== 'message' ||
          typeof event.id !== 'string' ||
          !event.message ||
          typeof event.message !== 'object'
        )
          continue;
        const message = event.message as Record<string, unknown>;
        if (
          message.idempotencyKey !==
          requestKey(input.identity.roomId, input.identity.generation, input.requestId)
        )
          continue;
        if (
          message.role !== 'custom' ||
          message.customType !== DISCUSSION_HOLDING_CUSTOM_TYPE ||
          message.display !== false ||
          message.excludeFromContext !== true ||
          (input.entryId && event.id !== input.entryId) ||
          (latest.entryId && event.id !== latest.entryId)
        )
          throw new Error('teamDiscussionExecutionConflict');
        const metadata = record(record(message.__openclaw).agentTeamHolding);
        if (
          metadata.roomId !== input.identity.roomId ||
          metadata.generation !== input.identity.generation ||
          metadata.requestId !== input.requestId ||
          metadata.fingerprint !== input.fingerprint
        )
          throw new Error('teamDiscussionExecutionConflict');
        if (!Array.isArray(message.content) || message.content.length !== 1)
          throw new Error('teamDiscussionExecutionConflict');
        const block = record(message.content[0]);
        if (block.type !== 'text' || typeof block.text !== 'string')
          throw new Error('teamDiscussionExecutionConflict');
        let send: TeamDiscussionSend;
        try {
          send = parseTeamDiscussionSend(JSON.parse(block.text));
        } catch {
          throw new Error('teamDiscussionExecutionConflict');
        }
        if (
          send.roomId !== input.identity.roomId ||
          send.requestId !== input.requestId ||
          fingerprint(send) !== input.fingerprint
        )
          throw new Error('teamDiscussionExecutionConflict');
        return { identity: input.identity, send, entryId: event.id };
      }
      if (!page.hasMore) return;
      if (!page.cursor || page.cursor === cursor)
        throw new Error('teamDiscussionHistoryUnavailable');
      cursor = page.cursor;
    }
  };
  const wrap =
    (operation: (params: Record<string, unknown>) => unknown | Promise<unknown>): Handler =>
    async ({ params, respond }) => {
      try {
        respond(true, await operation(params));
      } catch (error) {
        respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionInvalidInput',
        });
      }
    };
  api.registerAgentHarness({
    id: DISCUSSION_HOLDING_HARNESS,
    label: 'Agent Team pending input storage',
    supports: () => ({ supported: false, reason: 'Pending input storage cannot execute.' }),
    async runAttempt() {
      throw new Error('teamDiscussionHoldingCannotExecute');
    },
  });
  // Also covers an explicit restore during the owner-controlled deletion window.
  api.on('before_agent_run', (_event, context) => {
    if (
      new RegExp(`^agent:[^:]+:harness:${DISCUSSION_HOLDING_HARNESS}:`).test(
        context.sessionKey ?? '',
      )
    )
      return { outcome: 'block', reason: 'Agent Team pending input storage cannot execute.' };
  });
  api.registerService({
    id: 'agent-team-holding',
    start(context) {
      ledger = new DiscussionHoldingLedger(
        path.join(context.stateDir, 'agent-team', 'holding-receipts'),
      );
      stopped = false;
      serviceEpoch++;
    },
    stop() {
      stopped = true;
      serviceEpoch++;
      // Runtime Services remains the custodian after optional Team disable.
      // Hot replacement may still stop it with old config; Main's durable fence
      // owns explicit cancellation, this check is only supplementary.
      if (api.runtime.config.current().plugins?.entries?.['agent-team']?.enabled !== true)
        ledger?.cancelAllReceipts();
      // Saved bodies survive normal Gateway restart. The new owner reconciles uncertain writes.
    },
  });
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingPrepare,
    wrap(async params => {
      const store = assertActive();
      if (
        !isTeamDiscussionId(params.roomId) ||
        !isTeamDiscussionAgentId(params.agentId) ||
        typeof params.cwd !== 'string' ||
        !path.isAbsolute(params.cwd)
      )
        throw new Error('teamDiscussionInvalidInput');
      const epoch = generation(params.generation);
      store.advance(params.roomId, epoch);
      const slot = store.slot(params.roomId, epoch) ?? {
        roomId: params.roomId,
        generation: epoch,
        agentId: params.agentId,
        sessionKey: discussionHoldingSessionKey(params.roomId, epoch, params.agentId),
        cwd: params.cwd,
      };
      if (slot.agentId !== params.agentId || slot.cwd !== params.cwd || slot.deleted)
        throw new Error('teamDiscussionSessionChanged');
      store.saveSlot(slot);
      const key = `${slot.roomId}:${epoch}`;
      const previous = preparing.get(key);
      if (previous) return await previous;
      const capturedEpoch = serviceEpoch;
      const preparation = (async () => {
        const existing = api.runtime.agent.session.getSessionEntry({
          agentId: slot.agentId,
          sessionKey: slot.sessionKey,
          readConsistency: 'latest',
        });
        if (!existing) {
          await api.runtime.agent.session.createSessionEntry({
            cfg: api.runtime.config.current() as OpenClawConfig,
            key: slot.sessionKey,
            agentId: slot.agentId,
            sessionRoot: slot.cwd,
            permissionMode: 'read-only',
            initialEntry: {
              agentHarnessId: DISCUSSION_HOLDING_HARNESS,
              modelSelectionLocked: true,
              pluginExtensions: {
                [HOLDING_OWNER]: { holding: { roomId: slot.roomId, generation: epoch } },
              },
            },
          });
        }
        const entry = api.runtime.agent.session.getSessionEntry({
          agentId: slot.agentId,
          sessionKey: slot.sessionKey,
          readConsistency: 'latest',
        });
        if (
          !ownsEntry(slot, entry) ||
          !entry?.sessionId ||
          !entry.lifecycleRevision ||
          entry.modelSelectionLocked !== true
        )
          throw new Error('teamDiscussionSessionChanged');
        const identity = {
          roomId: slot.roomId,
          generation: epoch,
          agentId: slot.agentId,
          sessionKey: slot.sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        };
        if (slot.identity && slot.identity.sessionId !== identity.sessionId)
          throw new Error('teamDiscussionSessionChanged');
        store.saveSlot({ ...slot, identity });
        if (capturedEpoch !== serviceEpoch) throw new Error('teamDiscussionDisabled');
        assertIdentity(identity);
        return identity;
      })();
      preparing.set(key, preparation);
      try {
        return await preparation;
      } finally {
        if (preparing.get(key) === preparation) preparing.delete(key);
      }
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingSave,
    wrap(async params => {
      const identity = parseIdentity(params.identity);
      const store = assertIdentity(identity);
      const send = parseTeamDiscussionSend(params.send);
      const digest = fingerprint(send);
      if (send.roomId !== identity.roomId || params.fingerprint !== digest)
        throw new Error('teamDiscussionExecutionConflict');
      const existing = store.receipt(identity.roomId, identity.generation, send.requestId);
      if (existing) {
        if (existing.fingerprint && existing.fingerprint !== digest)
          throw new Error('teamDiscussionExecutionConflict');
        return result(identity, { ...existing, fingerprint: digest });
      }
      const receipt: HoldingReceipt = {
        roomId: identity.roomId,
        generation: identity.generation,
        requestId: send.requestId,
        fingerprint: digest,
        owner: store.owner,
        state: 'receiving',
        timestamp: Date.now(),
      };
      store.saveReceipt(receipt);
      const capturedEpoch = serviceEpoch;
      try {
        const written = await appendSessionTranscriptMessageByIdentity({
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          sessionId: identity.sessionId,
          config: api.runtime.config.current() as OpenClawConfig,
          idempotencyLookup: 'scan',
          beforeFreshMessageCommit() {
            assertIdentity(identity);
            const latest = store.receipt(identity.roomId, identity.generation, send.requestId);
            if (
              capturedEpoch !== serviceEpoch ||
              latest?.state !== 'receiving' ||
              latest.owner !== store.owner ||
              latest.fingerprint !== digest
            )
              throw new Error('teamDiscussionHoldingCancelled');
          },
          message: {
            role: 'custom',
            customType: DISCUSSION_HOLDING_CUSTOM_TYPE,
            display: false,
            excludeFromContext: true,
            timestamp: receipt.timestamp,
            idempotencyKey: requestKey(identity.roomId, identity.generation, send.requestId),
            content: [{ type: 'text', text: JSON.stringify(send) }],
            __openclaw: {
              agentTeamHolding: {
                roomId: identity.roomId,
                generation: identity.generation,
                requestId: send.requestId,
                fingerprint: digest,
              },
            },
          },
        });
        const latest = store.receipt(identity.roomId, identity.generation, send.requestId);
        if (latest?.state === 'cancelled') return result(identity, latest);
        assertIdentity(identity);
        // Native scan deduplication returns the original message. An idempotency
        // key alone cannot certify that its body is this excluded custom input.
        const acknowledged = record(written?.message);
        const marker = record(record(acknowledged.__openclaw).agentTeamHolding);
        if (
          acknowledged.role !== 'custom' ||
          acknowledged.customType !== DISCUSSION_HOLDING_CUSTOM_TYPE ||
          acknowledged.display !== false ||
          acknowledged.excludeFromContext !== true ||
          acknowledged.idempotencyKey !==
            requestKey(identity.roomId, identity.generation, send.requestId) ||
          JSON.stringify(acknowledged.content) !==
            JSON.stringify([{ type: 'text', text: JSON.stringify(send) }]) ||
          marker.roomId !== identity.roomId ||
          marker.generation !== identity.generation ||
          marker.requestId !== send.requestId ||
          marker.fingerprint !== digest
        )
          throw new Error('teamDiscussionExecutionConflict');
        if (
          capturedEpoch === serviceEpoch &&
          written &&
          latest?.state === 'saved' &&
          latest.entryId === written.messageId
        )
          return result(identity, latest);
        if (
          capturedEpoch !== serviceEpoch ||
          !written ||
          latest?.state !== 'receiving' ||
          latest.owner !== store.owner
        )
          throw new Error('teamDiscussionHoldingUncertain');
        const saved: HoldingReceipt = { ...receipt, state: 'saved', entryId: written.messageId };
        store.saveReceipt(saved);
        return result(identity, saved);
      } catch {
        const latest = store.receipt(identity.roomId, identity.generation, send.requestId);
        if (latest?.state === 'cancelled') return result(identity, latest);
        const unknown: HoldingReceipt = { ...receipt, state: 'unknown' };
        if (latest?.state === 'receiving' && latest.owner === store.owner)
          store.saveReceipt(unknown);
        return result(identity, unknown);
      }
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingRead,
    wrap(async params => {
      const input = exactInput(params);
      const store = assertIdentity(input.identity);
      const receipt = store.receipt(
        input.identity.roomId,
        input.identity.generation,
        input.requestId,
      );
      if (receipt?.state !== 'saved') throw new Error('teamDiscussionHoldingUncertain');
      const saved = await readExact(input);
      if (!saved) throw new Error('teamDiscussionHistoryUnavailable');
      return saved;
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingStatus,
    wrap(async params => {
      const input = exactInput(params);
      const store = assertActive();
      const receipt = store.receipt(
        input.identity.roomId,
        input.identity.generation,
        input.requestId,
      );
      if (!receipt) throw new Error('teamDiscussionHoldingUncertain');
      if (receipt.fingerprint && receipt.fingerprint !== input.fingerprint)
        throw new Error('teamDiscussionExecutionConflict');
      if (receipt.state === 'cancelled')
        return result(input.identity, { ...receipt, fingerprint: input.fingerprint });
      const saved = await readExact(input);
      if (!saved) return result(input.identity, { ...receipt, state: 'unknown' });
      const latest = store.receipt(
        input.identity.roomId,
        input.identity.generation,
        input.requestId,
      );
      if (latest?.state === 'cancelled') return result(input.identity, latest);
      assertIdentity(input.identity);
      const verified: HoldingReceipt = {
        ...receipt,
        owner: store.owner,
        state: 'saved',
        entryId: saved.entryId,
      };
      store.saveReceipt(verified);
      return result(input.identity, verified);
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingCancel,
    wrap(params => {
      const store = assertRunning();
      if (
        !isTeamDiscussionId(params.roomId) ||
        (params.requestIds !== undefined &&
          (!Array.isArray(params.requestIds) ||
            params.requestIds.length < 1 ||
            params.requestIds.length > 3 ||
            params.requestIds.some(id => !isTeamDiscussionId(id))))
      )
        throw new Error('teamDiscussionInvalidInput');
      store.cancel(
        params.roomId,
        generation(params.generation),
        params.requestIds as string[] | undefined,
      );
      return { cancelled: true };
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingClose,
    wrap(async params => {
      const store = assertRunning();
      if (!isTeamDiscussionId(params.roomId)) throw new Error('teamDiscussionInvalidInput');
      store.close(params.roomId);
      await Promise.allSettled(
        [...preparing.entries()]
          .filter(([key]) => key.startsWith(`${params.roomId}:`))
          .map(([, promise]) => promise),
      );
      if (params.phase !== undefined && params.phase !== 'unlock')
        throw new Error('teamDiscussionInvalidInput');
      if (params.phase === 'unlock') {
        const identity = parseIdentity(params.identity);
        if (identity.roomId !== params.roomId) throw new Error('teamDiscussionInvalidInput');
        const slot = store.slot(identity.roomId, identity.generation);
        if (
          !slot ||
          slot.deleted ||
          !slot.identity ||
          slot.identity.sessionId !== identity.sessionId
        )
          throw new Error('teamDiscussionSessionChanged');
        const entry = current(identity);
        if (
          !ownsCleanupEntry(store, slot, entry) ||
          entry?.sessionId !== identity.sessionId ||
          entry.lifecycleRevision !== identity.lifecycleRevision ||
          entry.archivedAt === undefined
        )
          throw new Error('teamDiscussionSessionChanged');
        if (entry.modelSelectionLocked === true) {
          await api.runtime.agent.session.patchSessionEntry({
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            update: currentEntry => {
              if (
                !ownsCleanupEntry(store, slot, currentEntry) ||
                currentEntry.sessionId !== identity.sessionId ||
                currentEntry.lifecycleRevision !== identity.lifecycleRevision ||
                currentEntry.archivedAt === undefined
              )
                throw new Error('teamDiscussionSessionChanged');
              return { modelSelectionLocked: false };
            },
          });
        }
        const unlocked = current(identity);
        if (
          !ownsCleanupEntry(store, slot, unlocked) ||
          unlocked?.sessionId !== identity.sessionId ||
          !unlocked.lifecycleRevision ||
          unlocked.archivedAt === undefined ||
          unlocked.modelSelectionLocked === true
        )
          throw new Error('teamDiscussionSessionChanged');
        const updated = { ...identity, lifecycleRevision: unlocked.lifecycleRevision };
        store.saveSlot({ ...slot, identity: updated });
        return { identity: updated };
      }
      const identities: TeamDiscussionHoldingIdentity[] = [];
      for (const slot of store.slots(params.roomId)) {
        if (slot.deleted) continue;
        const scope = {
          agentId: slot.agentId,
          sessionKey: slot.sessionKey,
          readConsistency: 'latest' as const,
        };
        const entry = api.runtime.agent.session.getSessionEntry(scope);
        if (!entry) {
          store.saveSlot({ ...slot, deleted: true });
          continue;
        }
        if (
          !ownsCleanupEntry(store, slot, entry) ||
          !entry.sessionId ||
          !entry.lifecycleRevision ||
          (slot.identity && entry.sessionId !== slot.identity.sessionId)
        )
          throw new Error('teamDiscussionSessionChanged');
        // Gateway plugin callers cannot administratively patch/delete harness rows:
        // Main's ordinary operator client owns archive + exact archivedOnly deletion.
        const identity = {
          roomId: slot.roomId,
          generation: slot.generation,
          agentId: slot.agentId,
          sessionKey: slot.sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        };
        store.saveSlot({ ...slot, identity });
        identities.push(identity);
      }
      return { closed: true, identities };
    }),
    { scope: 'operator.admin' },
  );
}
