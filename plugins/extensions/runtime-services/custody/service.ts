import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
import { appendSessionTranscriptMessageByIdentity, readSessionTranscriptRawDelta } from 'openclaw/plugin-sdk/session-transcript-runtime';

import {
  CUSTODY_RPC,   type CustodyIdentity, type CustodyReceipt, type ExecutionReceipt, type ExecutionReceiptUpdate,
INERT_CUSTODY_CUSTOM_TYPE, INERT_CUSTODY_HARNESS,
} from '../sdk/custody';
import { CUSTODY_PROVIDER_KEY, custodyResourceId } from '../sdk/custody-client';
import type { OwnerProvider, VerifiedOwner } from '../sdk/owner-contract';
import { CustodyLedger, type CustodySlot, type StoredCustodyReceipt } from './ledger';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid custody object.');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('Invalid custody identity.');
  return value;
};
const hash = (value: unknown): string => {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error('Invalid custody digest.');
  return result;
};
const epoch = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('Invalid custody epoch.');
  return Number(value);
};
const operation = (value: unknown): string => {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/u.test(result)) throw new Error('Invalid custody operation.');
  return result;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nativeKey = (resourceId: string, value: number, agentId: string) => `agent:${agentId}:harness:${INERT_CUSTODY_HARNESS}:${resourceId}:${value}`;
const inputKey = (resourceId: string, value: number, operationId: string) => `custody:${resourceId}:${value}:${operationId}`;
function identity(value: unknown): CustodyIdentity {
  const input = object(value);
  const result = {
    resourceId: hash(input.resourceId), epoch: epoch(input.epoch), agentId: text(input.agentId, 64),
    sessionKey: text(input.sessionKey, 1024), sessionId: text(input.sessionId), lifecycleRevision: text(input.lifecycleRevision),
  };
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(result.agentId) ||
      result.sessionKey !== nativeKey(result.resourceId, result.epoch, result.agentId)) throw new Error('Custody native identity mismatch.');
  return result;
}

/** Required ownership of inert storage and exact content-free receipts; no optional business protocol. */
export function registerCustody(api: OpenClawPluginApi, owners: OwnerProvider): void {
  let ledger: CustodyLedger | undefined;
  let stopped = true;
  let serviceEpoch = 0;
  const preparing = new Map<string, Promise<CustodyIdentity>>();
  const enrolledRuns = new Map<string, Map<string, { ownerId: string; operationId: string }>>();
  const indexReceipt = (receipt: ExecutionReceipt) => {
    const key = JSON.stringify([receipt.ownerId, receipt.operationId]);
    for (const [runId, records] of enrolledRuns) { records.delete(key); if (!records.size) enrolledRuns.delete(runId); }
    for (const subject of receipt.subjects) {
      if (receipt.settledRunIds.includes(subject.runId)) continue;
      let records = enrolledRuns.get(subject.runId);
      if (!records) { records = new Map(); enrolledRuns.set(subject.runId, records); }
      records.set(key, { ownerId: receipt.ownerId, operationId: receipt.operationId });
    }
  };
  const requestAuthority = new AsyncLocalStorage<() => void>();
  const live = () => !stopped && Boolean(ledger) && api.lifecycle.signal?.aborted === false;
  const store = () => { if (!live()) throw new Error('Custody is unavailable.'); return ledger!; };
  const owner = (params: Record<string, unknown>): VerifiedOwner => {
    if (params.providerScope !== owners.scope || typeof params.ownerToken !== 'string') throw new Error('Custody owner scope mismatch.');
    const value = owners.resolve(params.ownerToken);
    if (!value) throw new Error('Custody writer is retired.');
    const assertCaller = requestAuthority.getStore();
    value.assertCurrent(); assertCaller?.();
    return { ...value, assertCurrent() { assertCaller?.(); value.assertCurrent(); } };
  };
  const current = (value: CustodyIdentity) => api.runtime.agent.session.getSessionEntry({ agentId: value.agentId, sessionKey: value.sessionKey, readConsistency: 'latest' });
  const owns = (slot: CustodySlot, entry: ReturnType<typeof current>) => {
    const namespace = entry?.pluginExtensions?.[api.id];
    const marker = namespace && typeof namespace === 'object' && !Array.isArray(namespace) ? (namespace as Record<string, unknown>).custody : undefined;
    return Boolean(entry && entry.agentHarnessId === INERT_CUSTODY_HARNESS && entry.permissionMode === 'read-only' && entry.sessionRoot === slot.cwd &&
      marker && typeof marker === 'object' && !Array.isArray(marker) &&
      Reflect.get(marker, 'resourceId') === slot.resourceId && Reflect.get(marker, 'epoch') === slot.epoch);
  };
  const ownsCleanup = (slot: CustodySlot, entry: ReturnType<typeof current>) => {
    if (owns(slot, entry)) return true;
    const namespace = entry?.pluginExtensions?.[api.id];
    return Boolean(entry && store().scope(slot.resourceId)?.closed && slot.identity &&
      entry.sessionId === slot.identity.sessionId && entry.lifecycleRevision === slot.identity.lifecycleRevision &&
      entry.agentHarnessId === INERT_CUSTODY_HARNESS && entry.sessionRoot === slot.cwd &&
      entry.permissionMode === 'read-only' &&
      entry.archivedAt !== undefined && entry.modelSelectionLocked === false &&
      (namespace === undefined || (namespace && typeof namespace === 'object' && !Array.isArray(namespace) && !('custody' in namespace))));
  };
  const assertIdentity = (value: CustodyIdentity, writer?: VerifiedOwner) => {
    const db = store(); db.assertOpen(value.resourceId, value.epoch);
    const slot = db.slot(value.resourceId, value.epoch);
    const native = current(value);
    if (!slot || slot.deleted || !slot.identity || slot.agentId !== value.agentId || slot.sessionKey !== value.sessionKey || (writer && slot.ownerId !== writer.pluginId) ||
        slot.identity.sessionId !== value.sessionId || slot.identity.lifecycleRevision !== value.lifecycleRevision ||
        !owns(slot, native) || native?.sessionId !== value.sessionId || native.lifecycleRevision !== value.lifecycleRevision ||
        native.modelSelectionLocked !== true || native.archivedAt !== undefined) throw new Error('Custody incarnation changed.');
    writer?.assertCurrent();
    return db;
  };
  const result = (receipt: StoredCustodyReceipt): CustodyReceipt => ({
    resourceId: receipt.resourceId, epoch: receipt.epoch, operationId: receipt.operationId, sha256: receipt.sha256,
    state: receipt.state === 'receiving' ? 'unknown' : receipt.state, ...(receipt.entryId ? { entryId: receipt.entryId } : {}),
  });
  const locator = (params: Record<string, unknown>) => {
    const value = identity(params.identity);
    if (params.resourceId !== value.resourceId || params.epoch !== value.epoch) throw new Error('Custody locator mismatch.');
    return { identity: value, operationId: operation(params.operationId), sha256: hash(params.sha256), entryId: params.entryId === undefined ? undefined : text(params.entryId) };
  };
  const readExact = async (input: ReturnType<typeof locator>, writer?: VerifiedOwner) => {
    const assertCaller = requestAuthority.getStore();
    const db = assertIdentity(input.identity, writer);
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
      assertCaller?.();
      assertIdentity(input.identity, writer);
      const receipt = db.receipt(input.identity.resourceId, input.identity.epoch, input.operationId);
      if (!receipt || receipt.state === 'cancelled' || receipt.sha256 !== input.sha256) throw new Error('Custody receipt is unavailable.');
      const page = await readSessionTranscriptRawDelta({ agentId: input.identity.agentId, sessionKey: input.identity.sessionKey,
        sessionId: input.identity.sessionId, ...(cursor ? { cursor } : {}), maxBytes: 2 * 1024 * 1024, maxEvents: 128 });
      assertCaller?.(); assertIdentity(input.identity, writer);
      if (db.receipt(input.identity.resourceId, input.identity.epoch, input.operationId)?.state === 'cancelled') throw new Error('Custody input cancelled.');
      if (page.kind !== 'page') throw new Error('Custody native storage is unavailable.');
      for (const row of page.events) {
        const event = object(row.event);
        if (event.type !== 'message' || typeof event.id !== 'string' || !event.message || typeof event.message !== 'object') continue;
        const message = object(event.message);
        if (message.idempotencyKey !== inputKey(input.identity.resourceId, input.identity.epoch, input.operationId)) continue;
        const metadata = object(object(message.__openclaw).custody);
        if (message.role !== 'custom' || message.customType !== INERT_CUSTODY_CUSTOM_TYPE || message.display !== false || message.excludeFromContext !== true ||
            (input.entryId && input.entryId !== event.id) || (receipt.entryId && receipt.entryId !== event.id) ||
            metadata.resourceId !== input.identity.resourceId || metadata.epoch !== input.identity.epoch ||
            metadata.operationId !== input.operationId || metadata.sha256 !== input.sha256 || !Array.isArray(message.content) || message.content.length !== 1)
          throw new Error('Custody native input conflicts with its receipt.');
        const content = object(message.content[0]);
        if (content.type !== 'text' || typeof content.text !== 'string' || digest(content.text) !== input.sha256) throw new Error('Custody payload digest mismatch.');
        return { identity: input.identity, payload: content.text, entryId: event.id };
      }
      if (!page.hasMore) return;
      if (!page.cursor || cursor === page.cursor) throw new Error('Custody cursor did not advance.');
      cursor = page.cursor;
    }
    throw new Error('Custody native read exceeded its bounded window.');
  };
  type Handler = Parameters<OpenClawPluginApi['registerGatewayMethod']>[1];
  const handler = (work: (params: Record<string, unknown>) => unknown | Promise<unknown>, activeOwner = false): Handler => async request => {
    try {
      const assertCaller = () => {
        const ownsRequest = activeOwner && request.params.providerScope === owners.scope && typeof request.params.ownerToken === 'string' && Boolean(owners.resolve(request.params.ownerToken));
        if (!live() || request.signal?.aborted || request.client?.connect.client.mode !== 'backend' ||
            request.hasCurrentClientAuthority?.() === false || (request.hasCurrentClientAuthority?.() !== true && !ownsRequest))
          throw new Error('Custody requires a current backend request.');
      };
      assertCaller(); const result = await requestAuthority.run(assertCaller, () => work(request.params)); assertCaller(); request.respond(true, result);
    } catch { request.respond(false, undefined, { code: 'UNAVAILABLE', message: 'Custody operation is unavailable.' }); }
  };
  const providers: Map<string, unknown> = (() => {
    const key = Symbol.for(CUSTODY_PROVIDER_KEY);
    const existing: unknown = Reflect.get(globalThis, key);
    if (existing !== undefined && !(existing instanceof Map)) throw new Error('Custody metadata protocol is incompatible.');
    if (existing instanceof Map) return existing;
    const value = new Map<string, unknown>(); Object.defineProperty(globalThis, key, { value }); return value;
  })();
  const port = Object.freeze({
    isCurrent: live,
    writeExecutionReceipt(ownerToken: string, input: ExecutionReceiptUpdate) {
      const write = () => {
        const writer = owners.resolve(ownerToken); if (!writer) throw new Error('Receipt writer is retired.'); writer.assertCurrent();
        const db = store(); const operationId = hash(input.operationId); const inputSha256 = hash(input.inputSha256);
        if (!Array.isArray(input.subjects) || input.subjects.length > 256 || typeof input.cleanupComplete !== 'boolean') throw new Error('Invalid execution receipt.');
        const previous = db.execution(writer.pluginId, operationId);
        if (previous && previous.inputSha256 !== inputSha256) throw new Error('Execution receipt digest conflict.');
        const subjects = input.subjects.map(value => ({ agentId: text(value.agentId, 64), sessionKey: text(value.sessionKey, 1024),
          sessionId: text(value.sessionId), lifecycleRevision: text(value.lifecycleRevision), runId: text(value.runId) }));
        if (new Set(subjects.map(value => value.runId)).size !== subjects.length) throw new Error('Duplicate execution identity.');
        for (const subject of subjects) {
          const native = api.runtime.agent.session.getSessionEntry({ agentId: subject.agentId, sessionKey: subject.sessionKey, readConsistency: 'latest' });
          if (native?.sessionId !== subject.sessionId || native.lifecycleRevision !== subject.lifecycleRevision) throw new Error('Execution enrollment incarnation changed.');
        }
        if (previous && previous.subjects.some(old => !subjects.some(value => value.runId === old.runId && value.sessionKey === old.sessionKey && value.sessionId === old.sessionId && value.lifecycleRevision === old.lifecycleRevision)))
          throw new Error('Execution enrollment cannot be withdrawn or replaced.');
        if (previous?.state === 'settled' && subjects.length !== previous.subjects.length) throw new Error('Settled execution enrollment cannot be extended.');
        const next: ExecutionReceipt = {
          operationId, ownerId: writer.pluginId, writerRegistrationId: writer.registrationId, inputSha256,
          state: previous?.state ?? 'open', subjects: subjects.map(value => ({ ...value, ...(previous?.subjects.find(old => old.runId === value.runId)?.outcome ? { outcome: previous.subjects.find(old => old.runId === value.runId)!.outcome } : {}) })),
          settledRunIds: previous?.settledRunIds ?? [], cleanupComplete: input.cleanupComplete,
          cancelRequested: previous?.cancelRequested ?? false,
        };
        if (previous && previous.writerRegistrationId !== writer.registrationId) throw new Error('Execution receipt belongs to a retired writer.');
        next.state = next.subjects.length > 0 && next.cleanupComplete && next.subjects.every(value => next.settledRunIds.includes(value.runId) && value.outcome) ? 'settled' : next.cancelRequested ? 'unknown' : 'open';
        writer.assertCurrent(); db.saveExecution(next); indexReceipt(next);
      };
      const run = api.lifecycle.runInBackgroundContext; if (!run) throw new Error('Custody native context is unavailable.'); run(write);
    },
  });
  api.registerAgentHarness({ id: INERT_CUSTODY_HARNESS, label: 'Inert input storage', supports: () => ({ supported: false, reason: 'Inert storage cannot execute.' }), async runAttempt() { throw new Error('Inert storage cannot execute.'); } });
  api.on('before_agent_run', (_event, context) => {
    if (new RegExp(`^agent:[^:]+:harness:${INERT_CUSTODY_HARNESS}:`).test(context.sessionKey ?? '')) return { outcome: 'block', reason: 'Inert storage cannot execute.' };
  });
  let unsubscribe: (() => void) | undefined;
  api.registerService({ id: 'inert-custody', start(context) {
    ledger = new CustodyLedger(path.join(context.stateDir, 'runtime-custody')); stopped = false; serviceEpoch++;
    enrolledRuns.clear();
    for (const receipt of ledger.executions(() => api.logger.error('[Custody] An execution receipt is unreadable.'))) indexReceipt(receipt);
    providers.set(owners.scope, port);
    unsubscribe = api.runtime.events.onAgentEvent(event => {
      if (!live() || event.stream !== 'lifecycle' || !Number.isSafeInteger(event.seq) || event.seq < 0 || event.data.executionSettled !== true || !['end', 'error'].includes(String(event.data.phase))) return;
      for (const locator of [...(enrolledRuns.get(event.runId)?.values() ?? [])]) {
        try {
        const receipt = store().execution(locator.ownerId, locator.operationId);
        if (!receipt) continue;
        const subject = receipt.subjects.find(value => value.runId === event.runId && value.sessionKey === event.sessionKey && value.sessionId === event.sessionId);
        if (!subject || receipt.settledRunIds.includes(event.runId)) continue;
        const native = api.runtime.agent.session.getSessionEntry({ agentId: subject.agentId, sessionKey: subject.sessionKey, readConsistency: 'latest' });
        if (native?.sessionId !== subject.sessionId || native.lifecycleRevision !== subject.lifecycleRevision) continue;
        subject.outcome = event.data.aborted === true ? 'cancelled' : event.data.phase === 'error' ? 'failed' : 'completed';
        receipt.settledRunIds.push(event.runId);
        if (receipt.cleanupComplete && receipt.subjects.every(value => receipt.settledRunIds.includes(value.runId) && value.outcome)) receipt.state = 'settled';
        store().saveExecution(receipt); indexReceipt(receipt);
        } catch { api.logger.error('[Custody] An execution receipt could not be reconciled.'); }
      }
    });
  }, stop() { stopped = true; serviceEpoch++; unsubscribe?.(); unsubscribe = undefined; enrolledRuns.clear(); if (providers.get(owners.scope) === port) providers.delete(owners.scope); } });
  api.registerGatewayMethod(CUSTODY_RPC.prepare, handler(async params => {
    const writer = owner(params); const db = store();
    const scopeId = text(params.scopeId, 128); const value = epoch(params.epoch); const agentId = text(params.agentId, 64); const cwd = text(params.cwd, 4096);
    if (!path.isAbsolute(cwd) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) throw new Error('Invalid custody scope.');
    const resourceId = custodyResourceId(writer.pluginId, scopeId); db.advance(resourceId, value, writer.pluginId);
    const slot = db.slot(resourceId, value) ?? { resourceId, epoch: value, ownerId: writer.pluginId, agentId, cwd, sessionKey: nativeKey(resourceId, value, agentId) };
    if (slot.deleted || slot.agentId !== agentId || slot.cwd !== cwd || slot.ownerId !== writer.pluginId) throw new Error('Custody slot changed.');
    db.saveSlot(slot); const key = `${resourceId}:${value}`; const previous = preparing.get(key); if (previous) return previous;
    const captured = serviceEpoch;
    const prepare = (async () => {
      writer.assertCurrent(); db.assertOpen(resourceId, value);
      const scope = { agentId, sessionKey: slot.sessionKey, readConsistency: 'latest' as const };
      if (!api.runtime.agent.session.getSessionEntry(scope)) {
        await api.runtime.agent.session.createSessionEntry({ cfg: api.runtime.config.current() as OpenClawConfig,
          key: slot.sessionKey, agentId, sessionRoot: cwd, permissionMode: 'read-only', initialEntry: {
            agentHarnessId: INERT_CUSTODY_HARNESS, modelSelectionLocked: true,
            pluginExtensions: { [api.id]: { custody: { resourceId, epoch: value } } },
          } });
      }
      const entry = api.runtime.agent.session.getSessionEntry(scope);
      if (!owns(slot, entry) || !entry?.sessionId || !entry.lifecycleRevision || entry.modelSelectionLocked !== true) throw new Error('Custody native owner changed.');
      const valueIdentity = { resourceId, epoch: value, agentId, sessionKey: slot.sessionKey, sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision };
      if (slot.identity && slot.identity.sessionId !== valueIdentity.sessionId) throw new Error('Custody incarnation changed.');
      db.saveSlot({ ...slot, identity: valueIdentity });
      if (serviceEpoch !== captured) throw new Error('Custody registration retired.');
      assertIdentity(valueIdentity, writer); return valueIdentity;
    })();
    preparing.set(key, prepare); try { return await prepare; } finally { if (preparing.get(key) === prepare) preparing.delete(key); }
  }, true), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.append, handler(async params => {
    const writer = owner(params); const value = identity(params.identity); const db = assertIdentity(value, writer);
    const operationId = operation(params.operationId); const sha256 = hash(params.sha256); const payload = text(params.payload, 512 * 1024);
    if (Buffer.byteLength(payload, 'utf8') > 512 * 1024 || digest(payload) !== sha256) throw new Error('Custody payload digest mismatch.');
    const previous = db.receipt(value.resourceId, value.epoch, operationId);
    if (previous) { if (previous.sha256 && previous.sha256 !== sha256) throw new Error('Custody receipt conflict.'); return result({ ...previous, sha256 }); }
    const receipt: StoredCustodyReceipt = { resourceId: value.resourceId, epoch: value.epoch, operationId, sha256, state: 'receiving', writerRegistrationId: writer.registrationId, timestamp: Date.now() };
    db.saveReceipt(receipt); const captured = serviceEpoch;
    try {
      const written = await appendSessionTranscriptMessageByIdentity({ agentId: value.agentId, sessionKey: value.sessionKey, sessionId: value.sessionId,
        config: api.runtime.config.current() as OpenClawConfig, idempotencyLookup: 'scan', beforeFreshMessageCommit() {
          assertIdentity(value, writer); const latest = db.receipt(value.resourceId, value.epoch, operationId);
          if (captured !== serviceEpoch || latest?.state !== 'receiving' || latest.writerRegistrationId !== writer.registrationId || latest.sha256 !== sha256) throw new Error('Custody input cancelled.');
        }, message: { role: 'custom', customType: INERT_CUSTODY_CUSTOM_TYPE, display: false, excludeFromContext: true, timestamp: receipt.timestamp,
          idempotencyKey: inputKey(value.resourceId, value.epoch, operationId), content: [{ type: 'text', text: payload }],
          __openclaw: { custody: { resourceId: value.resourceId, epoch: value.epoch, operationId, sha256 } } } });
      const latest = db.receipt(value.resourceId, value.epoch, operationId);
      if (latest?.state === 'cancelled') return result({ ...latest, sha256 });
      if (!written || captured !== serviceEpoch) throw new Error('Custody result unknown.');
      const acknowledged = await readExact({ identity: value, operationId, sha256, entryId: written.messageId }, writer);
      if (!acknowledged) throw new Error('Custody result unknown.');
      assertIdentity(value, writer);
      const finalReceipt = db.receipt(value.resourceId, value.epoch, operationId);
      if (finalReceipt?.state === 'cancelled') return result({ ...finalReceipt, sha256 });
      if (!finalReceipt || finalReceipt.writerRegistrationId !== writer.registrationId) throw new Error('Custody writer changed.');
      const saved = { ...receipt, state: 'saved' as const, entryId: acknowledged.entryId }; db.saveReceipt(saved); return result(saved);
    } catch {
      const latest = db.receipt(value.resourceId, value.epoch, operationId);
      if (latest?.state === 'cancelled') return result({ ...latest, sha256 });
      if (latest?.state === 'receiving') db.saveReceipt({ ...receipt, state: 'unknown' });
      return result({ ...receipt, state: 'unknown' });
    }
  }, true), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.read, handler(async params => {
    const writer = owner(params); const input = locator(params); const db = assertIdentity(input.identity, writer);
    if (db.receipt(input.identity.resourceId, input.identity.epoch, input.operationId)?.state !== 'saved') throw new Error('Custody result unknown.');
    const saved = await readExact(input, writer); if (!saved) throw new Error('Custody result unknown.'); return saved;
  }, true), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.inspect, handler(async params => {
    const writer = params.ownerToken === undefined ? undefined : owner(params);
    const input = locator(params); const db = store(); const receipt = db.receipt(input.identity.resourceId, input.identity.epoch, input.operationId);
    if (!receipt || (receipt.sha256 && receipt.sha256 !== input.sha256)) throw new Error('Custody receipt is unavailable.');
    if (receipt.state === 'cancelled') return result({ ...receipt, sha256: input.sha256 });
    const saved = await readExact(input, writer); if (!saved) return result({ ...receipt, state: 'unknown' });
    requestAuthority.getStore()?.(); assertIdentity(input.identity, writer);
    const latest = db.receipt(input.identity.resourceId, input.identity.epoch, input.operationId);
    if (latest?.state === 'cancelled') return result(latest);
    const verified = { ...receipt, state: 'saved' as const, entryId: saved.entryId }; db.saveReceipt(verified); return result(verified);
  }, true), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.cancel, handler(params => {
    const resourceId = hash(params.resourceId); const value = epoch(params.epoch); const db = store();
    if (!db.scope(resourceId)) throw new Error('Custody scope is unavailable.');
    if (params.operationIds !== undefined && (!Array.isArray(params.operationIds) || params.operationIds.length > 256)) throw new Error('Invalid custody cancellation.');
    db.cancel(resourceId, value, (params.operationIds as unknown[] | undefined)?.map(operation)); return { cancelled: true };
  }), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.close, handler(async params => {
    const resourceId = hash(params.resourceId); const db = store(); if (!db.scope(resourceId)) throw new Error('Custody scope is unavailable.'); db.close(resourceId);
    await Promise.allSettled([...preparing.entries()].filter(([key]) => key.startsWith(resourceId + ':')).map(([, pending]) => pending));
    requestAuthority.getStore()?.();
    const identities: CustodyIdentity[] = [];
    for (const slot of db.slots(resourceId)) {
      if (slot.deleted) continue;
      const entry = api.runtime.agent.session.getSessionEntry({ agentId: slot.agentId, sessionKey: slot.sessionKey, readConsistency: 'latest' });
      if (!entry) { db.saveSlot({ ...slot, deleted: true }); continue; }
      if (!ownsCleanup(slot, entry) || !entry.sessionId || !entry.lifecycleRevision || (slot.identity && slot.identity.sessionId !== entry.sessionId)) throw new Error('Custody incarnation changed.');
      const latest = { resourceId, epoch: slot.epoch, agentId: slot.agentId, sessionKey: slot.sessionKey, sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision };
      db.saveSlot({ ...slot, identity: latest }); identities.push(latest);
    }
    return { closed: true, identities };
  }), { scope: 'operator.admin' });
  api.registerGatewayMethod(CUSTODY_RPC.unlock, handler(async params => {
    const assertCaller = requestAuthority.getStore();
    const value = identity(params.identity); const db = store(); const slot = db.slot(value.resourceId, value.epoch); const entry = current(value);
    if (!slot || !slot.identity || slot.deleted || slot.agentId !== value.agentId || slot.sessionKey !== value.sessionKey || !db.scope(value.resourceId)?.closed || !ownsCleanup(slot, entry) ||
        entry?.sessionId !== value.sessionId || entry.lifecycleRevision !== value.lifecycleRevision || entry.archivedAt === undefined) throw new Error('Custody incarnation changed.');
    if (entry.modelSelectionLocked === true) await api.runtime.agent.session.patchSessionEntry({ agentId: value.agentId, sessionKey: value.sessionKey, update: currentEntry => {
      assertCaller?.();
      if (!ownsCleanup(slot, currentEntry) || currentEntry.sessionId !== value.sessionId || currentEntry.lifecycleRevision !== value.lifecycleRevision || currentEntry.archivedAt === undefined) throw new Error('Custody incarnation changed.');
      return { modelSelectionLocked: false };
    } });
    assertCaller?.(); const unlocked = current(value);
    if (!ownsCleanup(slot, unlocked) || unlocked?.sessionId !== value.sessionId || !unlocked.lifecycleRevision || unlocked.archivedAt === undefined || unlocked.modelSelectionLocked === true) throw new Error('Custody unlock is unconfirmed.');
    const latest = { ...value, lifecycleRevision: unlocked.lifecycleRevision }; db.saveSlot({ ...slot, identity: latest }); return { identity: latest };
  }), { scope: 'operator.admin' });
  for (const method of [CUSTODY_RPC.receiptInspect, CUSTODY_RPC.receiptCancel]) api.registerGatewayMethod(method, handler(async params => {
    const ownerId = text(params.ownerId); const operationId = hash(params.operationId); const db = store(); const receipt = db.execution(ownerId, operationId);
    if (!receipt) return { receipt: null };
    if (receipt.ownerId !== ownerId || receipt.operationId !== operationId || (params.expectedWriterRegistrationId !== undefined && params.expectedWriterRegistrationId !== receipt.writerRegistrationId)) throw new Error('Execution receipt identity changed.');
    if (method === CUSTODY_RPC.receiptCancel) {
      receipt.cancelRequested = true; if (receipt.state !== 'settled') receipt.state = 'unknown'; db.saveExecution(receipt);
      for (const subject of receipt.subjects) {
        requestAuthority.getStore()?.();
        if (receipt.settledRunIds.includes(subject.runId)) continue;
        const native = api.runtime.agent.session.getSessionEntry({ agentId: subject.agentId, sessionKey: subject.sessionKey, readConsistency: 'latest' });
        if (native?.sessionId !== subject.sessionId || native.lifecycleRevision !== subject.lifecycleRevision) throw new Error('Execution cancellation incarnation changed.');
        // Preserve the authenticated operator caller. Never use this service's
        // managed executor to impersonate the plugin that launched the run.
        const result = await dispatchGatewayMethod('sessions.abort', { key: subject.sessionKey, runId: subject.runId });
        requestAuthority.getStore()?.();
        if (!result.ok) throw new Error('Execution cancellation is unconfirmed.');
      }
    }
    return { receipt };
  }), { scope: 'operator.admin' });
}
