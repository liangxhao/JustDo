import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiagnosticEvent } from '../../shared/cowork/sessionDiagnostics';
import {
  initializeSessionDiagnosticsTables,
  SessionDiagnosticsStore,
} from './sessionDiagnosticsStore';

describe('SessionDiagnosticsStore', () => {
  let db: Database.Database;
  let store: SessionDiagnosticsStore;
  const now = Date.now();
  const event = (values: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
    id: 'e',
    runId: 'r',
    nativeRunId: 'native',
    epoch: 'epoch',
    observedAt: now,
    kind: 'lifecycle',
    phase: 'start',
    ...values,
  });
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_session_runs (id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES cowork_sessions(id) ON DELETE CASCADE,
        root_run_id TEXT, client_turn_id TEXT, started_at INTEGER, ended_at INTEGER, state TEXT);
      INSERT INTO cowork_sessions VALUES ('s'), ('other');
      INSERT INTO cowork_session_runs VALUES ('r', 's', 'native', 'client', 100, NULL, 'running');
      INSERT INTO cowork_session_runs VALUES ('copy', 'other', 'native', 'copy-client', 100, 101, 'completed');`);
    initializeSessionDiagnosticsTables(db);
    store = new SessionDiagnosticsStore(db);
  });
  afterEach(() => db.close());

  it('initializes idempotently and isolates copied root ids by owning session', () => {
    initializeSessionDiagnosticsTables(db);
    expect(store.resolveRun('s', 'native')).toBe('r');
    expect(store.resolveRun('other', 'native')).toBe('copy');
    store.append('other', event());
    expect(store.read('s', 'r').events).toHaveLength(0);
    store.append('s', event());
    expect(store.read('other', 'r').events).toHaveLength(0);
    expect(store.getRun('other', 'r')).toBeUndefined();
  });

  it('deduplicates native sequence replays while separating connection epochs', () => {
    store.append('s', event({ sequence: 1 }));
    store.append('s', event({ id: 'replay', sequence: 1, observedAt: now + 1 }));
    store.append('s', event({ id: 'reconnect', sequence: 1, epoch: 'second' }));
    expect(store.read('s', 'r').events).toHaveLength(2);
  });

  it('reserves terminal capacity and persists dropped coverage after all events expire', () => {
    for (let index = 0; index < 205; index++)
      store.append('s', event({ id: `e-${index}`, sequence: index }));
    store.append(
      's',
      event({ id: 'terminal', executionSettled: true, phase: 'end', stopReason: 'end_turn' }),
    );
    expect(store.read('s', 'r').events).toHaveLength(201);
    expect(store.read('s', 'r').coverage.dropped).toBe(5);
    store.prune(now + 15 * 24 * 60 * 60 * 1000);
    store = new SessionDiagnosticsStore(db);
    expect(store.read('s', 'r').events).toHaveLength(0);
    expect(store.read('s', 'r').coverage).toMatchObject({ dropped: 206, firstObservedAt: now });
  });

  it('cascades both evidence and retained coverage on session deletion', () => {
    store.append('s', event());
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('s');
    expect(db.prepare('SELECT * FROM cowork_run_diagnostic_events').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM cowork_run_diagnostic_coverage').all()).toHaveLength(0);
  });

  it('caps terminal retention separately and makes oversized metadata loss visible', () => {
    for (let index = 0; index < 35; index++)
      store.append(
        's',
        event({
          id: `terminal-${index}`,
          sequence: index,
          executionSettled: true,
          phase: 'end',
        }),
      );
    store.append('s', event({ id: 'oversize', epoch: 'x'.repeat(3000) }));
    expect(store.read('s', 'r').events).toHaveLength(32);
    expect(store.read('s', 'r').coverage.dropped).toBe(4);
  });

  it('prunes global capacity and preserves per-run loss accounting', () => {
    db.prepare(`INSERT INTO cowork_run_diagnostic_coverage VALUES ('r', ?, 0)`).run(now);
    const insert = db.prepare(
      `INSERT INTO cowork_run_diagnostic_events VALUES (?, 'r', ?, 0, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 20_010; index++) {
        insert.run(
          `global-${index}`,
          now,
          `dedupe-${index}`,
          JSON.stringify(event({ id: `global-${index}` })),
        );
      }
    })();
    store.prune(now);
    expect(db.prepare('SELECT count(*) AS count FROM cowork_run_diagnostic_events').get()).toEqual({
      count: 20_000,
    });
    expect(store.read('s', 'r').coverage.dropped).toBe(10);
  });

  it('preserves receipt order when events have the same millisecond timestamp', () => {
    store.append('s', event({ id: 'z-first', sequence: 1, phase: 'start' }));
    store.append('s', event({ id: 'a-last', sequence: 2, phase: 'end' }));
    expect(store.read('s', 'r').events.map(item => item.id)).toEqual(['z-first', 'a-last']);
  });

  it('uses stable bounded pagination and rejects foreign cursors', () => {
    const insert = db.prepare(
      `INSERT INTO cowork_session_runs VALUES (?, 's', ?, ?, ?, NULL, 'running')`,
    );
    for (let index = 0; index < 25; index++)
      insert.run(`r-${index}`, `native-${index}`, `client-${index}`, 200);
    const first = store.listRuns('s');
    const second = store.listRuns('s', first.nextCursor);
    expect(first.runs).toHaveLength(20);
    expect(second.runs).toHaveLength(6);
    expect(new Set([...first.runs, ...second.runs].map(run => run.id)).size).toBe(26);
    expect(() => store.listRuns('s', 'copy')).toThrow();
  });
});
