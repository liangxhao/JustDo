import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import { EXECUTION_ADMISSION_METHOD, EXECUTION_ADMISSION_MAINTENANCE_METHOD, type ExecutionAdmissionReceipt, type ExecutionAdmissionSnapshot, type ExecutionAdmissionSource } from '../sdk/admission';
import type { OwnerProvider, VerifiedOwner } from '../sdk/owner-contract';
import { ExecutionAdmissionStore } from './store';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/** Negative execution fences; consumers retain every business decision and native executor. */
export function registerExecutionAdmission(api: OpenClawPluginApi, owners: OwnerProvider) {
  const store = new ExecutionAdmissionStore(api.runtime.state.resolveStateDir());
  const liveOwners = new Map<string, { owner: VerifiedOwner; receipts: Map<string, { id: string; generation: number }> }>();
  const native = (key: string) => getSessionEntry({ sessionKey: key, readConsistency: 'latest' });
  const exact = (value: ExecutionAdmissionReceipt) => {
    const entry = native(value.sessionKey);
    if (entry?.sessionId !== value.sessionId || (entry.lifecycleRevision ?? null) !== value.lifecycleRevision)
      throw new Error('Execution admission native incarnation changed.');
  };
  const ownerCurrent = (value: ExecutionAdmissionReceipt) => value.owner.providerScope === owners.scope &&
    liveOwners.get(value.owner.registrationId)?.owner.isCurrent() === true;
  const read = (source: ExecutionAdmissionSource): ExecutionAdmissionSnapshot => {
    try {
      const value = store.read(source.sessionKey);
      if (!value.present) return { state: 'clear', generation: 0 };
      const receipt = value.receipt;
      if (!receipt) return { state: 'unknown' };
      if (receipt.state === 'released') return { state: 'clear', generation: receipt.generation, receipt: structuredClone(receipt) };
      if (!source.sessionId || source.sessionId !== receipt.sessionId || !ownerCurrent(receipt) || receipt.state === 'revoked')
        return { state: 'unknown', generation: receipt.generation };
      exact(receipt);
      return { state: 'held', generation: receipt.generation, receipt: structuredClone(receipt) };
    } catch { return { state: 'unknown' }; }
  };
  const remember = (owner: VerifiedOwner, receipt: ExecutionAdmissionReceipt) => {
    const previous = liveOwners.get(owner.registrationId);
    if (previous?.owner === owner) {
      previous.receipts.set(receipt.sessionKey, { id: receipt.id, generation: receipt.generation });
      return;
    }
    const enrolled = { owner, receipts: new Map([[receipt.sessionKey, { id: receipt.id, generation: receipt.generation }]]) };
    liveOwners.set(owner.registrationId, enrolled);
    owner.onRetire(() => {
      if (liveOwners.get(owner.registrationId) === enrolled) liveOwners.delete(owner.registrationId);
      for (const [sessionKey, reference] of enrolled.receipts) {
        const current = store.read(sessionKey).receipt;
        if (!current || current.state === 'released' || current.id !== reference.id || current.generation !== reference.generation ||
            current.owner.registrationId !== owner.registrationId || current.owner.providerScope !== owners.scope) continue;
        try { store.write({ ...current, state: 'revoked' }); }
        catch { store.uncertain.add(sessionKey); }
      }
      enrolled.receipts.clear();
    });
  };
  api.registerGatewayMethod(EXECUTION_ADMISSION_METHOD, ({ params, respond, hasCurrentClientAuthority, signal }) => {
    try {
      signal?.throwIfAborted();
      if (api.lifecycle.signal?.aborted || hasCurrentClientAuthority?.() === false)
        throw new Error('Execution admission request is retired.');
      const owner = typeof params.ownerToken === 'string' ? owners.resolve(params.ownerToken) : undefined;
      if (!owner) throw new Error('Execution admission requires a proven native owner.');
      owner.assertCurrent();
      if (!id(params.sessionKey)) throw new Error('Execution admission source is required.');
      const key = params.sessionKey;
      const value = store.read(key);
      if (value.present && !value.receipt) throw new Error('Execution admission state is unknown.');
      const previous = value.receipt;
      if (params.operation === 'inspect') {
        respond(true, { snapshot: read({ sessionKey: key, sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined }) });
        return;
      }
      let next: ExecutionAdmissionReceipt;
      if (params.operation === 'reserve') {
        if (!id(params.sessionId) || !id(params.runId) || !(params.lifecycleRevision === null || id(params.lifecycleRevision)) ||
            !Number.isSafeInteger(params.expectedGeneration) || Number(params.expectedGeneration) < 0 || Number(params.expectedGeneration) >= Number.MAX_SAFE_INTEGER)
          throw new Error('Exact execution admission identity is required.');
        if (previous && previous.state !== 'released') throw new Error('An execution admission is still held or unknown.');
        if ((previous?.generation ?? 0) !== params.expectedGeneration) throw new Error('Execution admission generation changed.');
        next = {
          version: 2, id: randomUUID(), sessionKey: key, sessionId: params.sessionId,
          lifecycleRevision: params.lifecycleRevision, runId: params.runId, generation: Number(params.expectedGeneration) + 1,
          owner: { pluginId: owner.pluginId, registrationId: owner.registrationId, providerScope: owners.scope },
          state: 'held', verified: false, effectIssued: false,
        };
      } else {
        if (!previous || previous.id !== params.id || previous.generation !== params.generation ||
            previous.owner.registrationId !== owner.registrationId || previous.owner.pluginId !== owner.pluginId ||
            previous.owner.providerScope !== owners.scope) throw new Error('Execution admission belongs to a different owner or generation.');
        next = { ...previous };
        if (params.operation === 'revoke') next.state = 'revoked';
        else {
          if (previous.state !== 'held' && !['cleanup', 'release', 'abandon'].includes(String(params.operation)))
            throw new Error('Execution admission is no longer active.');
          if (params.operation === 'verify') next.verified = true;
          else if (params.operation === 'issued') {
            if (!previous.verified) throw new Error('Execution admission input is unverified.');
            next.effectIssued = true;
          } else if (params.operation === 'accepted') {
            if (!previous.effectIssued || !id(params.receiptId)) throw new Error('Exact accepted effect receipt is required.');
            next.acceptedReceiptId = params.receiptId;
          } else if (params.operation === 'cleanup') {
            if (!id(params.receiptId)) throw new Error('An exact owner cleanup receipt is required.');
            // This is an attestation by the proven resource owner, not a native
            // run terminal or a substitute for caller-bound managed cleanup.
            next.cleanupReceipt = { id: params.receiptId, registrationId: owner.registrationId, source: 'owner-attestation' };
          } else if (params.operation === 'release') {
            if (!previous.sourceTerminal || !previous.cleanupReceipt || previous.cleanupReceipt.id !== params.receiptId)
              throw new Error('Execution settlement and owner cleanup receipt are unconfirmed.');
            next.state = 'released';
          } else if (params.operation === 'abandon') {
            if (previous.verified || previous.effectIssued || previous.sourceTerminal || params.neverSubmitted !== true)
              throw new Error('Only a proven never-issued admission can be abandoned.');
            next.state = 'released';
          } else throw new Error('Unknown execution admission operation.');
        }
      }
      exact(next);
      owner.assertCurrent();
      store.write(next);
      remember(owner, next);
      respond(true, { receipt: next });
    } catch (error) {
      respond(false, undefined, { code: 'invalid_request', message: error instanceof Error ? error.message : 'Execution admission is unavailable.' });
    }
  }, { scope: 'operator.admin', profileAccess: 'independent' });
  api.registerGatewayMethod(EXECUTION_ADMISSION_MAINTENANCE_METHOD,
    async ({ params, respond, client, signal, hasCurrentClientAuthority }) => {
      try {
        const authority = () => {
          signal?.throwIfAborted();
          if (api.lifecycle.signal?.aborted || client?.connect.client.mode !== 'backend' || hasCurrentClientAuthority?.() !== true)
            throw new Error('Execution admission maintenance requires a current backend authority.');
        };
        authority();
        if (!id(params.sessionKey) || !id(params.sessionId) || !id(params.runId))
          throw new Error('Exact execution admission identity is required.');
        const current = () => {
          const value = store.read(String(params.sessionKey));
          const receipt = value.receipt;
          if (!receipt || receipt.sessionId !== params.sessionId || receipt.runId !== params.runId ||
              (params.lifecycleRevision !== undefined && receipt.lifecycleRevision !== params.lifecycleRevision))
            throw new Error('Execution admission maintenance identity is unknown.');
          return receipt;
        };
        let receipt = current();
        if (params.operation === 'inspect') { respond(true, { receipt }); return; }
        if (params.id !== receipt.id || params.generation !== receipt.generation ||
            params.lifecycleRevision !== receipt.lifecycleRevision)
          throw new Error('Exact execution admission generation is required.');
        if (receipt.state === 'released') { respond(true, { receipt }); return; }
        exact(receipt);
        if (params.operation === 'revoke') receipt = { ...receipt, state: 'revoked' };
        else if (params.operation === 'cleanup') {
          if (!id(params.receiptId)) throw new Error('An exact backend cleanup receipt is required.');
          receipt = { ...receipt, cleanupReceipt: {
            id: params.receiptId, registrationId: receipt.owner.registrationId, source: 'backend-reconciliation',
          } };
        } else if (params.operation === 'release') {
          if (!receipt.sourceTerminal || !receipt.cleanupReceipt || receipt.cleanupReceipt.id !== params.receiptId)
            throw new Error('Execution settlement and cleanup receipt remain unconfirmed.');
          receipt = { ...receipt, state: 'released' };
        } else if (params.operation === 'abandon') {
          if (receipt.verified || receipt.effectIssued || receipt.sourceTerminal || params.neverSubmitted !== true)
            throw new Error('Only the owning sender can attest a never-submitted admission.');
          exact(receipt);
          const history = await api.runtime.gateway.request<Record<string, unknown>>('chat.history', {
            sessionKey: receipt.sessionKey, limit: 1, inputRunIds: [receipt.runId],
          }, { scopes: ['operator.admin'] });
          authority();
          const latest = current();
          if (latest.id !== receipt.id || latest.verified || latest.effectIssued || latest.sourceTerminal ||
              !record(history.sessionInfo) || history.sessionInfo.sessionId !== receipt.sessionId || history.sessionInfo.hasActiveRun !== false ||
              !record(history.pendingInputs) || history.pendingInputs.total !== 0 || !Array.isArray(history.pendingInputs.items) ||
              history.pendingInputs.items.length !== 0 || !Array.isArray(history.inputReceipts) || history.inputReceipts.length !== 0 ||
              !Array.isArray(history.inputConsumptions) || history.inputConsumptions.length !== 0)
            throw new Error('Native submission absence is unconfirmed.');
          exact(latest);
          receipt = { ...latest, state: 'released' };
        } else throw new Error('Maintenance cannot create or resume execution admissions.');
        authority();
        exact(receipt);
        store.write(receipt);
        respond(true, { receipt });
      } catch (error) {
        respond(false, undefined, { code: 'invalid_request', message: error instanceof Error ? error.message : 'Execution admission maintenance is unavailable.' });
      }
    }, { scope: 'operator.admin', profileAccess: 'independent' });
  api.registerTrustedToolPolicy({
    id: 'execution-admission', description: 'Protect exact enrolled execution identities after owner retirement or uncertain writes.',
    evaluate(_event, ctx) {
      if (!ctx.sessionKey) return;
      const value = store.read(ctx.sessionKey);
      if (!value.present || value.receipt?.state === 'released') return;
      const receipt = value.receipt;
      // A replacement incarnation never inherits an old run's authority or a
      // source-wide tool restriction. New launchers still query the held lane.
      if (!receipt || ctx.sessionId !== receipt.sessionId || ctx.runId !== receipt.runId) return;
      if (receipt && receipt.state === 'held' && receipt.verified && ownerCurrent(receipt) &&
          ctx.sessionId === receipt.sessionId && ctx.runId === receipt.runId) return;
      return { allow: false, reason: 'The enrolled execution admission is unknown or retired.' };
    },
  });
  const stopEvents = api.runtime.events.onAgentEvent(event => {
    if (!event.sessionKey || !Number.isSafeInteger(event.seq) || event.seq < 0 || event.stream !== 'lifecycle' || event.data?.executionSettled !== true ||
        !['end', 'error'].includes(String(event.data.phase))) return;
    const receipt = store.read(event.sessionKey).receipt;
    if (!receipt || receipt.state === 'released' || event.runId !== receipt.runId || event.sessionId !== receipt.sessionId) return;
    try {
      exact(receipt);
      store.write({ ...receipt, sourceTerminal: {
        runId: event.runId, sessionId: receipt.sessionId, phase: event.data.phase as 'end' | 'error',
        seq: event.seq, executionSettled: true,
      } });
    } catch { store.uncertain.add(receipt.sessionKey); }
  });
  api.lifecycle.onDispose?.(stopEvents);
  return { read };
}
