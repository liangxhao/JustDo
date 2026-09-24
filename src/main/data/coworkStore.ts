import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import type { AgentProfileInput } from '../../shared/agents/agents';
import {
  DEFAULT_MAX_RETAINED_DISPLAY_TABS,
  normalizeMaxRetainedDisplayTabs,
} from '../../shared/cowork/displayTabRetention';
import {
  type CoworkPlanHandoff,
  CoworkPlanHandoffState,
  type CreateCoworkPlanHandoffInput,
  type TransitionCoworkPlanHandoffInput,
} from '../../shared/cowork/planHandoff';
import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  normalizeMaxGoalContinuationTurns,
} from '../../shared/cowork/sessionGoal';
import type {
  BeginSessionRunInput,
  SessionRunState,
  SessionRunTiming,
} from '../../shared/cowork/sessionRun';
import type { ExternalSessionMetadata, ExternalSessionStatus } from '../../shared/integrations/multica';
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
import {
  type ExternalAgentSettings,
  parseExternalAgentSettings,
  validateExternalAgentSettings,
} from '../../shared/openclaw/externalAgents';
import { DEFAULT_WORKSPACE_DIRECTORY_NAME } from '../../shared/productMetadata';
import { rewriteOpenClawModelProviderId } from '../../shared/providers';

// Default working directory for new users
const getDefaultWorkingDirectory = (): string => {
  const developmentWorkspace =
    process.env.NODE_ENV === 'development' ? process.env.JUSTDO_DEV_WORKSPACE_DIR : undefined;
  if (developmentWorkspace && path.isAbsolute(developmentWorkspace)) return developmentWorkspace;
  return path.join(os.homedir(), DEFAULT_WORKSPACE_DIRECTORY_NAME, 'project');
};

const TASK_WORKSPACE_CONTAINER_DIR = '.justdo-tasks';
const GOAL_EXECUTION_CONFIG_PREFIX = 'goalExecution:';
const AGENT_RUNTIME_SETTINGS_CONFIG_KEY = 'agentRuntimeSettings:v1';
const EXTERNAL_AGENT_SETTINGS_CONFIG_KEY = 'externalAgentSettings:v1';

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

const normalizeCoworkExecutionModeValue = (value: unknown): CoworkExecutionMode =>
  value === 'sandbox' ? 'sandbox' : 'local';
export type CoworkAgentEngine = 'openclaw';

export interface Agent {
  deletedAt?: number;
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
  handoffSource?: import('../../shared/agents/agents').AgentHandoffSource;
  forkSource?: CoworkSessionForkSource;
  external?: ExternalSessionMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkSessionForkSource {
  sessionId?: string;
  title: string;
  entryId: string;
}

export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: CoworkSessionStatus;
  pinned: boolean;
  groupId: string | null;
  agentId: string;
  external?: ExternalSessionMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface CoworkConfig {
  workingDirectory: string;
  executionMode: CoworkExecutionMode;
  sandboxNetworkEnabled: boolean;
  agentEngine: CoworkAgentEngine;
  permissionMode: PermissionMode;
  maxGoalContinuationTurns: number;
  maxRetainedDisplayTabs: number;
}

export type CoworkConfigUpdate = Partial<
  Pick<
    CoworkConfig,
    | 'workingDirectory'
    | 'executionMode'
    | 'sandboxNetworkEnabled'
    | 'agentEngine'
    | 'permissionMode'
    | 'maxGoalContinuationTurns'
    | 'maxRetainedDisplayTabs'
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

interface PlanHandoffRow {
  plan_id: string;
  session_id: string;
  planning_session_key: string;
  artifact_workspace_root: string;
  artifact_relative_path: string;
  artifact_sha256: string;
  artifact_byte_length: number;
  state: CoworkPlanHandoffState;
  implementation_session_key: string | null;
  implementation_gateway_session_id: string | null;
  implementation_run_id: string | null;
  error: string | null;
  presented_at: number;
  dispatch_started_at: number | null;
  admitted_at: number | null;
  resolved_at: number | null;
  failed_at: number | null;
  created_at: number;
  updated_at: number;
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

const mapPlanHandoff = (row: PlanHandoffRow): CoworkPlanHandoff => ({
  planId: row.plan_id,
  sessionId: row.session_id,
  planningSessionKey: row.planning_session_key,
  artifact: {
    sessionId: row.session_id,
    planId: row.plan_id,
    workspaceRoot: row.artifact_workspace_root,
    relativePath: row.artifact_relative_path,
    sha256: row.artifact_sha256,
    byteLength: row.artifact_byte_length,
  },
  state: row.state,
  ...(row.implementation_session_key
    ? { implementationSessionKey: row.implementation_session_key }
    : {}),
  ...(row.implementation_gateway_session_id
    ? { implementationGatewaySessionId: row.implementation_gateway_session_id }
    : {}),
  ...(row.implementation_run_id ? { implementationRunId: row.implementation_run_id } : {}),
  ...(row.error ? { error: row.error } : {}),
  presentedAt: row.presented_at,
  ...(row.dispatch_started_at === null ? {} : { dispatchStartedAt: row.dispatch_started_at }),
  ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
  ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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

  copyTerminalSessionRuns(sourceSessionId: string, targetSessionId: string): number {
    const sourceRuns = this.getAll<SessionRunRow>(
      `SELECT * FROM cowork_session_runs
       WHERE session_id = ? AND ended_at IS NOT NULL
       ORDER BY started_at, id`,
      [sourceSessionId],
    );
    if (sourceRuns.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT INTO cowork_session_runs
        (id, session_id, client_turn_id, root_run_id, model_ref, state,
         started_at, accepted_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const copy = this.db.transaction(() => {
      const now = Date.now();
      for (const run of sourceRuns) {
        const id = uuidv4();
        insert.run(
          id,
          targetSessionId,
          `justdo-${run.started_at}-${id}`,
          run.root_run_id,
          run.model_ref,
          run.state,
          run.started_at,
          run.accepted_at,
          run.ended_at,
          now,
          now,
        );
      }
    });
    copy();
    return sourceRuns.length;
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

  createPlanHandoff(input: CreateCoworkPlanHandoffInput): CoworkPlanHandoff {
    const existing = this.getPlanHandoff(input.planId);
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.planningSessionKey !== input.planningSessionKey ||
        existing.artifact.workspaceRoot !== input.artifact.workspaceRoot ||
        existing.artifact.relativePath !== input.artifact.relativePath ||
        existing.artifact.sha256 !== input.artifact.sha256 ||
        existing.artifact.byteLength !== input.artifact.byteLength
      ) {
        throw new Error('This plan handoff already refers to different immutable content.');
      }
      return existing;
    }
    if (
      input.artifact.sessionId !== input.sessionId ||
      input.artifact.planId !== input.planId ||
      !input.planningSessionKey.trim() ||
      !input.artifact.workspaceRoot?.trim() ||
      !path.isAbsolute(input.artifact.workspaceRoot) ||
      !input.artifact.relativePath.trim() ||
      !/^[a-f0-9]{64}$/.test(input.artifact.sha256) ||
      !Number.isSafeInteger(input.artifact.byteLength) ||
      input.artifact.byteLength <= 0
    ) {
      throw new Error('Invalid plan handoff artifact metadata.');
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cowork_plan_handoffs
          (plan_id, session_id, planning_session_key, artifact_workspace_root,
           artifact_relative_path, artifact_sha256, artifact_byte_length, state,
           presented_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'presented', ?, ?, ?)`,
      )
      .run(
        input.planId,
        input.sessionId,
        input.planningSessionKey.trim(),
        input.artifact.workspaceRoot,
        input.artifact.relativePath,
        input.artifact.sha256,
        input.artifact.byteLength,
        input.presentedAt,
        now,
        now,
      );
    return this.getPlanHandoff(input.planId)!;
  }

  getPlanHandoff(planId: string): CoworkPlanHandoff | undefined {
    const row = this.getOne<PlanHandoffRow>(
      'SELECT * FROM cowork_plan_handoffs WHERE plan_id = ?',
      [planId],
    );
    return row ? mapPlanHandoff(row) : undefined;
  }

  listPlanHandoffs(sessionId: string): CoworkPlanHandoff[] {
    return this.getAll<PlanHandoffRow>(
      `SELECT * FROM cowork_plan_handoffs
       WHERE session_id = ? ORDER BY presented_at, plan_id`,
      [sessionId],
    ).map(mapPlanHandoff);
  }

  listRecoverablePlanHandoffs(): CoworkPlanHandoff[] {
    return this.getAll<PlanHandoffRow>(
      `SELECT handoff.* FROM cowork_plan_handoffs AS handoff
       WHERE handoff.state IN ('presented', 'dispatching', 'admitted')
          OR (
            handoff.state = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM cowork_plan_handoffs AS newer
              WHERE newer.session_id = handoff.session_id
                AND (
                  newer.presented_at > handoff.presented_at
                  OR (newer.presented_at = handoff.presented_at AND newer.plan_id > handoff.plan_id)
                )
            )
          )
       ORDER BY handoff.updated_at, handoff.plan_id`,
    ).map(mapPlanHandoff);
  }

  transitionPlanHandoff(input: TransitionCoworkPlanHandoffInput): CoworkPlanHandoff {
    const allowed: Record<CoworkPlanHandoffState, CoworkPlanHandoffState[]> = {
      [CoworkPlanHandoffState.Presented]: [
        CoworkPlanHandoffState.Dispatching,
        CoworkPlanHandoffState.Resolved,
        CoworkPlanHandoffState.Failed,
      ],
      [CoworkPlanHandoffState.Dispatching]: [
        CoworkPlanHandoffState.Admitted,
        CoworkPlanHandoffState.Failed,
      ],
      [CoworkPlanHandoffState.Admitted]: [
        CoworkPlanHandoffState.Resolved,
        CoworkPlanHandoffState.Failed,
      ],
      [CoworkPlanHandoffState.Resolved]: [],
      [CoworkPlanHandoffState.Failed]: [
        CoworkPlanHandoffState.Dispatching,
        CoworkPlanHandoffState.Resolved,
      ],
    };
    if (!allowed[input.expectedState]?.includes(input.nextState)) {
      throw new Error('Invalid plan handoff state transition.');
    }

    const implementationSessionKey = input.implementationSessionKey?.trim();
    const implementationGatewaySessionId = input.implementationGatewaySessionId?.trim();
    const implementationRunId = input.implementationRunId?.trim();
    const setClauses = ['state = ?', 'updated_at = ?'];
    const values: Array<string | number | null> = [input.nextState, input.transitionedAt];
    if (input.nextState === CoworkPlanHandoffState.Dispatching) {
      if (!implementationSessionKey) {
        throw new Error('Dispatching a plan handoff requires an implementation session key.');
      }
      setClauses.push(
        'implementation_session_key = ?',
        'dispatch_started_at = ?',
        'implementation_gateway_session_id = NULL',
        'implementation_run_id = NULL',
        'admitted_at = NULL',
        'resolved_at = NULL',
        'error = NULL',
        'failed_at = NULL',
      );
      values.push(implementationSessionKey, input.transitionedAt);
    } else if (input.nextState === CoworkPlanHandoffState.Admitted) {
      if (!implementationGatewaySessionId || !implementationRunId) {
        throw new Error('Admitting a plan handoff requires Gateway session and run identities.');
      }
      setClauses.push(
        'implementation_gateway_session_id = ?',
        'implementation_run_id = ?',
        'admitted_at = ?',
      );
      values.push(implementationGatewaySessionId, implementationRunId, input.transitionedAt);
    } else if (input.nextState === CoworkPlanHandoffState.Resolved) {
      setClauses.push('resolved_at = ?');
      values.push(input.transitionedAt);
    } else if (input.nextState === CoworkPlanHandoffState.Failed) {
      setClauses.push('error = ?', 'failed_at = ?');
      values.push(
        input.error?.trim().slice(0, 2_000) || 'Plan handoff failed',
        input.transitionedAt,
      );
    }
    values.push(input.planId, input.expectedState);
    const result = this.db
      .prepare(
        `UPDATE cowork_plan_handoffs SET ${setClauses.join(', ')}
         WHERE plan_id = ? AND state = ?`,
      )
      .run(...values);
    const handoff = this.getPlanHandoff(input.planId);
    if (!handoff) throw new Error('Plan handoff not found.');
    if (result.changes === 0) {
      const replayMatches =
        handoff.state === input.nextState &&
        (!implementationSessionKey ||
          handoff.implementationSessionKey === implementationSessionKey) &&
        (!implementationGatewaySessionId ||
          handoff.implementationGatewaySessionId === implementationGatewaySessionId) &&
        (!implementationRunId || handoff.implementationRunId === implementationRunId);
      if (replayMatches) return handoff;
      throw new Error(`Plan handoff state changed from ${input.expectedState}.`);
    }
    return handoff;
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
    forkSource?: { sessionId: string; title: string; entryId: string },
  ): CoworkSession {
    const id = uuidv4();
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO cowork_sessions (
        id, title, status, cwd, execution_mode, permission_mode, active_skill_ids, agent_id,
        model_ref, forked_from_session_id, forked_from_session_title, forked_from_entry_id,
        pinned, created_at, updated_at
      )
      VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
        forkSource?.sessionId ?? null,
        forkSource?.title ?? null,
        forkSource?.entryId ?? null,
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
      ...(forkSource ? { forkSource: { ...forkSource } } : {}),
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
      forked_from_session_id?: string | null;
      forked_from_session_title?: string | null;
      forked_from_entry_id?: string | null;
      handoff_from_session_title?: string | null;
      live_handoff_source_id?: string | null;
      live_handoff_source_title?: string | null;
      live_fork_source_id?: string | null;
      live_fork_source_title?: string | null;
      created_at: number;
      updated_at: number;
    }

    const row = this.getOne<SessionRow>(
      `
      SELECT
        session.id, session.title, session.status, session.pinned, session.cwd,
        session.execution_mode, session.permission_mode, session.active_skill_ids,
        session.agent_id, session.model_ref, session.forked_from_session_id,
        session.forked_from_session_title, session.forked_from_entry_id,
        session.handoff_from_session_title,
        handoff.id AS live_handoff_source_id, handoff.title AS live_handoff_source_title,
        source.id AS live_fork_source_id, source.title AS live_fork_source_title,
        session.created_at, session.updated_at
      FROM cowork_sessions AS session
      LEFT JOIN cowork_sessions AS source ON source.id = session.forked_from_session_id
      LEFT JOIN cowork_sessions AS handoff ON handoff.id = session.handoff_from_session_id
      WHERE session.id = ?
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
    const forkSourceTitle =
      row.live_fork_source_title?.trim() || row.forked_from_session_title?.trim();

    const external = this.getExternalSessionMetadata(row.id);
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
      ...(row.forked_from_entry_id?.trim() && forkSourceTitle
        ? {
            forkSource: {
              ...(row.live_fork_source_id?.trim()
                ? { sessionId: row.live_fork_source_id.trim() }
                : {}),
              title: forkSourceTitle,
              entryId: row.forked_from_entry_id.trim(),
            },
          }
        : {}),
      ...(row.handoff_from_session_title
        ? {
            handoffSource: {
              ...(row.live_handoff_source_id ? { sessionId: row.live_handoff_source_id } : {}),
              title: row.live_handoff_source_title || row.handoff_from_session_title,
            },
          }
        : {}),
      ...(external ? { external } : {}),
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

    const externalBySessionId = this.listExternalSessionMetadata();
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as CoworkSessionStatus,
      pinned: Boolean(row.pinned),
      agentId: row.agent_id || 'main',
      groupId: row.group_id,
      ...(externalBySessionId.get(row.id) ? { external: externalBySessionId.get(row.id) } : {}),
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

  private listExternalSessionMetadata(): Map<string, ExternalSessionMetadata> {
    interface ExternalSessionRow {
      cowork_session_id: string;
      source: string;
      status: ExternalSessionStatus;
      openclaw_session_key: string | null;
    }
    let rows: ExternalSessionRow[];
    try {
      rows = this.getAll<ExternalSessionRow>(
        `SELECT cowork_session_id, source, status, openclaw_session_key
         FROM cowork_external_sessions
         WHERE source = 'multica'`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return new Map();
      throw error;
    }
    return new Map(
      rows.map(row => [
        row.cowork_session_id,
        {
          origin: 'multica',
          readOnly: true,
          status: row.status,
          sessionKey: row.openclaw_session_key ?? '',
        },
      ]),
    );
  }

  private getExternalSessionMetadata(sessionId: string): ExternalSessionMetadata | undefined {
    let row:
      | { source: string; status: ExternalSessionStatus; openclaw_session_key: string | null }
      | undefined;
    try {
      row = this.getOne<{
        source: string;
        status: ExternalSessionStatus;
        openclaw_session_key: string | null;
      }>(
        `SELECT source, status, openclaw_session_key
         FROM cowork_external_sessions
         WHERE source = 'multica' AND cowork_session_id = ?`,
        [sessionId],
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return undefined;
      throw error;
    }
    return row
      ? {
          origin: 'multica',
          readOnly: true,
          status: row.status,
          sessionKey: row.openclaw_session_key ?? '',
        }
      : undefined;
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
      'sandboxNetworkEnabled',
      'agentEngine',
      'permissionMode',
      'maxGoalContinuationTurns',
      'maxRetainedDisplayTabs',
    ] as const;
    const configRows = this.getAll<{ key: string; value: string }>(
      `SELECT key, value FROM cowork_config WHERE key IN (${configKeys.map(() => '?').join(', ')})`,
      [...configKeys],
    );
    const cfg = new Map(configRows.map(r => [r.key, r.value]));

    return {
      workingDirectory: cfg.get('workingDirectory') || getDefaultWorkingDirectory(),
      executionMode: normalizeCoworkExecutionModeValue(cfg.get('executionMode')),
      sandboxNetworkEnabled: cfg.get('sandboxNetworkEnabled') === 'true',
      agentEngine: normalizeCoworkAgentEngineValue(cfg.get('agentEngine')),
      permissionMode: resolvePermissionMode(cfg.get('permissionMode')),
      maxGoalContinuationTurns: normalizeMaxGoalContinuationTurns(
        Number.parseInt(cfg.get('maxGoalContinuationTurns') || '', 10),
      ),
      maxRetainedDisplayTabs: normalizeMaxRetainedDisplayTabs(
        Number.parseInt(
          cfg.get('maxRetainedDisplayTabs') || String(DEFAULT_MAX_RETAINED_DISPLAY_TABS),
          10,
        ),
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

    if (config.sandboxNetworkEnabled !== undefined) {
      this.db
        .prepare(
          `
        INSERT INTO cowork_config (key, value, updated_at)
        VALUES ('sandboxNetworkEnabled', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
        )
        .run(String(config.sandboxNetworkEnabled), now);
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

    if (config.maxRetainedDisplayTabs !== undefined) {
      const normalized = normalizeMaxRetainedDisplayTabs(config.maxRetainedDisplayTabs);
      this.db
        .prepare(
          `INSERT INTO cowork_config (key, value, updated_at)
           VALUES ('maxRetainedDisplayTabs', ?, ?)
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

  getExternalAgentSettings(): ExternalAgentSettings {
    const row = this.getOne<{ value: string }>('SELECT value FROM cowork_config WHERE key = ?', [
      EXTERNAL_AGENT_SETTINGS_CONFIG_KEY,
    ]);
    if (!row?.value) return parseExternalAgentSettings(null);
    try {
      return parseExternalAgentSettings(JSON.parse(row.value));
    } catch {
      return parseExternalAgentSettings(null);
    }
  }

  setExternalAgentSettings(settings: ExternalAgentSettings): void {
    const validation = validateExternalAgentSettings(settings);
    if (validation.ok === false) throw new Error(validation.error);
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
      .run(EXTERNAL_AGENT_SETTINGS_CONFIG_KEY, JSON.stringify(validation.settings), Date.now());
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

  saveAgentProfile(input: AgentProfileInput & { id: string }): Agent {
    return this.db.transaction(() => {
      const existing = this.getAgent(input.id);
      if (existing?.deletedAt) throw new Error('agentUnavailable');
      if (input.isDefault) this.db.prepare('UPDATE agents SET is_default = 0').run();
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO agents
          (id, name, description, icon, model, enabled, is_default, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.description,
            input.icon,
            input.model,
            Number(input.enabled),
            Number(input.isDefault),
            Date.now(),
            Date.now(),
          );
      } else {
        this.updateAgent(input.id, input);
        this.db
          .prepare('UPDATE agents SET is_default = ? WHERE id = ?')
          .run(Number(input.isDefault), input.id);
      }
      return this.getAgent(input.id)!;
    })();
  }

  /** Remove from product availability while retaining native history ownership. */
  deleteAgent(id: string): void {
    this.db.transaction(() => {
      const agent = this.getAgent(id);
      if (!agent) throw new Error('agentUnavailable');
      if (id === 'main' || agent.isDefault) throw new Error('agentMainRequired');
      if (agent.deletedAt) return;
      const running = this.db
        .prepare("SELECT 1 FROM cowork_sessions WHERE agent_id = ? AND status = 'running' LIMIT 1")
        .get(id);
      if (running) throw new Error('agentBusy');
      const now = Date.now();
      this.db
        .prepare('UPDATE agents SET enabled = 0, deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id);
    })();
  }

  removeUnstartedAgent(id: string): void {
    this.db
      .prepare(
        `DELETE FROM agents WHERE id = ? AND NOT EXISTS
      (SELECT 1 FROM cowork_sessions WHERE agent_id = ?)`,
      )
      .run(id, id);
  }

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
    if (existing.deletedAt) throw new Error('agentUnavailable');

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
    deleted_at?: number | null;
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
      ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
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
