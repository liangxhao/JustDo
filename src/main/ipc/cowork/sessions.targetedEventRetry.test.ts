import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendBehaviorPluginPrompt, behaviorSessionParticipants } from '../../../../tests/plugin-host/mainBehaviorParticipants';
import { CoworkStore } from '../../data/coworkStore';
import { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import type { OpenClawEngineManager } from '../../openclaw/runtime/engineManager';

const ipc = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => ipc.set(channel, handler) },
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => 'fixture' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../core/filesystem/projectGit', () => ({ ensureProjectGitRepository: vi.fn(async () => {}) }));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

import { registerCoworkSessionHandlers } from './sessions';

const databases: DatabaseSync[] = [];
const workspaces: string[] = [];
beforeEach(() => { ipc.clear(); vi.useFakeTimers(); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  databases.splice(0).forEach(database => database.close());
  workspaces.splice(0).forEach(workspace => fs.rmdirSync(workspace));
  vi.restoreAllMocks();
});

type TransportSeam = {
  gatewayClient: GatewayClientLike | null;
  gatewayClientGeneration: number;
  ensureGatewayClientReady: () => Promise<void>;
  handleGatewayEvent: (event: GatewayEventFrame) => void;
};
type NativeRow = {
  key: string; agentId: string; sessionId: string; lifecycleRevision?: string | null;
  hasActiveRun: boolean; hasActiveSubagentRun?: boolean; permissionMode: string; sessionRoot: string;
};
type PointRead = (index: number, current: NativeRow) => Promise<NativeRow | null> | NativeRow | null;

/** Actual product SQL materialization, adapter property context, router and IPC.
 * Electron/UI, Git setup, plugin preparation and network transport are controlled ports.
 * No Gateway, native database, model, user profile or better-sqlite3 ABI is opened.
 */
function fixture(options: { bound?: boolean; customAgent?: boolean; checkpoint?: boolean } = {}) {
  const native = new DatabaseSync(':memory:');
  databases.push(native);
  native.exec(`
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE cowork_config(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE cowork_sessions(
      id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,pinned INTEGER DEFAULT 0,cwd TEXT NOT NULL,
      execution_mode TEXT,permission_mode TEXT,active_skill_ids TEXT,agent_id TEXT NOT NULL,model_ref TEXT,source TEXT,
      native_session_key TEXT,native_parent_session_id TEXT,forked_from_session_id TEXT,forked_from_session_title TEXT,
      forked_from_entry_id TEXT,handoff_from_session_id TEXT,handoff_from_session_title TEXT,handoff_request_id TEXT,
      group_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE history_session_bindings(
      session_id TEXT PRIMARY KEY,session_key TEXT NOT NULL,native_session_id TEXT NOT NULL,
      availability TEXT NOT NULL,defaults_applied INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE cowork_session_runs(
      id TEXT PRIMARY KEY,session_id TEXT NOT NULL,client_turn_id TEXT UNIQUE NOT NULL,root_run_id TEXT,
      model_ref TEXT,state TEXT NOT NULL,started_at INTEGER NOT NULL,accepted_at INTEGER,ended_at INTEGER,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE TABLE agents(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',system_prompt TEXT NOT NULL DEFAULT '',
      identity TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',icon TEXT NOT NULL DEFAULT '',
      skill_ids TEXT NOT NULL DEFAULT '[]',enabled INTEGER NOT NULL DEFAULT 1,is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
  `);
  const database = {
    prepare: (sql: string) => native.prepare(sql),
    transaction: <T,>(operation: () => T) => () => {
      native.exec('SAVEPOINT fixture_transaction');
      try { const result = operation(); native.exec('RELEASE fixture_transaction'); return result; }
      catch (error) { native.exec('ROLLBACK TO fixture_transaction'); native.exec('RELEASE fixture_transaction'); throw error; }
    },
  } as unknown as Database.Database;
  const store = new CoworkStore(database);
  const agentId = options.customAgent ? '92ae94e2-f00b-4d5e-8d11-cf40de156ccc' : 'main';
  native.prepare('INSERT INTO agents(id,name,created_at,updated_at) VALUES(?,?,1,1)').run(agentId, 'Fixture');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'main-send-status-'));
  workspaces.push(workspace);
  const product = store.createSession('Existing product conversation', workspace, 'local', [], agentId, 'ask');
  const key = `agent:${agentId}:justdo:${product.id}`;
  const physicalId = '1f3c8111-d721-43e9-b81c-7bde629ba518';
  if (options.bound) {
    native.prepare('UPDATE cowork_sessions SET native_session_key=? WHERE id=?').run(key, product.id);
    native.prepare("INSERT INTO history_session_bindings VALUES(?,?,?,'native',1)").run(product.id, key, physicalId);
  }
  const old = store.beginSessionRun({ sessionId: product.id, clientTurnId: 'previous-input', startedAt: 1 });
  store.bindSessionRunRootRun(old.id, 'previous-native-run');
  store.finishSessionRun(old.id, options.checkpoint ? 'aborted' : 'completed', options.checkpoint ? 1 : 2);
  if (options.checkpoint)
    native.prepare('UPDATE cowork_session_runs SET accepted_at=1 WHERE id=?').run(old.id);
  const adapter = new OpenClawRuntimeAdapter(store, {} as OpenClawEngineManager);
  // Transport readiness is the only adapter collaborator replaced. All actual
  // status contexts, custody and event handlers remain owned by this adapter.
  const seam = adapter as unknown as TransportSeam;
  seam.ensureGatewayClientReady = vi.fn(async () => {});
  seam.gatewayClientGeneration = 1;
  const methods: string[] = [];
  let pointReads = 0;
  let pointRead: PointRead = (_index, row) => ({ ...row });
  const row: NativeRow = { key, agentId, sessionId: physicalId, lifecycleRevision: 'current-revision',
    hasActiveRun: false, permissionMode: 'guarded', sessionRoot: product.cwd };
  const request = vi.fn(async <T,>(method: string, parameters?: unknown): Promise<T> => {
    methods.push(method);
    if (method === 'sessions.list' || method === 'chat.send' || method === 'agent')
      throw new Error(`Unexpected global query or execution: ${method}`);
    if (method === 'sessions.describe') {
      const params = parameters as { key?: unknown; agentId?: unknown };
      expect(params.key).toBe(key);
      if (params.agentId !== undefined) expect(params.agentId).toBe(agentId);
      return { session: await pointRead(++pointReads, row) } as T;
    }
    if (method === 'sessions.create') return { key, sessionId: physicalId, entry: { ...row } } as T;
    throw new Error(`Unexpected transport method: ${method}`);
  });
  seam.gatewayClient = { request, start: () => {}, stop: () => {} };
  const router = new CoworkEngineRouter({ openclawRuntime: adapter });
  const launch = { register: vi.fn(async ({ sessionId }: { sessionId: string }) => {
    // Exercise the real host's SDK status port before the synthetic plugin prepares.
    // Native identity, event retirement, descendants and unknown custody are decided by the adapter.
    const status = await router.getSessionRuntimeStatus(sessionId, {
      includeSubagents: true, forceRefresh: true, targeted: true,
    });
    if (!status.known || status.running || status.mainRunning || status.subagentRunning)
      throw new Error('fixture-plugin-source-unavailable');
    await router.prepareSession(sessionId);
  }) };
  registerCoworkSessionHandlers({ getCoworkStore: () => store, getCoworkEngineRouter: () => router,
    setSessionPermissionMode: vi.fn(), getSessionPlugins: () => behaviorSessionParticipants(undefined, launch) });
  const changed = (payload: Record<string, unknown> = { reason: 'create', agentId, catalogChanged: true, ts: Date.now() }) =>
    seam.handleGatewayEvent({ event: 'sessions.changed', payload });
  const send = () => ipc.get('cowork:session:run:begin')!({}, { sessionId: product.id, clientTurnId: 'next-input', startedAt: 10,
    pluginPrompt: appendBehaviorPluginPrompt('Synthetic selection', 'group') });
  const setRead = (next: PointRead) => { pointRead = next; };
  const assertNoExecution = () => {
    expect(methods).not.toContain('sessions.list'); expect(methods).not.toContain('chat.send'); expect(methods).not.toContain('agent');
  };
  return { native, store, adapter, router, seam, product, row, key, physicalId, methods, request, changed, send, setRead,
    reads: () => pointReads, assertNoExecution };
}

describe('late native publication through actual Main admission layers', () => {
  it.each([false, true])('reobserves once after a create reply for an existing unbound conversation (custom=%s)', async customAgent => {
    const f = fixture({ customAgent });
    // Mirrors ordinary completed history without a native-key/history-binding row.
    expect(f.store.getSession(f.product.id)).not.toHaveProperty('nativeSessionKey');
    expect(f.store.getSession(f.product.id)).not.toHaveProperty('historyBinding');
    expect(f.store.getSessionRuns(f.product.id)).toHaveLength(1);
    await expect(f.router.prepareSession(f.product.id)).resolves.toEqual({ sessionKey: f.key, gatewaySessionId: f.physicalId });
    expect(f.methods).toEqual(['sessions.describe', 'sessions.create']);
    const preparedMethods = f.methods.length;
    const preparedReads = f.reads();
    const prepare = vi.spyOn(f.router, 'prepareSession');
    const publication = vi.fn(() => f.changed());
    expect(f.product.id).not.toBe(f.physicalId);
    f.setRead((index, row) => { if (index === preparedReads + 1) publication(); return { ...row }; });
    await expect(f.send()).resolves.toMatchObject({ success: true, timing: { clientTurnId: 'next-input' } });
    expect(publication).toHaveBeenCalledOnce();
    expect(f.methods.slice(preparedMethods)).toEqual([
      'sessions.describe', 'sessions.describe', // BeforePreparation: discard the retired read, then reobserve.
      'sessions.describe', 'sessions.create', // The synthetic plugin prepares once after Core admission.
    ]);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(f.product.id);
    const preparationOrder = prepare.mock.invocationCallOrder[0];
    expect(f.request.mock.invocationCallOrder[preparedMethods + 1]).toBeLessThan(preparationOrder);
    expect(f.request.mock.invocationCallOrder[preparedMethods + 2]).toBeGreaterThan(preparationOrder);
    expect(f.store.getSessionRunByClientTurnId('previous-input')?.state).toBe('completed');
    f.assertNoExecution();
  });

  it('keeps a materialized custom-agent native/history binding across the same event window', async () => {
    const f = fixture({ bound: true, customAgent: true, checkpoint: true });
    expect(f.store.getSession(f.product.id)).toMatchObject({ agentId: f.row.agentId, nativeSessionKey: f.key,
      historyBinding: { sessionKey: f.key, nativeSessionId: f.physicalId } });
    f.setRead((index, row) => { if (index === 1) f.changed(); return { ...row }; });
    await expect(f.send()).resolves.toMatchObject({ success: true });
    expect(f.methods.slice(0, 2)).toEqual(['sessions.describe', 'sessions.describe']);
    f.assertNoExecution();
  });

  it.each(['main', 'descendant'])('does not admit input when the second observation is busy: %s', async owner => {
    const f = fixture();
    f.setRead((index, row) => {
      if (index === 1) { f.changed(); return { ...row }; }
      return { ...row, ...(owner === 'main' ? { hasActiveRun: true } : { hasActiveSubagentRun: true }) };
    });
    await expect(f.send()).resolves.toMatchObject({ success: false });
    expect(f.reads()).toBe(2);
    expect(f.methods).not.toContain('sessions.create');
    expect(f.store.getSessionRunByClientTurnId('next-input')).toBeUndefined();
    f.assertNoExecution();
  });

  it('remains unknown when a second native event retires the fresh observation', async () => {
    const f = fixture();
    f.setRead((_index, row) => { f.changed(); return { ...row }; });
    await expect(f.send()).resolves.toMatchObject({ success: false });
    expect(f.reads()).toBe(2);
    expect(f.methods).toEqual(['sessions.describe', 'sessions.describe']);
    expect(f.store.getSessionRunByClientTurnId('next-input')).toBeUndefined();
    f.assertNoExecution();
  });

  it.each([undefined, null, 'new-revision'])('keeps an omitted native revision exact across reobservation: %s', async revision => {
    const f = fixture();
    f.setRead((index, row) => {
      const response = { ...row };
      if (index === 1) {
        f.changed();
        Reflect.deleteProperty(response, 'lifecycleRevision');
      } else if (revision === undefined) {
        Reflect.deleteProperty(response, 'lifecycleRevision');
      } else {
        response.lifecycleRevision = revision;
      }
      return response;
    });
    await expect(f.router.getSessionRuntimeStatus(f.product.id, { targeted: true, includeSubagents: true }))
      .resolves.toMatchObject({ known: revision === undefined, running: false });
    expect(f.reads()).toBe(2);
    expect(f.methods).toEqual(['sessions.describe', 'sessions.describe']);
    expect(f.store.getSessionRunByClientTurnId('next-input')).toBeUndefined();
    f.assertNoExecution();
  });

  it.each(['source', 'external-owner', 'connection', 'sid', 'revision', 'native-error', 'absence'])('does not repair identity/error evidence by retrying: %s', async reason => {
    const f = fixture({ bound: true });
    f.setRead((_index, row) => {
      f.changed();
      if (reason === 'source') f.native.prepare('UPDATE cowork_sessions SET cwd=? WHERE id=?').run(path.resolve('different-fixture'), f.product.id);
      if (reason === 'external-owner') {
        f.native.exec('CREATE TABLE cowork_external_sessions(source TEXT,status TEXT,openclaw_session_key TEXT,cowork_session_id TEXT)');
        f.native.prepare('INSERT INTO cowork_external_sessions VALUES(?,?,?,?)').run('cli', 'completed', f.key, f.product.id);
        expect(f.store.getSession(f.product.id)?.external).toMatchObject({ readOnly: true });
      }
      if (reason === 'connection') f.seam.gatewayClientGeneration += 1;
      if (reason === 'native-error') throw new Error('Synthetic native failure');
      if (reason === 'absence') return null;
      return { ...row, ...(reason === 'sid' ? { sessionId: 'foreign-native' } : {}) };
    });
    // The revision expectation is explicit at the actual adapter entry.
    const result = reason === 'revision'
      ? await f.router.getSessionRuntimeStatus(f.product.id, { targeted: true, expectedSessionId: f.physicalId,
        expectedLifecycleRevision: 'foreign-revision' })
      : await f.send();
    expect(result).toMatchObject(reason === 'revision' ? { known: false } : { success: false });
    expect(f.reads()).toBe(1);
    expect(f.methods).toEqual(['sessions.describe']);
    f.assertNoExecution();
  });

  it.each(['sid', 'revision'])('does not adopt a different unbound native incarnation on the second read: %s', async field => {
    const f = fixture();
    f.setRead((index, row) => {
      if (index === 1) { f.changed(); return { ...row }; }
      return { ...row, ...(field === 'sid' ? { sessionId: 'replacement-native' } : { lifecycleRevision: 'replacement-revision' }) };
    });
    await expect(f.send()).resolves.toMatchObject({ success: false });
    expect(f.reads()).toBe(2);
    expect(f.methods).not.toContain('sessions.create');
    expect(f.store.getSessionRunByClientTurnId('next-input')).toBeUndefined();
    f.assertNoExecution();
  });

  it('preserves actual adapter unknown-send custody without dispatching any read or mutation', async () => {
    const f = fixture();
    f.adapter.registerUnknownSessionRun(f.product.id, 'unconfirmed-native-run');
    await expect(f.send()).resolves.toMatchObject({ success: false });
    expect(f.methods).toEqual([]);
    expect(f.reads()).toBe(0);
    expect(f.store.getSessionRunByClientTurnId('next-input')).toBeUndefined();
    f.assertNoExecution();
  });
});
