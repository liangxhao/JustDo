import type Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';

import type { ExternalSessionStatus } from '../../../shared/multica';
import type { CoworkStore } from '../../data/coworkStore';

export interface MulticaExternalSessionBinding {
  externalSessionKey: string;
  coworkSessionId: string;
  openclawSessionId: string | null;
  openclawSessionKey: string | null;
  cwd: string;
  status: ExternalSessionStatus;
}

interface BindingRow {
  external_session_key: string;
  cowork_session_id: string;
  openclaw_session_id: string | null;
  openclaw_session_key: string | null;
  cwd: string;
  status: ExternalSessionStatus;
}

const mapBinding = (row: BindingRow): MulticaExternalSessionBinding => ({
  externalSessionKey: row.external_session_key,
  coworkSessionId: row.cowork_session_id,
  openclawSessionId: row.openclaw_session_id,
  openclawSessionKey: row.openclaw_session_key,
  cwd: row.cwd,
  status: row.status,
});

const statusToCoworkStatus = (status: ExternalSessionStatus): 'running' | 'completed' | 'error' =>
  status === 'running' ? 'running' : status === 'completed' ? 'completed' : 'error';

const buildOpenClawSessionKey = (agentId: string, externalSessionKey: string): string => {
  const digest = crypto
    .createHash('sha256')
    .update(`${agentId}\0${externalSessionKey}`)
    .digest('base64url')
    .slice(0, 24)
    .toLowerCase();
  return `agent:${agentId}:multica:${digest}`.toLowerCase();
};

const canonicalizeOpenClawSessionKey = (value: string | null): string | null => {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
};

export class MulticaExternalSessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly coworkStore: CoworkStore,
  ) {}

  findByExternalOrRuntimeId(value: string): MulticaExternalSessionBinding | null {
    const row = this.db
      .prepare(
        `SELECT external_session_key, cowork_session_id, openclaw_session_id,
          openclaw_session_key, cwd, status
         FROM cowork_external_sessions
         WHERE source = 'multica'
           AND (external_session_key = ? OR openclaw_session_id = ?)
         LIMIT 1`,
      )
      .get(value, value) as BindingRow | undefined;
    if (!row) return null;

    const binding = mapBinding(row);
    const canonicalSessionKey = canonicalizeOpenClawSessionKey(binding.openclawSessionKey);
    if (canonicalSessionKey !== binding.openclawSessionKey) {
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE cowork_external_sessions SET openclaw_session_key = ?, updated_at = ?
           WHERE source = 'multica' AND external_session_key = ?`,
        )
        .run(canonicalSessionKey, now, binding.externalSessionKey);
      return { ...binding, openclawSessionKey: canonicalSessionKey };
    }
    return binding;
  }

  resolveOrCreate(input: {
    requestedSessionId: string;
    cwd: string;
    agentId: string;
    initialMulticaSession: boolean;
  }): MulticaExternalSessionBinding {
    const existing = this.findByExternalOrRuntimeId(input.requestedSessionId);
    if (existing) {
      if (existing.cwd !== input.cwd) {
        const now = Date.now();
        this.db
          .prepare(
            `UPDATE cowork_external_sessions SET cwd = ?, updated_at = ?
             WHERE source = 'multica' AND external_session_key = ?`,
          )
          .run(input.cwd, now, existing.externalSessionKey);
        this.coworkStore.updateSession(existing.coworkSessionId, { cwd: input.cwd });
        return { ...existing, cwd: input.cwd };
      }
      return existing;
    }

    const externalSessionKey = input.requestedSessionId;
    const openclawSessionKey = input.initialMulticaSession
      ? buildOpenClawSessionKey(input.agentId, externalSessionKey)
      : null;
    const openclawSessionId = input.initialMulticaSession ? null : input.requestedSessionId;
    const folderName = path.basename(path.resolve(input.cwd)) || input.cwd;
    const session = this.coworkStore.createSession(
      `[Multica] ${folderName}`,
      input.cwd,
      'local',
      [],
      input.agentId,
    );
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cowork_external_sessions
          (source, external_session_key, cowork_session_id, openclaw_session_id,
           openclaw_session_key, cwd, status, created_at, updated_at)
         VALUES ('multica', ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        externalSessionKey,
        session.id,
        openclawSessionId,
        openclawSessionKey,
        input.cwd,
        now,
        now,
      );
    this.coworkStore.updateSession(session.id, { status: 'running' });
    return {
      externalSessionKey,
      coworkSessionId: session.id,
      openclawSessionId,
      openclawSessionKey,
      cwd: input.cwd,
      status: 'running',
    };
  }

  updateRun(
    binding: MulticaExternalSessionBinding,
    status: ExternalSessionStatus,
    openclawSessionId?: string | null,
    openclawSessionKey?: string | null,
  ): void {
    const now = Date.now();
    const canonicalSessionKey = canonicalizeOpenClawSessionKey(openclawSessionKey ?? null);
    this.db
      .prepare(
        `UPDATE cowork_external_sessions
         SET status = ?, openclaw_session_id = COALESCE(?, openclaw_session_id),
             openclaw_session_key = COALESCE(?, openclaw_session_key), updated_at = ?
         WHERE source = 'multica' AND external_session_key = ?`,
      )
      .run(
        status,
        openclawSessionId?.trim() || null,
        canonicalSessionKey,
        now,
        binding.externalSessionKey,
      );
    this.coworkStore.updateSession(binding.coworkSessionId, {
      status: statusToCoworkStatus(status),
    });
  }
}

export function rewriteMulticaAgentSessionArgs(
  argv: readonly string[],
  store: MulticaExternalSessionStore,
  cwd: string,
): { argv: string[]; binding: MulticaExternalSessionBinding } | null {
  if (argv[0] !== 'agent') return null;
  const sessionIdIndex = argv.indexOf('--session-id');
  const sessionKeyIndex = argv.indexOf('--session-key');
  const selectedIndex = sessionIdIndex >= 0 ? sessionIdIndex : sessionKeyIndex;
  const requestedSessionId = selectedIndex >= 0 ? argv[selectedIndex + 1]?.trim() : '';
  if (!requestedSessionId)
    throw new Error('Multica agent request is missing a session identifier.');

  const agentIndex = argv.indexOf('--agent');
  const agentId = agentIndex >= 0 ? argv[agentIndex + 1]?.trim() || 'main' : 'main';
  const initialMulticaSession = requestedSessionId.startsWith('multica-');
  const binding = store.resolveOrCreate({
    requestedSessionId,
    cwd,
    agentId,
    initialMulticaSession,
  });
  const rewritten = [...argv];
  if (binding.openclawSessionKey) {
    rewritten.splice(selectedIndex, 2, '--session-key', binding.openclawSessionKey);
  }
  return { argv: rewritten, binding };
}

const findSessionId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['sessionId', 'session_id']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const nested of Object.values(record)) {
    const found = findSessionId(nested);
    if (found) return found;
  }
  return null;
};

export function extractOpenClawSessionId(stdout: string): string | null {
  const candidates = [stdout, ...stdout.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const found = findSessionId(JSON.parse(candidate));
      if (found) return found;
    } catch {
      // OpenClaw may emit NDJSON or diagnostic lines before the result.
    }
  }
  return null;
}

export function extractOpenClawSessionKey(stdout: string): string | null {
  const candidates = [stdout, ...stdout.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const pending: unknown[] = [parsed];
      while (pending.length > 0) {
        const value = pending.shift();
        if (!value || typeof value !== 'object') continue;
        const record = value as Record<string, unknown>;
        if (typeof record.sessionKey === 'string' && record.sessionKey.trim()) {
          return record.sessionKey.trim();
        }
        pending.push(...Object.values(record));
      }
    } catch {
      // OpenClaw may emit NDJSON or diagnostic lines before the result.
    }
  }
  return null;
}
