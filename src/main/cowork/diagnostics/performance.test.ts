import os from 'node:os';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import type { DiagnosticEvent } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import {
  initializeSessionDiagnosticsTables,
  SessionDiagnosticsStore,
} from '../../data/sessionDiagnosticsStore';
import { SessionDiagnosticsService } from './service';

const percentile95 = (values: number[]): number =>
  [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1];

it('keeps local reports and event collection bounded at the global retention budget', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
      CREATE TABLE cowork_session_runs (id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES cowork_sessions(id) ON DELETE CASCADE,
        root_run_id TEXT, client_turn_id TEXT, started_at INTEGER, ended_at INTEGER, state TEXT);`);
    initializeSessionDiagnosticsTables(db);
    const now = Date.now();
    const insertSession = db.prepare('INSERT INTO cowork_sessions VALUES (?)');
    const insertRun = db.prepare('INSERT INTO cowork_session_runs VALUES (?, ?, ?, ?, ?, NULL, ?)');
    const insertCoverage = db.prepare(
      'INSERT INTO cowork_run_diagnostic_coverage VALUES (?, ?, 0)',
    );
    const insertEvent = db.prepare(
      'INSERT INTO cowork_run_diagnostic_events VALUES (?, ?, ?, 0, ?, ?)',
    );
    db.transaction(() => {
      for (let session = 0; session < 10; session++) {
        insertSession.run(`session-${session}`);
        for (let run = 0; run < 10; run++) {
          const runId = `run-${session}-${run}`;
          insertRun.run(
            runId,
            `session-${session}`,
            `native-${runId}`,
            `client-${runId}`,
            now + run,
            'running',
          );
          insertCoverage.run(runId, now);
          for (let sequence = 0; sequence < 200; sequence++) {
            const event: DiagnosticEvent = {
              id: `${runId}-event-${sequence}`,
              runId,
              nativeRunId: `native-${runId}`,
              epoch: 'benchmark',
              sequence,
              observedAt: now,
              kind: 'tool',
              phase: 'end',
              toolFailed: false,
            };
            insertEvent.run(event.id, runId, now, event.id, JSON.stringify(event));
          }
        }
      }
    })();
    const store = new SessionDiagnosticsStore(db);
    const hasSession = db.prepare('SELECT id FROM cowork_sessions WHERE id = ?');
    const service = new SessionDiagnosticsService({
      store,
      getRuntime: () => null,
      hasSession: id => !!hasSession.get(id),
      getNativeSessionKey: id => `agent:main:justdo:${id}`,
      now: () => now,
    });
    const measurements = 100;
    const readTimes: number[] = [];
    const appendTimes: number[] = [];
    for (let index = 0; index < 10; index++) {
      service.read({ sessionId: `session-${index}`, sessionRunId: `run-${index}-9` }, 1);
    }
    for (let index = 0; index < measurements; index++) {
      const session = index % 10;
      const run = Math.floor(index / 10);
      const runId = `run-${session}-${run}`;
      const startRead = performance.now();
      const list = service.list({ sessionId: `session-${session}` });
      const report = service.read({ sessionId: `session-${session}`, sessionRunId: runId }, 1);
      readTimes.push(performance.now() - startRead);
      expect(list.runs).toHaveLength(10);
      expect(report.run?.id).toBe(runId);
      expect(report.events.every(event => event.runId === runId)).toBe(true);
      const startAppend = performance.now();
      store.append(`session-${session}`, {
        id: `new-${index}`,
        runId,
        nativeRunId: `native-${runId}`,
        epoch: 'benchmark',
        sequence: 200,
        observedAt: now + 1,
        kind: 'tool',
        phase: 'end',
        toolFailed: false,
      });
      appendTimes.push(performance.now() - startAppend);
    }
    const readP95 = percentile95(readTimes);
    const appendP95 = percentile95(appendTimes);
    console.info(
      '[DiagnosticsPerformance]',
      JSON.stringify({
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model,
        node: process.version,
        sqlite: db.prepare('SELECT sqlite_version() AS version').get(),
        nativeRuntime: 'not_involved',
        storage: 'in-memory SQLite',
        sessions: 10,
        productRuns: 100,
        retainedEvents: 20000,
        measurements,
        readIncludesListAndReport: true,
        localReadP95Ms: Number(readP95.toFixed(3)),
        appendP95Ms: Number(appendP95.toFixed(3)),
      }),
    );
    expect(db.prepare('SELECT count(*) AS count FROM cowork_run_diagnostic_events').get()).toEqual({
      count: 20000,
    });
    expect(
      readP95,
      'Local list + report p95 must remain within the published 200 ms budget',
    ).toBeLessThanOrEqual(200);
    expect(
      appendP95,
      'Metadata append p95 must remain within the published 5 ms budget',
    ).toBeLessThanOrEqual(5);
  } finally {
    db.close();
  }
}, 20000);
