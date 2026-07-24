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

export interface OpenClawCronRunCleanupDeps {
  getGatewayClient: () => GatewayRequestClient | null;
  ensureGatewayReady: () => Promise<void>;
  getStateDir: () => string;
  getDatabase: () => Database.Database;
  clearSessionApprovalGrants?: (sessionKey: string) => void;
}

interface CronRunLogKey {
  store_key: string;
  job_id: string;
  seq: number;
}

const MAX_SESSION_TREE_SIZE = 1000;

export class OpenClawCronRunCleanupService {
  constructor(private readonly deps: OpenClawCronRunCleanupDeps) {}

  async deleteResultArtifacts(result: ScheduledTaskResult): Promise<void> {
    this.deletePendingArchivedTranscripts(result.id);
    if (
      result.sessionKey?.trim() &&
      this.isCronOwnedSessionKey(result.sessionKey.trim(), result.taskId)
    ) {
      const client = await this.client();
      await this.deletePersistedSessionTree(client, result.id, result.sessionKey.trim());
    }
    this.deleteCronRunLog(result);
    this.clearPendingArchivedTranscripts(result.id);
  }

  private isCronOwnedSessionKey(sessionKey: string, taskId: string): boolean {
    const cronKey = `cron:${taskId}`;
    return (
      sessionKey === cronKey ||
      sessionKey.startsWith(`${cronKey}:`) ||
      sessionKey.includes(`:${cronKey}:`) ||
      sessionKey.endsWith(`:${cronKey}`)
    );
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
  ): Promise<void> {
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
      const deleted = await client.request<SessionDeleteResult>('sessions.delete', {
        key: sessionKey,
        deleteTranscript: true,
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

  private deleteCronRunLog(result: ScheduledTaskResult): void {
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
      const row = db
        .prepare(
          `SELECT store_key, job_id, seq
           FROM cron_run_logs
           WHERE store_key = ?
             AND job_id = ?
             AND (
               run_id = ?
               OR (run_id IS NULL AND COALESCE(run_at_ms, ts) = ?)
             )
           ORDER BY ts DESC, seq DESC
           LIMIT 1`,
        )
        .get(cronStoreKey, result.taskId, result.id, startedAt) as CronRunLogKey | undefined;
      if (!row) return;
      const deleted = db
        .prepare('DELETE FROM cron_run_logs WHERE store_key = ? AND job_id = ? AND seq = ?')
        .run(row.store_key, row.job_id, row.seq);
      if (deleted.changes !== 1) {
        throw new Error('OpenClaw cron run changed during deletion');
      }
    } finally {
      db.close();
    }
  }
}
