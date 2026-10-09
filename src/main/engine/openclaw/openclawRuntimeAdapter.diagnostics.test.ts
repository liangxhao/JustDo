import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../cowork/coworkLogger', () => ({ coworkLog: vi.fn() }));

import { createDefaultAgentRuntimeSettings } from '../../../shared/agents/agentRuntimeSettings';
import { SessionDiagnosticsService } from '../../cowork/diagnostics/service';
import type { CoworkStore } from '../../data/coworkStore';
import {
  initializeSessionDiagnosticsTables,
  SessionDiagnosticsStore,
} from '../../data/sessionDiagnosticsStore';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import type { GatewayEventFrame, SessionTurn } from '../gateway/types';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';
import { LIFECYCLE_END_FALLBACK_MS } from './runtimeAdapterSupport';

let db: Database.Database;
let adapter: OpenClawRuntimeAdapter;
let service: SessionDiagnosticsService;
let diagnostics: SessionDiagnosticsStore;
let runtime: {
  ensureActiveTurn(sessionId: string, sessionKey: string, runId: string): void;
  handleGatewayEvent(event: GatewayEventFrame): void;
  activeTurns: Map<string, SessionTurn>;
};
const key = (sessionId: string) => `agent:main:justdo:${sessionId}`;

beforeEach(() => {
  vi.useFakeTimers();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE cowork_session_runs (
      id TEXT PRIMARY KEY, session_id TEXT REFERENCES cowork_sessions(id) ON DELETE CASCADE,
      root_run_id TEXT, client_turn_id TEXT, started_at INTEGER, ended_at INTEGER, state TEXT
    );
    INSERT INTO cowork_sessions VALUES ('one'), ('two'), ('copy');
    INSERT INTO cowork_session_runs VALUES ('run-one', 'one', NULL, 'client-one', 100, NULL, 'running');
    INSERT INTO cowork_session_runs VALUES ('run-two', 'two', 'native-two', 'client-two', 100, NULL, 'running');
    INSERT INTO cowork_session_runs VALUES ('run-copy', 'copy', NULL, 'client-copy', 100, 200, 'completed');
  `);
  initializeSessionDiagnosticsTables(db);
  diagnostics = new SessionDiagnosticsStore(db);
  const store = {
    getSession: (id: string) =>
      db.prepare('SELECT id FROM cowork_sessions WHERE id = ?').get(id)
        ? { id, agentId: 'main', status: 'running' }
        : null,
    getAgentRuntimeSettings: () => createDefaultAgentRuntimeSettings(),
    getConfig: () => ({ maxGoalContinuationTurns: 1 }),
    getGoalExecutionSnapshot: () => null,
    updateSession: vi.fn(),
  } as unknown as CoworkStore;
  adapter = new OpenClawRuntimeAdapter(store, {} as OpenClawEngineManager);
  runtime = adapter as unknown as typeof runtime;
  service = new SessionDiagnosticsService({
    store: diagnostics,
    hasSession: id => !!store.getSession(id),
    getNativeSessionKey: id => `agent:main:justdo:${id}`,
    getRuntime: () => adapter,
  });
  adapter.on('gatewayEvent', event => service.observe(event));
  adapter.on('error', vi.fn());
});

afterEach(() => {
  // Neither the service retry timer nor turn watchdog may survive a closed DB.
  adapter.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
  db.close();
});

test('late keyed settled lifecycle enriches chat final after actual turn cleanup and isolates another session and copy', () => {
  runtime.ensureActiveTurn('one', key('one'), 'client-one');
  runtime.ensureActiveTurn('two', key('two'), 'native-two');
  runtime.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'client-one',
      sessionKey: key('one'),
      state: 'final',
      seq: 1,
    },
  });
  expect(runtime.activeTurns.has('one')).toBe(false);
  expect(runtime.activeTurns.has('two')).toBe(true);
  expect(service.read({ sessionId: 'one' }, 1).conclusion.reason).toBe('reply_ended');

  runtime.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'client-one',
      sessionKey: key('one'),
      stream: 'lifecycle',
      seq: 2,
      data: { phase: 'end', executionSettled: true, stopReason: 'end_turn' },
    },
  });
  const report = service.read({ sessionId: 'one' }, 1);
  expect(report.conclusion.reason).toBe('completed');
  expect(report.events.map(event => event.kind)).toEqual(
    expect.arrayContaining(['chat', 'lifecycle']),
  );
  expect(runtime.activeTurns.has('one')).toBe(false);
  expect(diagnostics.read('two', 'run-two').events).toEqual([]);
  expect(diagnostics.read('copy', 'run-copy').events).toEqual([]);

  runtime.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId: 'native-two',
      sessionKey: key('two'),
      state: 'final',
      seq: 1,
    },
  });
  expect(service.read({ sessionId: 'two' }, 1).conclusion.reason).toBe('reply_ended');
  expect(service.read({ sessionId: 'one' }, 1).conclusion.reason).toBe('completed');
});

test('captures no-key identity before actual cleanup and flushes only after exact root binding', () => {
  runtime.ensureActiveTurn('one', key('one'), 'native-one');
  runtime.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'native-one',
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true, stopReason: 'end_turn' },
      seq: 1,
    },
  });
  // Native agent lifecycle accepts run identity without a session key; its
  // normal fallback retires the turn when no chat final arrives.
  vi.advanceTimersByTime(LIFECYCLE_END_FALLBACK_MS);
  expect(runtime.activeTurns.has('one')).toBe(false);
  expect(adapter.resolveDiagnosticSession('native-one')).toBeNull();
  expect(diagnostics.read('one', 'run-one').events).toEqual([]);

  // The execution owner can bind the ACK after a terminal event has arrived.
  db.prepare('UPDATE cowork_session_runs SET root_run_id = ? WHERE id = ?').run(
    'native-one',
    'run-one',
  );
  service.flush();
  const report = service.read({ sessionId: 'one' }, 1);
  expect(report.conclusion.reason).toBe('completed');
  expect(report.events).toHaveLength(1);
  expect(report.events[0]).toMatchObject({ runId: 'run-one', nativeRunId: 'native-one' });
  expect(diagnostics.read('two', 'run-two').events).toEqual([]);
  expect(diagnostics.read('copy', 'run-copy').events).toEqual([]);
});
