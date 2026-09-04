import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';

import type { ScheduledTaskResult } from '../../shared/scheduledTask/types';
import { OpenClawCronRunCleanupService } from './openClawCronRunCleanupService';

const temporaryDirectories: string[] = [];

function createFixture(): {
  stateDir: string;
  databasePath: string;
  cleanupDatabase: Database.Database;
  result: ScheduledTaskResult;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cron-cleanup-'));
  temporaryDirectories.push(stateDir);
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const cleanupDatabase = new Database(path.join(stateDir, 'justdo.sqlite'));
  cleanupDatabase.exec(`
    CREATE TABLE scheduled_task_result_cleanup (
      run_id TEXT PRIMARY KEY,
      archived_paths_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
  `);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.exec(`
    CREATE TABLE task_runs (
      task_id TEXT PRIMARY KEY,
      runtime TEXT NOT NULL,
      source_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      detail_json TEXT
    );
    CREATE TABLE task_delivery_state (
      task_id TEXT PRIMARY KEY
    );
    CREATE TABLE execution_owner_lifecycle_bindings (
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO task_runs
       (task_id, runtime, source_id, run_id, status, started_at, ended_at, detail_json)
     VALUES (?, 'cron', ?, ?, 'succeeded', ?, ?, ?)`,
  ).run(
    'ledger-run-1',
    'task-1',
    'cron:task-1:900:internal',
    900,
    1000,
    JSON.stringify({
      kind: 'cron-run',
      storeKey: path.resolve(stateDir, 'cron', 'jobs.json'),
      runId: 'task-1:900',
      runAtMs: 900,
    }),
  );
  db.prepare('INSERT INTO task_delivery_state (task_id) VALUES (?)').run('ledger-run-1');
  db.prepare(
    "INSERT INTO execution_owner_lifecycle_bindings (owner_kind, owner_id) VALUES ('task', ?)",
  ).run('ledger-run-1');
  db.close();
  return {
    stateDir,
    databasePath,
    cleanupDatabase,
    result: {
      id: 'task-1:900',
      taskId: 'task-1',
      taskName: 'Task',
      sessionId: 'session-1',
      sessionKey: 'agent:main:cron:task-1:run:session-1',
      status: 'success',
      summary: 'done',
      startedAt: new Date(900).toISOString(),
      finishedAt: new Date(1000).toISOString(),
      durationMs: 100,
      error: null,
      deliveryStatus: 'not-requested',
      deliveryError: null,
      observedAt: new Date(1000).toISOString(),
      readAt: null,
    },
  };
}

function insertTaskRun(
  fixture: ReturnType<typeof createFixture>,
  input: {
    taskId: string;
    sourceId?: string;
    runId?: string | null;
    startedAt?: number;
    detail: Record<string, unknown>;
  },
): void {
  const db = new Database(fixture.databasePath);
  db.prepare(
    `INSERT INTO task_runs
       (task_id, runtime, source_id, run_id, status, started_at, ended_at, detail_json)
     VALUES (?, 'cron', ?, ?, 'succeeded', ?, 1000, ?)`,
  ).run(
    input.taskId,
    input.sourceId ?? fixture.result.taskId,
    input.runId ?? null,
    input.startedAt ?? 900,
    JSON.stringify(input.detail),
  );
  db.close();
}

function updateTaskRunDetail(
  fixture: ReturnType<typeof createFixture>,
  taskId: string,
  detail: Record<string, unknown>,
): void {
  const db = new Database(fixture.databasePath);
  db.prepare('UPDATE task_runs SET detail_json = ? WHERE task_id = ?').run(
    JSON.stringify(detail),
    taskId,
  );
  db.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deletes the OpenClaw session transcript and matching v2026.8.2 task-ledger row', async () => {
  const fixture = createFixture();
  const duplicateDb = new Database(fixture.databasePath);
  duplicateDb
    .prepare(
      `INSERT INTO task_runs
         (task_id, runtime, source_id, run_id, status, started_at, ended_at, detail_json)
       VALUES (?, 'cron', ?, ?, 'succeeded', ?, ?, ?)`,
    )
    .run(
      'unrelated-ledger-run',
      'another-task',
      'cron:another-task:900:internal',
      900,
      1000,
      JSON.stringify({ kind: 'cron-run', runAtMs: 900 }),
    );
  duplicateDb.close();
  const transcriptDir = path.join(fixture.stateDir, 'agents', 'main', 'sessions');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const archivedTranscript = path.join(transcriptDir, 'session-1.jsonl.deleted.20260728');
  fs.writeFileSync(archivedTranscript, 'transcript');
  const request = vi.fn(async (method: string, params?: unknown) => {
    const input = params as { key?: string };
    if (method === 'sessions.describe') {
      return {
        session: {
          key: input.key,
          sessionId: 'session-1',
          lifecycleRevision: 'revision-1',
          updatedAt: 123,
        },
      };
    }
    if (method === 'sessions.list') return { sessions: [] };
    return { archived: [archivedTranscript] };
  });
  const clearSessionApprovalGrants = vi.fn();
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
    clearSessionApprovalGrants,
  });

  await service.deleteResultArtifacts(fixture.result);

  expect(fs.existsSync(archivedTranscript)).toBe(false);
  expect(clearSessionApprovalGrants).toHaveBeenCalledWith(fixture.result.sessionKey);
  expect(request).toHaveBeenCalledWith('sessions.delete', {
    key: fixture.result.sessionKey,
    deleteTranscript: true,
    expectedSessionId: 'session-1',
    expectedLifecycleRevision: 'revision-1',
    expectedSessionUpdatedAt: 123,
  });
  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT task_id FROM task_runs').all()).toEqual([
    { task_id: 'unrelated-ledger-run' },
  ]);
  expect(db.prepare('SELECT task_id FROM task_delivery_state').all()).toEqual([]);
  expect(db.prepare('SELECT owner_id FROM execution_owner_lifecycle_bindings').all()).toEqual([]);
  db.close();
  fixture.cleanupDatabase.close();
});

test('does not touch the cron task-ledger row when session cleanup fails', async () => {
  const fixture = createFixture();
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () =>
      ({
        request: vi.fn().mockRejectedValue(new Error('gateway failed')),
      }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await expect(service.deleteResultArtifacts(fixture.result)).rejects.toThrow('gateway failed');

  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({
    count: 1,
  });
  db.close();
  fixture.cleanupDatabase.close();
});

test('does not delete a shared non-cron session', async () => {
  const fixture = createFixture();
  const request = vi.fn();
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({
    ...fixture.result,
    sessionKey: 'agent:main:main',
  });

  expect(request).not.toHaveBeenCalled();
  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({
    count: 0,
  });
  db.close();
  fixture.cleanupDatabase.close();
});

test.each([
  ['legacy cron key', 'agent:main:cron:task-1'],
  ['static cron run key', 'agent:main:cron:task-1:run:900'],
  ['different task key', 'agent:main:cron:task-2:run:session-1'],
])('never asks the gateway to delete a transcript for a %s', async (_label, sessionKey) => {
  const fixture = createFixture();
  const request = vi.fn();
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({ ...fixture.result, sessionKey });

  expect(request).not.toHaveBeenCalled();
  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({ count: 0 });
  db.close();
  fixture.cleanupDatabase.close();
});

test('does not delete a replacement session after the run-owned key is reused', async () => {
  const fixture = createFixture();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          key: (params as { key?: string }).key,
          sessionId: 'replacement-session',
          lifecycleRevision: 'replacement-revision',
          updatedAt: 200,
        },
      };
    }
    throw new Error(`Unexpected gateway call: ${method}`);
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts(fixture.result);

  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('sessions.describe', {
    key: fixture.result.sessionKey,
  });
  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({ count: 0 });
  db.close();
  fixture.cleanupDatabase.close();
});

test('deletes history when optional lifecycle binding storage has not been initialized', async () => {
  const fixture = createFixture();
  const db = new Database(fixture.databasePath);
  db.exec('DROP TABLE execution_owner_lifecycle_bindings');
  db.close();
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => null,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({ ...fixture.result, sessionKey: null });

  const readonlyDb = new Database(fixture.databasePath, { readonly: true });
  expect(readonlyDb.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({
    count: 0,
  });
  readonlyDb.close();
  fixture.cleanupDatabase.close();
});

test('deletes only the task-ledger row with matching kind, store, and public run id', async () => {
  const fixture = createFixture();
  const storeKey = path.resolve(fixture.stateDir, 'cron', 'jobs.json');
  insertTaskRun(fixture, {
    taskId: 'legacy-collision',
    runId: 'internal-legacy',
    detail: { kind: 'cron-run', storeKey, runAtMs: 900 },
  });
  insertTaskRun(fixture, {
    taskId: 'other-store-collision',
    runId: 'internal-other-store',
    detail: {
      kind: 'cron-run',
      storeKey: path.resolve(fixture.stateDir, 'other', 'jobs.json'),
      runId: fixture.result.id,
      runAtMs: 900,
    },
  });
  insertTaskRun(fixture, {
    taskId: 'other-public-run',
    runId: 'internal-other-public',
    detail: { kind: 'cron-run', storeKey, runId: 'task-1:other', runAtMs: 900 },
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => null,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({ ...fixture.result, sessionKey: null });

  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT task_id FROM task_runs ORDER BY task_id').all()).toEqual([
    { task_id: 'legacy-collision' },
    { task_id: 'other-public-run' },
    { task_id: 'other-store-collision' },
  ]);
  db.close();
  fixture.cleanupDatabase.close();
});

test('uses a unique same-store legacy row only when the public run id is absent', async () => {
  const fixture = createFixture();
  updateTaskRunDetail(fixture, 'ledger-run-1', {
    kind: 'cron-run',
    storeKey: path.resolve(fixture.stateDir, 'cron', 'jobs.json'),
    runAtMs: 900,
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => null,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({ ...fixture.result, sessionKey: null });

  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT COUNT(*) AS count FROM task_runs').get()).toEqual({ count: 0 });
  db.close();
  fixture.cleanupDatabase.close();
});

test('refuses an ambiguous legacy task-ledger fallback', async () => {
  const fixture = createFixture();
  const storeKey = path.resolve(fixture.stateDir, 'cron', 'jobs.json');
  updateTaskRunDetail(fixture, 'ledger-run-1', {
    kind: 'cron-run',
    storeKey,
    runAtMs: 900,
  });
  insertTaskRun(fixture, {
    taskId: 'second-legacy-run',
    runId: 'internal-second',
    detail: { kind: 'cron-run', storeKey, runAtMs: 900 },
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => null,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await expect(
    service.deleteResultArtifacts({ ...fixture.result, sessionKey: null }),
  ).rejects.toThrow('OpenClaw cron task history is ambiguous');

  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT task_id FROM task_runs ORDER BY task_id').all()).toEqual([
    { task_id: 'ledger-run-1' },
    { task_id: 'second-legacy-run' },
  ]);
  expect(db.prepare('SELECT task_id FROM task_delivery_state').all()).toEqual([
    { task_id: 'ledger-run-1' },
  ]);
  db.close();
  fixture.cleanupDatabase.close();
});

test('does not use a legacy fallback from a different cron store', async () => {
  const fixture = createFixture();
  updateTaskRunDetail(fixture, 'ledger-run-1', {
    kind: 'cron-run',
    storeKey: path.resolve(fixture.stateDir, 'other', 'jobs.json'),
    runAtMs: 900,
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => null,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts({ ...fixture.result, sessionKey: null });

  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT task_id FROM task_runs').all()).toEqual([{ task_id: 'ledger-run-1' }]);
  expect(db.prepare('SELECT task_id FROM task_delivery_state').all()).toEqual([
    { task_id: 'ledger-run-1' },
  ]);
  db.close();
  fixture.cleanupDatabase.close();
});

test.each([null, '', 123])(
  'does not treat a malformed detail runId (%j) as a missing legacy identity',
  async runId => {
    const fixture = createFixture();
    updateTaskRunDetail(fixture, 'ledger-run-1', {
      kind: 'cron-run',
      storeKey: path.resolve(fixture.stateDir, 'cron', 'jobs.json'),
      runId,
      runAtMs: 900,
    });
    const service = new OpenClawCronRunCleanupService({
      getGatewayClient: () => null,
      ensureGatewayReady: vi.fn(),
      getStateDir: () => fixture.stateDir,
      getDatabase: () => fixture.cleanupDatabase,
    });

    await service.deleteResultArtifacts({ ...fixture.result, sessionKey: null });

    const db = new Database(fixture.databasePath, { readonly: true });
    expect(db.prepare('SELECT task_id FROM task_runs').all()).toEqual([
      { task_id: 'ledger-run-1' },
    ]);
    db.close();
    fixture.cleanupDatabase.close();
  },
);

test('deletes persisted descendants discovered on later session pages before the root', async () => {
  const fixture = createFixture();
  const rootKey = fixture.result.sessionKey ?? '';
  const childKey = `${rootKey}:subagent:child`;
  const deletedKeys: string[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    const input = params as { offset?: number; key?: string };
    if (method === 'sessions.describe') {
      const isRoot = input.key === rootKey;
      return {
        session: {
          key: input.key,
          sessionId: isRoot ? 'session-1' : 'child-session',
          lifecycleRevision: isRoot ? 'root-revision' : 'child-revision',
          updatedAt: isRoot ? 100 : 200,
        },
      };
    }
    if (method === 'sessions.list') {
      if ((input.offset ?? 0) === 0) {
        return {
          sessions: Array.from({ length: 500 }, (_, index) => ({
            key: `unrelated-${index}`,
          })),
          hasMore: true,
          nextOffset: 500,
        };
      }
      return {
        sessions: [{ key: childKey, parentSessionKey: rootKey }],
        hasMore: false,
        nextOffset: null,
      };
    }
    if (method === 'sessions.delete') deletedKeys.push(input.key ?? '');
    return { archived: [] };
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts(fixture.result);

  expect(deletedKeys).toEqual([childKey, rootKey]);
  expect(request).toHaveBeenCalledWith('sessions.delete', {
    key: childKey,
    deleteTranscript: true,
    expectedSessionId: 'child-session',
    expectedLifecycleRevision: 'child-revision',
    expectedSessionUpdatedAt: 200,
  });
  fixture.cleanupDatabase.close();
});

test('uses both legacy session parent fields when building the deletion tree', async () => {
  const fixture = createFixture();
  const rootKey = fixture.result.sessionKey ?? '';
  const childKey = `${rootKey}:subagent:legacy-child`;
  const deletedKeys: string[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    const input = params as { key?: string };
    if (method === 'sessions.describe') {
      return {
        session: {
          key: input.key,
          sessionId: input.key === rootKey ? 'session-1' : 'legacy-child-session',
          updatedAt: 100,
        },
      };
    }
    if (method === 'sessions.list') {
      return {
        sessions: [
          {
            key: childKey,
            spawnedBy: 'agent:main:stale-parent',
            parentSessionKey: rootKey,
          },
        ],
      };
    }
    if (method === 'sessions.delete') deletedKeys.push(input.key ?? '');
    return { archived: [] };
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await service.deleteResultArtifacts(fixture.result);

  expect(deletedKeys).toEqual([childKey, rootKey]);
  fixture.cleanupDatabase.close();
});

test('retries a transcript deletion recorded before a partial cleanup failure', async () => {
  const fixture = createFixture();
  const transcriptDir = path.join(fixture.stateDir, 'agents', 'main', 'sessions');
  const archivedTranscript = path.join(transcriptDir, 'session-1.jsonl.deleted.retry');
  fs.mkdirSync(archivedTranscript, { recursive: true });
  let firstDelete = true;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.describe') {
      return {
        session: {
          key: (params as { key?: string }).key,
          sessionId: 'session-1',
          updatedAt: 100,
        },
      };
    }
    if (method === 'sessions.list') return { sessions: [] };
    if (firstDelete) {
      firstDelete = false;
      return { archived: [archivedTranscript] };
    }
    return { archived: [] };
  });
  const service = new OpenClawCronRunCleanupService({
    getGatewayClient: () => ({ request }) as never,
    ensureGatewayReady: vi.fn(),
    getStateDir: () => fixture.stateDir,
    getDatabase: () => fixture.cleanupDatabase,
  });

  await expect(service.deleteResultArtifacts(fixture.result)).rejects.toThrow();
  expect(
    fixture.cleanupDatabase
      .prepare('SELECT run_id FROM scheduled_task_result_cleanup WHERE run_id = ?')
      .get(fixture.result.id),
  ).toEqual({ run_id: fixture.result.id });

  fs.rmSync(archivedTranscript, { recursive: true, force: true });
  fs.writeFileSync(archivedTranscript, 'transcript');
  await service.deleteResultArtifacts(fixture.result);

  expect(fs.existsSync(archivedTranscript)).toBe(false);
  expect(
    fixture.cleanupDatabase
      .prepare('SELECT run_id FROM scheduled_task_result_cleanup WHERE run_id = ?')
      .get(fixture.result.id),
  ).toBeUndefined();
  fixture.cleanupDatabase.close();
});
