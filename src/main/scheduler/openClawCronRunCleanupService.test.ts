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
    CREATE TABLE cron_run_logs (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      run_id TEXT,
      run_at_ms INTEGER,
      PRIMARY KEY (store_key, job_id, seq)
    );
  `);
  db.prepare(
    `INSERT INTO cron_run_logs (store_key, job_id, seq, ts, run_id, run_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(path.resolve(stateDir, 'cron', 'jobs.json'), 'task-1', 1, 1000, null, 900);
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
      sessionKey: 'agent:main:cron:task-1:run:900',
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deletes the OpenClaw session transcript and matching cron run row', async () => {
  const fixture = createFixture();
  const duplicateDb = new Database(fixture.databasePath);
  duplicateDb
    .prepare(
      `INSERT INTO cron_run_logs (store_key, job_id, seq, ts, run_id, run_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('another-cron-store', 'task-1', 1, 1000, null, 900);
  duplicateDb.close();
  const transcriptDir = path.join(fixture.stateDir, 'agents', 'main', 'sessions');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const archivedTranscript = path.join(transcriptDir, 'session-1.jsonl.deleted.20260728');
  fs.writeFileSync(archivedTranscript, 'transcript');
  const request = vi.fn(async (method: string) => {
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
  const db = new Database(fixture.databasePath, { readonly: true });
  expect(db.prepare('SELECT store_key FROM cron_run_logs').all()).toEqual([
    { store_key: 'another-cron-store' },
  ]);
  db.close();
  fixture.cleanupDatabase.close();
});

test('does not touch the cron run row when session cleanup fails', async () => {
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
  expect(db.prepare('SELECT COUNT(*) AS count FROM cron_run_logs').get()).toEqual({
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
  expect(db.prepare('SELECT COUNT(*) AS count FROM cron_run_logs').get()).toEqual({
    count: 0,
  });
  db.close();
  fixture.cleanupDatabase.close();
});

test('deletes persisted descendants discovered on later session pages before the root', async () => {
  const fixture = createFixture();
  const rootKey = fixture.result.sessionKey ?? '';
  const childKey = `${rootKey}:subagent:child`;
  const deletedKeys: string[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    const input = params as { offset?: number; key?: string };
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
    deletedKeys.push(input.key ?? '');
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

test('uses both legacy session parent fields when building the deletion tree', async () => {
  const fixture = createFixture();
  const rootKey = fixture.result.sessionKey ?? '';
  const childKey = `${rootKey}:subagent:legacy-child`;
  const deletedKeys: string[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    const input = params as { key?: string };
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
    deletedKeys.push(input.key ?? '');
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
  const request = vi.fn(async (method: string) => {
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
