import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ScheduledTaskResult } from '../../shared/scheduledTask/types';
import {
  type GatewayRequestClient,
  listPersistedGatewaySessions,
} from '../engine/openclaw/subagentGateway';

interface SessionDeleteResult {
  archived?: string[];
}

interface SessionDescribeResult {
  session?: Record<string, unknown> | null;
}

export interface OpenClawCronRunCleanupDeps {
  getGatewayClient: () => GatewayRequestClient | null;
  ensureGatewayReady: () => Promise<void>;
  getStateDir: () => string;
  getDatabase: () => Database.Database;
  clearSessionApprovalGrants?: (sessionKey: string) => void;
}

interface CronTaskRunRow {
  task_id: string;
  run_id: string | null;
  started_at: number | null;
  detail_json: string | null;
}

interface CronTaskRunDetail {
  kind?: unknown;
  storeKey?: unknown;
  runId?: unknown;
}

const MAX_SESSION_TREE_SIZE = 1000;

export class OpenClawCronRunCleanupService {
  constructor(private readonly deps: OpenClawCronRunCleanupDeps) {}

  async deleteResultArtifacts(result: ScheduledTaskResult): Promise<void> {
    this.deletePendingArchivedTranscripts(result.id);
    const runSession = this.getCronRunSessionIdentity(result);
    if (runSession) {
      const client = await this.client();
      await this.deletePersistedSessionTree(
        client,
        result.id,
        runSession.sessionKey,
        runSession.sessionId,
      );
    }
    this.deleteCronTaskRunHistory(result);
    this.clearPendingArchivedTranscripts(result.id);
  }

  private getCronRunSessionIdentity(
    result: ScheduledTaskResult,
  ): { sessionKey: string; sessionId: string } | null {
    const sessionKey = result.sessionKey?.trim();
    const sessionId = result.sessionId?.trim();
    const taskId = result.taskId.trim();
    if (!sessionKey || !sessionId || !taskId || sessionId.includes(':') || taskId.includes(':')) {
      return null;
    }

    const expectedSuffix = `:cron:${taskId}:run:${sessionId}`;
    if (!sessionKey.endsWith(expectedSuffix)) return null;
    const agentPrefix = sessionKey.slice(0, -expectedSuffix.length);
    if (!/^agent:[^:]+$/u.test(agentPrefix)) return null;
    return { sessionKey, sessionId };
  }

  private async client(): Promise<GatewayRequestClient> {
    let client = this.deps.getGatewayClient();
    if (!client) {
      await this.deps.ensureGatewayReady();
      client = this.deps.getGatewayClient();
    }
    if (!client) throw new Error('OpenClaw gateway is unavailable');
    return client;
  }

  private async deletePersistedSessionTree(
    client: GatewayRequestClient,
    runId: string,
    rootSessionKey: string,
    rootSessionId: string,
  ): Promise<void> {
    const root = await this.describeSession(client, rootSessionKey);
    if (!root || root.sessionId !== rootSessionId) return;

    const childrenByParent = new Map<string, Set<string>>();
    for (const row of await listPersistedGatewaySessions(client)) {
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key) continue;
      for (const parentValue of [row.spawnedBy, row.parentSessionKey]) {
        const parent = typeof parentValue === 'string' ? parentValue.trim() : '';
        if (!parent) continue;
        const children = childrenByParent.get(parent);
        if (children) children.add(key);
        else childrenByParent.set(parent, new Set([key]));
      }
    }

    const deletionOrder: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (sessionKey: string): void => {
      if (visited.has(sessionKey)) return;
      if (visiting.has(sessionKey)) throw new Error('OpenClaw session tree contains a cycle');
      if (visited.size + visiting.size >= MAX_SESSION_TREE_SIZE) {
        throw new Error('OpenClaw session tree is too large to delete safely');
      }
      visiting.add(sessionKey);
      for (const childKey of childrenByParent.get(sessionKey) ?? []) visit(childKey);
      visiting.delete(sessionKey);
      visited.add(sessionKey);
      deletionOrder.push(sessionKey);
    };
    visit(rootSessionKey);

    for (const sessionKey of deletionOrder) {
      const session = await this.describeSession(client, sessionKey);
      if (!session) continue;
      if (sessionKey === rootSessionKey && session.sessionId !== rootSessionId) return;
      const deleted = await client.request<SessionDeleteResult>('sessions.delete', {
        key: sessionKey,
        deleteTranscript: true,
        expectedSessionId: session.sessionId,
        ...(session.lifecycleRevision
          ? { expectedLifecycleRevision: session.lifecycleRevision }
          : {}),
        ...(session.updatedAt !== undefined ? { expectedSessionUpdatedAt: session.updatedAt } : {}),
      });
      this.deps.clearSessionApprovalGrants?.(sessionKey);
      const archivedPaths = (deleted.archived ?? []).filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      if (archivedPaths.length > 0) {
        this.addPendingArchivedTranscripts(runId, archivedPaths);
        this.deletePendingArchivedTranscripts(runId);
      }
    }
  }

  private deleteArchivedTranscript(archivedPath: string): void {
    const stateDir = path.resolve(this.deps.getStateDir());
    const agentsDir = path.join(stateDir, 'agents');
    const resolvedPath = path.resolve(archivedPath);
    const relativePath = path.relative(agentsDir, resolvedPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath) ||
      !path.basename(resolvedPath).includes('.deleted.')
    ) {
      throw new Error('OpenClaw returned an unsafe archived transcript path');
    }
    fs.rmSync(resolvedPath, { force: true });
  }

  private readPendingArchivedTranscripts(runId: string): string[] {
    const row = this.deps
      .getDatabase()
      .prepare('SELECT archived_paths_json FROM scheduled_task_result_cleanup WHERE run_id = ?')
      .get(runId) as { archived_paths_json: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.archived_paths_json) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string' && !!value.trim())
        : [];
    } catch {
      throw new Error('Scheduled task cleanup state is invalid');
    }
  }

  private addPendingArchivedTranscripts(runId: string, archivedPaths: string[]): void {
    const paths = [...new Set([...this.readPendingArchivedTranscripts(runId), ...archivedPaths])];
    this.deps
      .getDatabase()
      .prepare(
        `INSERT INTO scheduled_task_result_cleanup (run_id, archived_paths_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           archived_paths_json = excluded.archived_paths_json,
           updated_at = excluded.updated_at`,
      )
      .run(runId, JSON.stringify(paths), Date.now());
  }

  private deletePendingArchivedTranscripts(runId: string): void {
    const pendingPaths = this.readPendingArchivedTranscripts(runId);
    for (let index = 0; index < pendingPaths.length; index += 1) {
      this.deleteArchivedTranscript(pendingPaths[index]);
      const remaining = pendingPaths.slice(index + 1);
      if (remaining.length === 0) this.clearPendingArchivedTranscripts(runId);
      else {
        this.deps
          .getDatabase()
          .prepare(
            'UPDATE scheduled_task_result_cleanup SET archived_paths_json = ?, updated_at = ? WHERE run_id = ?',
          )
          .run(JSON.stringify(remaining), Date.now(), runId);
      }
    }
  }

  private clearPendingArchivedTranscripts(runId: string): void {
    this.deps
      .getDatabase()
      .prepare('DELETE FROM scheduled_task_result_cleanup WHERE run_id = ?')
      .run(runId);
  }

  private deleteCronTaskRunHistory(result: ScheduledTaskResult): void {
    const stateDir = path.resolve(this.deps.getStateDir());
    const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    const cronStoreKey = path.resolve(stateDir, 'cron', 'jobs.json');
    if (!fs.existsSync(databasePath)) {
      throw new Error('OpenClaw state database is unavailable');
    }
    const startedAt = Date.parse(result.startedAt);
    if (!Number.isFinite(startedAt)) {
      throw new Error('Scheduled task result has an invalid start timestamp');
    }

    const db = new Database(databasePath);
    try {
      db.pragma('busy_timeout = 5000');
      const rows = db
        .prepare(
          `SELECT task_id, run_id, started_at, detail_json
           FROM task_runs
           WHERE runtime = 'cron'
             AND source_id = ?
             AND ended_at IS NOT NULL`,
        )
        .all(result.taskId) as CronTaskRunRow[];
      const exact: CronTaskRunRow[] = [];
      const legacy: CronTaskRunRow[] = [];
      for (const row of rows) {
        const detail = this.parseCronTaskRunDetail(row.detail_json);
        if (
          detail?.kind !== 'cron-run' ||
          detail.storeKey !== cronStoreKey ||
          row.started_at !== startedAt
        ) {
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(detail, 'runId')) {
          legacy.push(row);
          continue;
        }
        if (typeof detail.runId === 'string' && detail.runId.trim() === result.id) exact.push(row);
      }
      const candidates = exact.length > 0 ? exact : legacy;
      if (candidates.length === 0) return;
      if (candidates.length > 1) {
        throw new Error('OpenClaw cron task history is ambiguous');
      }

      const row = candidates[0];
      db.transaction(() => {
        db.prepare('DELETE FROM task_delivery_state WHERE task_id = ?').run(row.task_id);
        const deleted = db
          .prepare(
            `DELETE FROM task_runs
             WHERE task_id = ?
               AND runtime = 'cron'
               AND source_id = ?
               AND ended_at IS NOT NULL
               AND started_at IS ?
               AND run_id IS ?
               AND detail_json IS ?`,
          )
          .run(row.task_id, result.taskId, row.started_at, row.run_id, row.detail_json);
        if (deleted.changes !== 1) {
          throw new Error('OpenClaw cron task history changed during deletion');
        }
        if (this.tableExists(db, 'execution_owner_lifecycle_bindings')) {
          db.prepare(
            "DELETE FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'task' AND owner_id = ?",
          ).run(row.task_id);
        }
      })();
    } finally {
      db.close();
    }
  }

  private async describeSession(
    client: GatewayRequestClient,
    sessionKey: string,
  ): Promise<{ sessionId: string; lifecycleRevision?: string; updatedAt?: number } | null> {
    const described = await client.request<SessionDescribeResult>('sessions.describe', {
      key: sessionKey,
    });
    const session = described.session;
    if (!session) return null;
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
    if (!sessionId) throw new Error('OpenClaw session identity is unavailable');
    const lifecycleRevision =
      typeof session.lifecycleRevision === 'string' ? session.lifecycleRevision.trim() : '';
    const updatedAt =
      typeof session.updatedAt === 'number' &&
      Number.isFinite(session.updatedAt) &&
      session.updatedAt >= 0
        ? session.updatedAt
        : undefined;
    return {
      sessionId,
      ...(lifecycleRevision ? { lifecycleRevision } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  private parseCronTaskRunDetail(value: string | null): CronTaskRunDetail | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as CronTaskRunDetail)
        : null;
    } catch {
      return null;
    }
  }

  private tableExists(db: Database.Database, tableName: string): boolean {
    return Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
        .get(tableName),
    );
  }
}
