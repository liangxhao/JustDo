import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { ExternalSessionSource } from '../../../shared/integrations/externalSession';
import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import { ExternalSessionStore } from './externalSessionStore';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'external-session-store-'));
  const sqlite = SqliteStore.create(cwd);
  cleanup.push(() => {
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const cowork = new CoworkStore(sqlite.getDatabase());
  const external = new ExternalSessionStore(sqlite.getDatabase());
  const historical = new ExternalSessionStore(
    sqlite.getDatabase(),
    ExternalSessionSource.HistoricalAppServer,
  );
  const create = (store: ExternalSessionStore, id: string) => {
    const session = cowork.createSession('External task', cwd);
    store.create({
      externalSessionKey: id,
      coworkSessionId: session.id,
      agentId: 'main',
      openclawSessionKey: '',
      cwd,
    });
    store.setStatus(id, 'completed');
    return session;
  };
  return { cwd, sqlite, cowork, external, historical, create };
}

it('isolates the historical namespace while projecting both as read-only conversations', () => {
  const f = fixture();
  const cli = f.create(f.external, 'same-id');
  const historical = f.create(f.historical, 'same-id');
  expect(f.external.source).toBe(ExternalSessionSource.Cli);
  expect(f.external.get('same-id')?.coworkSessionId).toBe(cli.id);
  expect(f.historical.get('same-id')?.coworkSessionId).toBe(historical.id);
  expect(f.cowork.getSession(cli.id)?.external).toMatchObject({ origin: 'cli', readOnly: true });
  expect(f.cowork.getSession(historical.id)?.external).toMatchObject({
    origin: 'multica',
    readOnly: true,
  });
  expect(
    f.cowork
      .listSessions()
      .map(session => session.external?.origin)
      .sort(),
  ).toEqual(['cli', 'multica']);
  f.cowork.deleteSession(cli.id);
  expect(f.external.wasDeleted('same-id')).toBe(true);
  expect(f.historical.wasDeleted('same-id')).toBe(false);
  expect(f.external.get('same-id')).toBeNull();
  expect(f.historical.get('same-id')).not.toBeNull();
});

it('persists exact execution identity and keeps unknown work blocked across store instances', () => {
  const f = fixture();
  f.create(f.external, 'task');
  f.external.beginExecution('task', 'first-run');
  f.external.bindExecution('task', 'first-run', {
    sessionKey: 'native-key',
    sessionId: 'native-id',
    lifecycleRevision: 'revision-1',
  });
  f.external.markExecutionUnknown('task', 'first-run');
  const reopened = new ExternalSessionStore(f.sqlite.getDatabase());
  expect(reopened.get('task')).toMatchObject({
    status: 'running',
    executionState: 'unknown',
    executionRunId: 'first-run',
    nativeSessionId: 'native-id',
    lifecycleRevision: 'revision-1',
    openclawSessionKey: 'native-key',
  });
  expect(() => reopened.beginExecution('task', 'second-run')).toThrow('unconfirmed');
  expect(() => reopened.finishExecution('task', 'foreign-run', 'completed')).toThrow('ownership');
  expect(reopened.get('task')?.executionState).toBe('unknown');
  reopened.finishExecution('task', 'first-run', 'completed');
  reopened.beginExecution('task', 'second-run');
  expect(reopened.get('task')).toMatchObject({
    executionState: 'preparing',
    executionRunId: 'second-run',
  });
});

it.each([ExternalSessionSource.Cli, ExternalSessionSource.HistoricalAppServer])(
  'does not infer cancellation for unresolved %s work during startup',
  source => {
    const f = fixture();
    const owningStore = new ExternalSessionStore(f.sqlite.getDatabase(), source);
    const cli = f.create(owningStore, 'cli');
    const ordinary = f.cowork.createSession('Ordinary task', f.cwd);
    const cliTiming = f.cowork.beginSessionRun({
      sessionId: cli.id,
      clientTurnId: 'cli-run',
      startedAt: 1,
    });
    const ordinaryTiming = f.cowork.beginSessionRun({
      sessionId: ordinary.id,
      clientTurnId: 'ordinary-run',
      startedAt: 1,
    });
    owningStore.beginExecution('cli', 'cli-run');
    owningStore.markExecutionUnknown('cli', 'cli-run');
    f.cowork.updateSession(cli.id, { status: 'running' });
    f.cowork.updateSession(ordinary.id, { status: 'running' });
    expect(f.cowork.interruptOpenSessionRuns(100)).toBe(1);
    expect(f.cowork.resetRunningSessions()).toBe(1);
    expect(f.cowork.getSessionRun(cliTiming.id)).toMatchObject({ state: 'running', startedAt: 1 });
    expect(f.cowork.getSessionRun(cliTiming.id)?.endedAt).toBeUndefined();
    expect(f.cowork.getSession(cli.id)?.status).toBe('running');
    expect(f.cowork.getSessionRun(ordinaryTiming.id)).toMatchObject({
      state: 'aborted',
      endedAt: 100,
    });
    expect(f.cowork.getSession(ordinary.id)?.status).toBe('idle');
  },
);
