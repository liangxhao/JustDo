import { DatabaseSync } from 'node:sqlite';

import { EXECUTION_ADMISSION_MAINTENANCE_METHOD, type ExecutionAdmissionReceipt } from '@runtime-services/sdk/admission';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

import { AgentTeamLaunchCoordinator } from './agentTeamLaunchCoordinator';

const sessionId = 'source';
const sessionKey = 'agent:organizer:justdo:source';
const nativeSessionId = 'native-source';
const lifecycleRevision = 'native-revision';
const runId = 'previous-launch';
const receiptKey = 'agentTeam.launch.receipt.' + sessionId;
const databases: DatabaseSync[] = [];

afterEach(() => databases.splice(0).forEach(db => db.close()));

function fixture({ submitted = true, settled = true, pending = false, replacement = false, releaseRequested = false, cleanupRecorded = false } = {}) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  const enrolled: ExecutionAdmissionReceipt = {
    version: 2, id: 'admission', generation: 1, sessionKey, sessionId: nativeSessionId,
    lifecycleRevision, runId, owner: { pluginId: 'agent-team', registrationId: 'retired-owner', providerScope: 'old-gateway' },
    state: 'held', verified: submitted, effectIssued: false,
    ...(settled ? { sourceTerminal: { runId, sessionId: nativeSessionId, phase: 'end', seq: 1, executionSettled: true } } : {}),
    ...(cleanupRecorded ? { cleanupReceipt: {
      id: `${runId}:1:dispatcher-cleanup`, registrationId: 'retired-owner', source: 'backend-reconciliation',
    } } : {}),
  };
  db.prepare('INSERT INTO kv VALUES(?,?,0)').run(receiptKey, JSON.stringify({
    version: 1, sessionId, sessionKey, nativeSessionId, lifecycleRevision, clientTurnId: runId,
    promptSha256: 'a'.repeat(64), mode: 'collaboration', state: 'pending', expectedGeneration: 0,
    registerAcknowledged: true, generation: 1, localGeneration: 1,
    submissionStarted: submitted, wholeSettled: settled,
    cancelRequested: false, abandonRequested: false, releaseRequested,
    executionAdmission: { id: enrolled.id, generation: enrolled.generation },
  }));
  const metadata = () => {
    const { value } = db.prepare('SELECT value FROM kv WHERE key = ?').get(receiptKey) as { value: string };
    return JSON.parse(value);
  };
  const rpc = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'sessions.describe') return {
      session: {
        key: sessionKey, sessionId: replacement ? 'replacement-native' : nativeSessionId,
        lifecycleRevision, hasActiveRun: false,
      },
    };
    if (method === 'chat.history') return {
      sessionInfo: { sessionId: nativeSessionId, hasActiveRun: false },
      pendingInputs: { total: pending ? 1 : 0, items: pending ? [{ runId }] : [] },
      inputReceipts: [],
      inputConsumptions: [],
    };
    if (method !== EXECUTION_ADMISSION_MAINTENANCE_METHOD) throw new Error('Unexpected RPC');
    expect(params).toMatchObject({ sessionKey, sessionId: nativeSessionId, lifecycleRevision, runId });
    if (params.operation !== 'inspect') expect(params).toMatchObject({ id: enrolled.id, generation: enrolled.generation });
    if (params.operation === 'cleanup') {
      enrolled.cleanupReceipt = { id: String(params.receiptId), registrationId: enrolled.owner.registrationId, source: 'backend-reconciliation' };
    } else if (params.operation === 'release') {
      expect(enrolled.sourceTerminal?.executionSettled).toBe(true);
      expect(params.receiptId).toBe(enrolled.cleanupReceipt?.id);
      enrolled.state = 'released';
    } else if (params.operation === 'abandon') {
      expect(params.neverSubmitted).toBe(true);
      enrolled.state = 'released';
    } else if (params.operation === 'revoke') {
      enrolled.state = 'revoked';
    }
    return { receipt: structuredClone(enrolled) };
  });
  const coordinator = new AgentTeamLaunchCoordinator({
    getDatabase: () => db as unknown as Database.Database,
    requestGateway: async <T>(method: string, params?: unknown) => await rpc(method, params as Record<string, unknown> | undefined) as T,
  });
  const operations = () => rpc.mock.calls
    .filter(([method]) => method === EXECUTION_ADMISSION_MAINTENANCE_METHOD)
    .map(([, params]) => params?.operation);
  return { coordinator, enrolled, metadata, operations, rpc };
}

it('releases an older exact settled launch through backend maintenance', async () => {
  const f = fixture();

  expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);

  expect(f.operations()).toEqual(['inspect', 'cleanup', 'release']);
  expect(f.rpc).toHaveBeenCalledWith('sessions.describe', { key: sessionKey });
  expect(f.metadata().state).toBe('released');
  expect(f.coordinator.protectedSessionIds()).toEqual([]);
});

it.each([{ settled: false }, { pending: true }, { replacement: true }])('keeps an older receipt held when exact cleanup is unavailable (%j)', async options => {
  const f = fixture(options);

  expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);

  expect(f.operations()).toEqual(['inspect']);
  expect(f.coordinator.protectedSessionIds()).toEqual([sessionId]);
});

it('abandons only a proven never-submitted older launch', async () => {
  const f = fixture({ submitted: false, settled: false });

  expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);

  expect(f.operations()).toEqual(['inspect', 'abandon']);
  expect(f.enrolled.state).toBe('released');
});

it('finishes a previous interrupted release using its recorded cleanup', async () => {
  const f = fixture({ releaseRequested: true, cleanupRecorded: true });

  expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(true);

  expect(f.operations()).toEqual(['inspect', 'release']);
});

it('leaves cancellation of an unsettled old run fenced until exact settlement', async () => {
  const f = fixture({ settled: false });

  await f.coordinator.cancel(sessionId);
  expect(await f.coordinator.releaseIfSettled(sessionId)).toBe(false);

  expect(f.metadata().state).toBe('cancelled');
  expect(f.operations()).toEqual(['inspect', 'revoke', 'inspect']);
});
