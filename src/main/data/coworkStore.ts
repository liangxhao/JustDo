import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import type {
  BeginSessionRunInput,
  SessionRunState,
  SessionRunTiming,
} from '../../shared/cowork/sessionRun';
import {
  type AgentRuntimeSettings,
  parseAgentRuntimeSettings,
  validateAgentRuntimeSettings,
} from '../../shared/openclaw/agentRuntimeSettings';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
  resolvePermissionMode,
} from '../../shared/openclaw/approvals';
import { DEFAULT_WORKSPACE_DIRECTORY_NAME } from '../../shared/productMetadata';
import { rewriteOpenClawModelProviderId } from '../../shared/providers';
import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  normalizeMaxGoalContinuationTurns,
} from '../../shared/sessionGoal';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  return path.join(os.homedir(), DEFAULT_WORKSPACE_DIRECTORY_NAME, 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.justdo-tasks';
const GOAL_EXECUTION_CONFIG_PREFIX = 'goalExecution:';
const AGENT_RUNTIME_SETTINGS_CONFIG_KEY = 'agentRuntimeSettings:v1';

const normalizeRecentWorkspacePath = (cwd: string): string => {
  const resolved = path.resolve(cwd);
  const marker = `${path.sep}${TASK_WORKSPACE_CONTAINER_DIR}${path.sep}`;
  const markerIndex = resolved.lastIndexOf(marker);
  if (markerIndex > 0) {
    return resolved.slice(0, markerIndex);
  }
  return resolved;
};

// Types mirroring src/types/cowork.ts for main process use
export type CoworkSessionStatus = 'idle' | 'running' | 'completed' | 'error';
export type CoworkExecutionMode = 'auto' | 'local' | 'sandbox';
export type CoworkAgentEngine = 'openclaw';

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  identity: string;
  model: string;
  icon: string;
  skillIds: string[];
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  identity?: string;
  model?: string;
  icon?: string;
  skillIds?: string[];
  enabled?: boolean;
}

export interface ModelProviderRefRenameResult {
  agents: number;
  sessions: number;
  runtimeSettings: number;
}

const COWORK_AGENT_ENGINE = 'openclaw';

function normalizeCoworkAgentEngineValue(value?: string | null): CoworkAgentEngine {
  if (value === COWORK_AGENT_ENGINE || value === 'openclaw') {
    return value;
  }
  return COWORK_AGENT_ENGINE;
}

export interface CoworkSession {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  cwd: string;
  executionMode: CoworkExecutionMode;
  permissionMode: PermissionMode;
  activeSkillIds: string[];
  agentId: string;
  modelRef?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  groupId: string | null;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkConfig {
  workingDirectory: string;
  executionMode: CoworkExecutionMode;
  agentEngine: CoworkAgentEngine;
  permissionMode: PermissionMode;
  maxGoalContinuationTurns: number;
}

export type CoworkConfigUpdate = Partial<
  Pick<
    CoworkConfig,
    | 'workingDirectory'
    | 'executionMode'
    | 'agentEngine'
    | 'permissionMode'
    | 'maxGoalContinuationTurns'
  >
>;

interface SessionRunRow {
  id: string;
  session_id: string;
  client_turn_id: string;
  root_run_id: string | null;
  model_ref: string | null;
  state: SessionRunState;
  started_at: number;
  accepted_at: number | null;
  ended_at: number | null;
}

const mapSessionRun = (row: SessionRunRow): SessionRunTiming => ({
  id: row.id,
  sessionId: row.session_id,
  clientTurnId: row.client_turn_id,
  ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
  ...(row.model_ref ? { modelRef: row.model_ref } : {}),
  startedAt: row.started_at,
  ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  state: row.state,
});

export class CoworkStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  beginSessionRun(input: BeginSessionRunInput): SessionRunTiming {
    const existing = this.getSessionRunByClientTurnId(input.clientTurnId);
    if (existing) {
      if (existing.sessionId !== input.sessionId) {
        throw new Error('This client turn already belongs to another session.');
      }
      return existing;
    }

    const open = this.getOne<SessionRunRow>(
      'SELECT * FROM cowork_session_runs WHERE session_id = ? AND ended_at IS NULL',
      [input.sessionId],
    );
    if (open) {
      throw new Error('This session already has an active user run.');
    }

    const id = uuidv4();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cowork_session_runs
          (id, session_id, client_turn_id, root_run_id, model_ref, state, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.clientTurnId,
        input.clientTurnId,
        input.modelRef?.trim() || null,
        input.startedAt,
        now,
        now,
      );
    return this.getSessionRun(id)!;
  }

  getSessionRun(id: string): SessionRunTiming | undefined {
    const row = this.getOne<SessionRunRow>('SELECT * FROM cowork_session_runs WHERE id = ?', [id]);
    return row ? mapSessionRun(row) : undefined;
  }

  getSessionRunByClientTurnId(clientTurnId: string): SessionRunTiming | undefined {
    const row = this.getOne<SessionRunRow>(
      'SELECT * FROM cowork_session_runs WHERE client_turn_id = ?',
      [clientTurnId],
    );
    return row ? mapSessionRun(row) : undefined;
  }

  getSessionRuns(sessionId: string): SessionRunTiming[] {
    return this.getAll<SessionRunRow>(
      'SELECT * FROM cowork_session_runs WHERE session_id = ? ORDER BY started_at, id',
      [sessionId],
    ).map(mapSessionRun);
  }

  getLatestSessionRun(sessionId: string): SessionRunTiming | undefined {
    const row = this.getOne<SessionRunRow>(
      'SELECT * FROM cowork_session_runs WHERE session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
      [sessionId],
    );
    return row ? mapSessionRun(row) : undefined;
  }

  bindSessionRunRootRun(id: string, rootRunId: string): SessionRunTiming | undefined {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE cowork_session_runs
         SET root_run_id = ?, accepted_at = COALESCE(accepted_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(rootRunId, now, now, id);
    return this.getSessionRun(id);
  }

  finishSessionRun(
    id: string,
    state: Exclude<SessionRunState, 'running'>,
    endedAt: number,
  ): SessionRunTiming | undefined {
    this.db
      .prepare(
        `UPDATE cowork_session_runs
         SET state = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(state, endedAt, endedAt, id);
    return this.getSessionRun(id);
  }

  reopenSessionRun(id: string): SessionRunTiming | undefined {
    this.db
      .prepare(
        `UPDATE cowork_session_runs
         SET state = 'running', ended_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.getSessionRun(id);
  }

  interruptOpenSessionRuns(interruptedAt: number): number {
    const result = this.db
      .prepare(
        `UPDATE cowork_session_runs
         SET state = 'aborted', started_at = ?, accepted_at = ?, ended_at = ?, updated_at = ?
         WHERE ended_at IS NULL`,
      )
      .run(interruptedAt, interruptedAt, interruptedAt, interruptedAt);
    return result.changes;
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  createSession(
    title: string,
    cwd: string,
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = [],
    agentId: string = 'main',
    permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
    modelRef?: string,
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO cowork_sessions (id, title, status, cwd, execution_mode, permission_mode, active_skill_ids, agent_id, model_ref, pinned, created_at, updated_at)
      VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `,
      )
      .run(
        id,
        title,
        cwd,
        executionMode,
        permissionMode,
        JSON.stringify(activeSkillIds),
        agentId,
        modelRef?.trim() || null,
        now,
        now,
      );

    return {
      id,
      title,
      status: 'idle',
      pinned: false,
      cwd,
      executionMode,
      permissionMode,
      activeSkillIds,
      agentId,
      ...(modelRef?.trim() ? { modelRef: modelRef.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string): CoworkSession | null {
    interface SessionRow {
      id: string;
      title: string;
      status: string;
      pinned?: number | null;
      cwd: string;
      execution_mode?: string | null;
      permission_mode?: string | null;
      active_skill_ids?: string | null;
      agent_id?: string | null;
      model_ref?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(
      `
      SELECT id, title, status, pinned, cwd, execution_mode, permission_mode, active_skill_ids, agent_id, model_ref, created_at, updated_at
      FROM cowork_sessions
      WHERE id = ?
    `,
      [id],
    );

    if (!row) return null;

    let activeSkillIds: string[] = [];
    if (row.active_skill_ids) {
      try {
        activeSkillIds = JSON.parse(row.active_skill_ids);
      } catch (e) {
        console.error('[CoworkStore] Failed to parse active_skill_ids for session', id, e);
        activeSkillIds = [];
      }
    }

    return {
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      cwd: row.cwd,
      executionMode: (row.execution_mode as CoworkExecutionMode) || 'local',
      permissionMode: resolvePermissionMode(row.permission_mode),
      activeSkillIds,
      agentId: row.agent_id || 'main',
      ...(row.model_ref?.trim() ? { modelRef: row.model_ref.trim() } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateSession(
    id: string,
    updates: Partial<
      Pick<
        CoworkSession,
        'title' | 'status' | 'cwd' | 'executionMode' | 'permissionMode' | 'modelRef'
      >
    >,
  ): void {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      values.push(updates.title);
    }
    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      values.push(updates.status);
    }
    if (updates.cwd !== undefined) {
      setClauses.push('cwd = ?');
      values.push(updates.cwd);
    }
    if (updates.executionMode !== undefined) {
      setClauses.push('execution_mode = ?');
      values.push(updates.executionMode);
    }
    if (updates.permissionMode !== undefined) {
      if (!isPermissionMode(updates.permissionMode)) {
        throw new Error(`Invalid permission mode: ${String(updates.permissionMode)}`);
      }
      setClauses.push('permission_mode = ?');
      values.push(updates.permissionMode);
    }
    if (updates.modelRef !== undefined) {
      setClauses.push('model_ref = ?');
      values.push(updates.modelRef.trim() || null);
    }

    if (setClauses.length === 0) return;

    values.push(id);
    this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `,
      )
      .run(...values);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run(id);
    this.clearGoalExecutionSnapshot(id);
  }

  deleteSessions(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM cowork_sessions WHERE id IN (${placeholders})`).run(...ids);
    const goalKeys = ids.map(id => `${GOAL_EXECUTION_CONFIG_PREFIX}${id}`);
    this.db.prepare(`DELETE FROM cowork_config WHERE key IN (${placeholders})`).run(...goalKeys);
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE cowork_sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  listSessions(agentId?: string): CoworkSessionSummary[] {
    interface SessionSummaryRow {
      id: string;
      title: string;
      status: string;
      pinned: number | null;
      agent_id: string | null;
      group_id: string | null;
      created_at: number;
      updated_at: number;
    }

    let rows: SessionSummaryRow[];
    if (agentId) {
      rows = this.getAll<SessionSummaryRow>(
        `
        SELECT id, title, status, pinned, agent_id, group_id, created_at, updated_at
        FROM cowork_sessions
        WHERE agent_id = ?
        ORDER BY pinned DESC, updated_at DESC
      `,
        [agentId],
      );
    } else {
      rows = this.getAll<SessionSummaryRow>(`
        SELECT id, title, status, pinned, agent_id, group_id, created_at, updated_at
        FROM cowork_sessions
        ORDER BY pinned DESC, updated_at DESC
      `);
    }

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      agentId: row.agent_id || 'main',
      groupId: row.group_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  resetRunningSessions(): number {
    const result = this.db
      .prepare(
        `
      UPDATE cowork_sessions
      SET status = 'idle'
      WHERE status = 'running'
    `,
      )
      .run();
    return result.changes;
  }

  listRecentCwds(limit: number = 8): string[] {
    interface CwdRow {
      cwd: string;
      updated_at: number;
    }

    const rows = this.getAll<CwdRow>(
      `
      SELECT cwd, updated_at
      FROM cowork_sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      [Math.max(limit * 8, limit)],
    );

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const normalized = normalizeRecentWorkspacePath(row.cwd);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped;
  }

  // Config operations
  getGoalExecutionSnapshot(sessionId: string): GoalExecutionSnapshot | null {
    const row = this.getOne<{ value: string }>('SELECT value FROM cowork_config WHERE key = ?', [
      `${GOAL_EXECUTION_CONFIG_PREFIX}${sessionId}`,
    ]);
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(row.value) as Partial<GoalExecutionSnapshot>;
      const phases = new Set<string>(Object.values(GoalExecutionPhase));
      if (
        parsed.sessionId !== sessionId ||
        typeof parsed.phase !== 'string' ||
        !phases.has(parsed.phase) ||
        typeof parsed.continuationCount !== 'number' ||
        typeof parsed.updatedAt !== 'number'
      ) {
        return null;
      }
      return parsed as GoalExecutionSnapshot;
    } catch {
      return null;
    }
  }

  setGoalExecutionSnapshot(snapshot: GoalExecutionSnapshot): void {
    this.db
      .prepare(
        `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        `${GOAL_EXECUTION_CONFIG_PREFIX}${snapshot.sessionId}`,
        JSON.stringify(snapshot),
        Date.now(),
      );
  }

  clearGoalExecutionSnapshot(sessionId: string): void {
    this.db
      .prepare('DELETE FROM cowork_config WHERE key = ?')
      .run(`${GOAL_EXECUTION_CONFIG_PREFIX}${sessionId}`);
  }

  getConfig(): CoworkConfig {
    const configKeys = [
      'workingDirectory',
      'executionMode',
      'agentEngine',
      'permissionMode',
      'maxGoalContinuationTurns',
    ] as const;
    const configRows = this.getAll<{ key: string; value: string }>(
      `SELECT key, value FROM cowork_config WHERE key IN (${configKeys.map(() => '?').join(', ')})`,
      [...configKeys],
    );
    const cfg = new Map(configRows.map(r => [r.key, r.value]));

    return {
      workingDirectory: cfg.get('workingDirectory') || getDefaultWorkingDirectory(),
      executionMode: 'local' as CoworkExecutionMode,
      agentEngine: normalizeCoworkAgentEngineValue(cfg.get('agentEngine')),
      permissionMode: resolvePermissionMode(cfg.get('permissionMode')),
      maxGoalContinuationTurns: normalizeMaxGoalContinuationTurns(
        Number.parseInt(cfg.get('maxGoalContinuationTurns') || '', 10),
      ),
    };
  }

  setConfig(config: CoworkConfigUpdate): void {
    const now = Date.now();

    if (config.workingDirectory !== undefined) {
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('workingDirectory', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(config.workingDirectory, now);
    }

    if (config.executionMode !== undefined) {
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('executionMode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(config.executionMode, now);
    }

    if (config.agentEngine !== undefined) {
      const normalizedAgentEngine = normalizeCoworkAgentEngineValue(config.agentEngine);
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('agentEngine', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(normalizedAgentEngine, now);
    }

    if (config.permissionMode !== undefined) {
      if (!isPermissionMode(config.permissionMode)) {
        throw new Error('Invalid permission mode');
      }
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('permissionMode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(config.permissionMode, now);
    }

    if (config.maxGoalContinuationTurns !== undefined) {
      const normalized = normalizeMaxGoalContinuationTurns(config.maxGoalContinuationTurns);
      this.db
        .prepare(
          `INSERT INTO cowork_config (key, value, updated_at)
           VALUES ('maxGoalContinuationTurns', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(normalized), now);
    }
  }

  getAgentRuntimeSettings(): AgentRuntimeSettings {
    const row = this.getOne<{ value: string }>('SELECT value FROM cowork_config WHERE key = ?', [
      AGENT_RUNTIME_SETTINGS_CONFIG_KEY,
    ]);
    if (!row?.value) {
      return parseAgentRuntimeSettings(null);
    }

    try {
      return parseAgentRuntimeSettings(JSON.parse(row.value));
    } catch {
      return parseAgentRuntimeSettings(null);
    }
  }

  getSessionModelRef(id: string): string | null {
    const row = this.getOne<{ model_ref: string | null }>(
      'SELECT model_ref FROM cowork_sessions WHERE id = ?',
      [id],
    );
    return row?.model_ref?.trim() || null;
  }

  setAgentRuntimeSettings(settings: AgentRuntimeSettings): void {
    const validation = validateAgentRuntimeSettings(settings);
    if (validation.ok === false) {
      throw new Error(validation.error);
    }

    this.db
      .prepare(
        `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(AGENT_RUNTIME_SETTINGS_CONFIG_KEY, JSON.stringify(validation.settings), Date.now());
  }

  renameCurrentModelProviderRefs(
    aliases: Readonly<Record<string, string>>,
  ): ModelProviderRefRenameResult {
    if (Object.keys(aliases).length === 0) {
      return { agents: 0, sessions: 0, runtimeSettings: 0 };
    }

    return this.db.transaction(() => {
      let agentChanges = 0;
      let sessionChanges = 0;
      let runtimeSettingsChanges = 0;
      const now = Date.now();

      const agents = this.getAll<{ id: string; model: string }>(
        "SELECT id, model FROM agents WHERE TRIM(COALESCE(model, '')) <> ''",
      );
      const updateAgentModel = this.db.prepare(
        'UPDATE agents SET model = ?, updated_at = ? WHERE id = ?',
      );
      for (const agent of agents) {
        const nextModel = rewriteOpenClawModelProviderId(agent.model, aliases);
        if (nextModel === agent.model) continue;
        agentChanges += updateAgentModel.run(nextModel, now, agent.id).changes;
      }

      const sessions = this.getAll<{ id: string; model_ref: string }>(
        "SELECT id, model_ref FROM cowork_sessions WHERE TRIM(COALESCE(model_ref, '')) <> ''",
      );
      const updateSessionModel = this.db.prepare(
        'UPDATE cowork_sessions SET model_ref = ? WHERE id = ?',
      );
      for (const session of sessions) {
        const nextModelRef = rewriteOpenClawModelProviderId(session.model_ref, aliases);
        if (nextModelRef === session.model_ref) continue;
        sessionChanges += updateSessionModel.run(nextModelRef, session.id).changes;
      }

      const runtimeSettings = this.getAgentRuntimeSettings();
      const currentSubagentModel = runtimeSettings.subagents.model;
      if (currentSubagentModel) {
        const nextSubagentModel = rewriteOpenClawModelProviderId(currentSubagentModel, aliases);
        if (nextSubagentModel !== currentSubagentModel) {
          this.setAgentRuntimeSettings({
            ...runtimeSettings,
            subagents: {
              ...runtimeSettings.subagents,
              model: nextSubagentModel,
            },
          });
          runtimeSettingsChanges = 1;
        }
      }

      return {
        agents: agentChanges,
        sessions: sessionChanges,
        runtimeSettings: runtimeSettingsChanges,
      };
    })();
  }

  getAppLanguage(): 'zh' | 'en' {
    interface KvRow {
      value: string;
    }

    const row = this.getOne<KvRow>('SELECT value FROM kv WHERE key = ?', ['app_config']);
    if (!row?.value) {
      return 'zh';
    }

    try {
      const config = JSON.parse(row.value) as { language?: string };
      return config.language === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  }

  // ========== Agent state ==========

  listAgents(): Agent[] {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }

    const rows = this.getAll<AgentRow>(`
      SELECT * FROM agents ORDER BY is_default DESC, created_at ASC
    `);

    return rows.map(row => this.mapAgentRow(row));
  }

  getAgent(id: string): Agent | null {
    interface AgentRow {
      id: string;
      name: string;
      description: string;
      system_prompt: string;
      identity: string;
      model: string;
      icon: string;
      skill_ids: string;
      enabled: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    if (!row) return null;
    return this.mapAgentRow(row);
  }

  backfillEmptyAgentModels(modelId: string): number {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId) return 0;

    const result = this.db
      .prepare("UPDATE agents SET model = ?, updated_at = ? WHERE TRIM(COALESCE(model, '')) = ''")
      .run(normalizedModelId, Date.now());

    return result.changes;
  }

  updateAgent(id: string, updates: UpdateAgentRequest): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const values: (string | number | null)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      values.push(updates.description);
    }
    if (updates.systemPrompt !== undefined) {
      setClauses.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.identity !== undefined) {
      setClauses.push('identity = ?');
      values.push(updates.identity);
    }
    if (updates.model !== undefined) {
      setClauses.push('model = ?');
      values.push(updates.model);
    }
    if (updates.icon !== undefined) {
      setClauses.push('icon = ?');
      values.push(updates.icon);
    }
    if (updates.skillIds !== undefined) {
      setClauses.push('skill_ids = ?');
      values.push(JSON.stringify(updates.skillIds));
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }

    values.push(id);
    this.db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    return this.getAgent(id);
  }

  private mapAgentRow(row: {
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    identity: string;
    model: string;
    icon: string;
    skill_ids: string;
    enabled: number;
    is_default: number;
    created_at: number;
    updated_at: number;
  }): Agent {
    let skillIds: string[] = [];
    try {
      skillIds = JSON.parse(row.skill_ids);
    } catch {
      skillIds = [];
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      systemPrompt: row.system_prompt,
      identity: row.identity,
      model: row.model,
      icon: row.icon,
      skillIds,
      enabled: Boolean(row.enabled),
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
