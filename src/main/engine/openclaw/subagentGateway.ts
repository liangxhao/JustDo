import {
  type CoworkSubagentAction,
  CoworkSubagentActions,
  type CoworkSubagentControlResult,
  type CoworkSubagentDetailTask,
} from '../../../shared/cowork/subagentDetails';
import type { GatewayClientLike } from '../gateway/types';
import { parseSessionsListResultV2026_9_8 } from './wire/v2026_9_8';

export type GatewayRequestClient = Pick<GatewayClientLike, 'request'>;

export const SUBAGENT_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
} as const;

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

export const SUBAGENT_LABEL_SOURCES = {
  TASK_NAME: 'taskName',
  LABEL: 'label',
  TASK: 'task',
} as const;

export type SubagentLabelSource =
  (typeof SUBAGENT_LABEL_SOURCES)[keyof typeof SUBAGENT_LABEL_SOURCES];

export type GatewaySubagent = {
  id: string;
  taskName: string;
  sessionKey: string;
  sessionId?: string;
  label: string;
  labelSource: SubagentLabelSource;
  status: SubagentStatus;
  runtime: 'subagent' | 'acp';
  swarmGroupId?: string;
  parentTaskId?: string;
  execution?: CoworkSubagentDetailTask['execution'];
  deliveryStatus?: CoworkSubagentDetailTask['deliveryStatus'];
  diffStat?: CoworkSubagentDetailTask['diffStat'];
  agentId?: string;
  task?: string;
  runId?: string;
  model?: string;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  runtimeSampledAt?: number;
  totalTokens?: number;
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
  lastActivity?: string;
  lastToolName?: string;
  toolUseCount?: number;
};

export type GatewaySubagentListMetadata = {
  subagents: GatewaySubagent[];
  sessionListComplete: boolean;
};

type ListGatewaySubagentsOptions = {
  client: GatewayClientLike;
  parentKeys: string[];
  requireComplete?: boolean;
};

// OpenClaw 2026.9.8 owns delegated work through session lineage and lifecycle.
// Product IDs are the stable native session keys, never a second task ledger.
const SESSION_PAGE_SIZE = 500;
const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const LABEL_PRIORITY: Record<SubagentLabelSource, number> = { label: 0, task: 1, taskName: 2 };
const STATUS_MAP: Record<string, SubagentStatus> = {
  queued: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  interrupted: 'killed',
  killed: 'killed',
  timeout: 'timeout',
};
type SessionRow = Record<string, unknown>;
const parentKey = (row: SessionRow): string | undefined => optionalString(row.spawnedBy);
const isDelegated = (row: SessionRow): boolean => Boolean(parentKey(row));
const fromSession = (row: SessionRow): GatewaySubagent | null => {
  const key = optionalString(row.key);
  if (!key || !isDelegated(row)) return null;
  const label =
    optionalString(row.label) ??
    optionalString(row.displayName) ??
    optionalString(row.derivedTitle);
  const status =
    STATUS_MAP[String(row.status)] ??
    (row.hasActiveRun === true || row.subagentRunState === 'active'
      ? 'running'
      : row.subagentRunState === 'interrupted'
        ? 'killed'
        : 'unknown');
  const active = status === 'pending' || status === 'running';
  const model = optionalString(row.model);
  const provider = optionalString(row.modelProvider);
  const activeRunIds = Array.isArray(row.activeRunIds) ? row.activeRunIds : [];
  return {
    id: key,
    taskName: key,
    sessionKey: key,
    sessionId: optionalString(row.sessionId),
    label: label ?? key,
    labelSource: label ? 'label' : 'taskName',
    status,
    runtime:
      (typeof row.agentRuntime === 'object' &&
        row.agentRuntime !== null &&
        (row.agentRuntime as { id?: string }).id === 'acp') ||
      key.includes(':acp:')
        ? 'acp'
        : 'subagent',
    parentTaskId: parentKey(row),
    swarmGroupId: optionalString(row.swarmGroupId),
    agentId: optionalString(row.agentId),
    runId: active ? optionalString(activeRunIds[0]) : optionalString(row.lastRunId),
    model: model && provider && !model.startsWith(provider + '/') ? provider + '/' + model : model,
    startedAt: optionalNumber(row.startedAt),
    updatedAt: optionalNumber(row.updatedAt),
    endedAt: active ? undefined : optionalNumber(row.endedAt),
    runtimeMs: optionalNumber(row.runtimeMs),
    ...(status === 'running'
      ? { runtimeSampledAt: optionalNumber(row.snapshotAt) ?? Date.now() }
      : {}),
    totalTokens: optionalNumber(row.totalTokens),
    error: active ? undefined : optionalString(row.lastRunError),
  };
};
const readPage = async (
  client: GatewayRequestClient,
  spawnedBy?: string,
  offset = 0,
  limit = SESSION_PAGE_SIZE,
) => {
  // The native spawnedBy query uses expiring control links and can omit completed
  // children whose durable row still has spawnedBy. Read native rows and match
  // their explicit ancestry locally; do not infer membership or cache history.
  for (;;) {
    const page = parseSessionsListResultV2026_9_8(
      await client.request('sessions.list', { limit, offset, archived: 'all' }),
    );
    if (page.hasMore && (page.nextOffset == null || page.nextOffset <= offset)) {
      throw new Error('OpenClaw sessions.list cursor did not advance');
    }
    const sessions = spawnedBy
      ? page.sessions.filter(row => parentKey(row) === spawnedBy)
      : page.sessions;
    if (sessions.length || !page.hasMore) return { ...page, sessions };
    offset = page.nextOffset!;
  }
};
const listSessions = async (
  client: GatewayRequestClient,
  spawnedBy?: string,
): Promise<SessionRow[]> => {
  const rows: SessionRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await readPage(client, spawnedBy, offset);
    rows.push(...page.sessions);
    if (!page.hasMore) return rows;
    offset = page.nextOffset!;
  }
};
export const listPersistedGatewaySessions = (client: GatewayRequestClient): Promise<SessionRow[]> =>
  listSessions(client);
const describe = async (client: GatewayRequestClient, key: string): Promise<SessionRow | null> => {
  const result = await client.request<{ session?: SessionRow | null }>('sessions.describe', {
    key,
  });
  if (!result.session || result.session.key !== key) return null;
  return result.session;
};
export const getGatewaySubagentDetails = async (
  client: GatewayRequestClient,
  taskId: string,
): Promise<GatewaySubagent | null> => {
  const row = await describe(client, taskId);
  return row ? fromSession(row) : null;
};
export const requireGatewaySubagentOwnership = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  taskId: string,
): Promise<GatewaySubagent> => {
  if (!taskId.trim() || !rootKeys.length || rootKeys.includes(taskId))
    throw new Error('Subagent task does not belong to this session');
  const row = await describe(client, taskId);
  const target = row && fromSession(row);
  if (!target) throw new Error('Subagent task was not found');
  const visited = new Set([taskId]);
  let parent = parentKey(row!);
  while (parent && visited.size <= 64) {
    if (rootKeys.includes(parent)) return target;
    if (visited.has(parent)) throw new Error('Invalid subagent ancestry');
    visited.add(parent);
    const ancestor = await describe(client, parent);
    if (!ancestor || !isDelegated(ancestor)) break;
    parent = parentKey(ancestor);
  }
  throw new Error('Subagent task does not belong to this session');
};
export const listGatewaySubagentDescendants = async (
  client: GatewayRequestClient,
  rootKeys: string[],
): Promise<Array<{ sessionKey: string; sessionId: string; label: string }>> => {
  const queue = [...new Set(rootKeys)],
    visited = new Set(rootKeys);
  const result: Array<{ sessionKey: string; sessionId: string; label: string }> = [];
  if (!queue.length) return result;
  const rows = await listSessions(client);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (parentKey(row) !== parent) continue;
      const child = fromSession(row);
      if (!child || visited.has(child.sessionKey)) continue;
      if (!child.sessionId)
        throw new Error('Gateway Session ID unavailable for ' + child.sessionKey);
      visited.add(child.sessionKey);
      queue.push(child.sessionKey);
      result.push({ sessionKey: child.sessionKey, sessionId: child.sessionId, label: child.label });
    }
  }
  return result;
};
export const listGatewaySubagentsWithMetadata = async (
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagentListMetadata> => {
  const subagents = new Map<string, GatewaySubagent>();
  let sessionListComplete = true;
  const parents = new Set(options.parentKeys);
  if (parents.size) {
    try {
      for (const row of await listSessions(options.client)) {
        if (!parents.has(parentKey(row) ?? '')) continue;
        const child = fromSession(row);
        if (child) subagents.set(child.id, child);
      }
    } catch (error) {
      sessionListComplete = false;
      console.warn('[SubagentGateway] Failed to list native child sessions', {
        error: String(error),
      });
    }
  }
  return { subagents: [...subagents.values()], sessionListComplete };
};
export async function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagent[]> {
  const result = await listGatewaySubagentsWithMetadata(options);
  if (
    options.requireComplete &&
    (!result.sessionListComplete ||
      result.subagents.some(child => child.status === SUBAGENT_STATUSES.UNKNOWN))
  )
    throw new Error('OpenClaw descendant discovery is incomplete; session stop was not confirmed.');
  return result.subagents;
}
export const listGatewaySubagentChildren = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  parentTaskId?: string,
  cursor?: string,
): Promise<{ subagents: GatewaySubagent[]; nextCursor?: string }> => {
  const keys = parentTaskId
    ? [(await requireGatewaySubagentOwnership(client, rootKeys, parentTaskId)).sessionKey]
    : [...new Set(rootKeys)];
  let index = 0,
    offset = 0;
  if (cursor !== undefined) {
    if (cursor.length > 8192) throw new Error('Invalid session page cursor');
    const page = JSON.parse(cursor) as Record<string, unknown>;
    if (
      !page ||
      page.binding !== JSON.stringify(keys) ||
      !Number.isSafeInteger(page.index) ||
      (page.index as number) < 0 ||
      (page.index as number) >= keys.length ||
      !Number.isSafeInteger(page.offset) ||
      (page.offset as number) < 0
    )
      throw new Error('Invalid session page cursor');
    index = page.index as number;
    offset = page.offset as number;
  }
  if (!keys.length) return { subagents: [] };
  const page = await readPage(client, keys[index], offset, 50);
  const subagents = page.sessions
    .filter(row => parentKey(row) === keys[index])
    .flatMap(row => {
      const child = fromSession(row);
      return child ? [child] : [];
    });
  const nextIndex = page.hasMore ? index : index + 1;
  return {
    subagents,
    ...(nextIndex < keys.length
      ? {
          nextCursor: JSON.stringify({
            binding: JSON.stringify(keys),
            index: nextIndex,
            offset: page.hasMore ? page.nextOffset : 0,
          }),
        }
      : {}),
  };
};
export const controlGatewaySubagent = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  taskId: string,
  action: CoworkSubagentAction,
): Promise<CoworkSubagentControlResult> => {
  if (action !== CoworkSubagentActions.Cancel) throw new Error('Unknown subagent operation');
  const target = await requireGatewaySubagentOwnership(client, rootKeys, taskId);
  // The native key-only abort clears followup queues, but has no caller-supplied
  // sessionId fence. Recheck the leaf after ancestry reads and reject a reset,
  // ownership transfer or replacement run before issuing the native operation.
  const current = await getGatewaySubagentDetails(client, target.sessionKey);
  if (
    !current ||
    !target.sessionId ||
    current.sessionId !== target.sessionId ||
    current.parentTaskId !== target.parentTaskId ||
    current.runId !== target.runId
  ) {
    throw new Error('Subagent identity changed; refresh before cancelling');
  }
  const result = await client.request<{ ok?: boolean; status?: string }>('sessions.abort', {
    key: target.sessionKey,
    clearQueued: true,
  });
  return result.ok === true && (result.status === 'aborted' || result.status === 'no-active-run')
    ? { success: true }
    : { success: false, error: 'Session cancellation was not confirmed' };
};

export const mergeGatewaySubagentSnapshots = (
  retained: GatewaySubagent[],
  current: GatewaySubagent[],
): GatewaySubagent[] => {
  const byId = new Map(retained.map(subagent => [subagent.id, { ...subagent }]));
  for (const subagent of current) {
    const previous = byId.get(subagent.id);
    if (!previous) {
      byId.set(subagent.id, { ...subagent });
      continue;
    }
    const preferCurrentLabel =
      LABEL_PRIORITY[subagent.labelSource] <= LABEL_PRIORITY[previous.labelSource];
    const currentLifecycleIsStale =
      previous.updatedAt !== undefined &&
      (subagent.updatedAt === undefined || subagent.updatedAt < previous.updatedAt);
    const lifecycle = currentLifecycleIsStale ? previous : subagent;
    const active =
      lifecycle.status === SUBAGENT_STATUSES.PENDING ||
      lifecycle.status === SUBAGENT_STATUSES.RUNNING;
    const sameLifecycleRevision =
      lifecycle.updatedAt !== undefined && previous.updatedAt !== undefined
        ? lifecycle.updatedAt === previous.updatedAt
        : lifecycle.endedAt !== undefined && previous.endedAt !== undefined
          ? lifecycle.endedAt === previous.endedAt
          : lifecycle.updatedAt === undefined &&
            previous.updatedAt === undefined &&
            lifecycle.endedAt === undefined &&
            previous.endedAt === undefined;
    const reuseTerminalFallback =
      !active && lifecycle.status === previous.status && sameLifecycleRevision;
    const merged: GatewaySubagent = {
      ...previous,
      ...subagent,
      label: preferCurrentLabel ? subagent.label : previous.label,
      labelSource: preferCurrentLabel ? subagent.labelSource : previous.labelSource,
      status: lifecycle.status,
      swarmGroupId: lifecycle.swarmGroupId,
      execution: lifecycle.execution,
      deliveryStatus: lifecycle.deliveryStatus,
      diffStat: lifecycle.diffStat,
      sessionId: subagent.sessionId ?? previous.sessionId,
      task: subagent.task ?? previous.task,
      runId: active
        ? lifecycle.runId
        : (lifecycle.runId ?? (reuseTerminalFallback ? previous.runId : undefined)),
      model: subagent.model ?? previous.model,
      startedAt: active ? lifecycle.startedAt : (lifecycle.startedAt ?? previous.startedAt),
      updatedAt: lifecycle.updatedAt ?? previous.updatedAt,
      endedAt: active
        ? undefined
        : (lifecycle.endedAt ?? (reuseTerminalFallback ? previous.endedAt : undefined)),
      runtimeMs: active
        ? lifecycle.runtimeMs
        : (lifecycle.runtimeMs ?? (reuseTerminalFallback ? previous.runtimeMs : undefined)),
      runtimeSampledAt: active ? lifecycle.runtimeSampledAt : undefined,
      totalTokens: subagent.totalTokens ?? previous.totalTokens,
      progressSummary: lifecycle.progressSummary ?? previous.progressSummary,
      terminalSummary: active
        ? undefined
        : (lifecycle.terminalSummary ??
          (reuseTerminalFallback ? previous.terminalSummary : undefined)),
      error: active
        ? undefined
        : (lifecycle.error ?? (reuseTerminalFallback ? previous.error : undefined)),
      lastActivity: lifecycle.lastActivity ?? previous.lastActivity,
      lastToolName: lifecycle.lastToolName ?? previous.lastToolName,
      toolUseCount: lifecycle.toolUseCount ?? previous.toolUseCount,
    };
    for (const key of [
      'startedAt',
      'runId',
      'endedAt',
      'runtimeMs',
      'runtimeSampledAt',
      'terminalSummary',
      'error',
    ] as const) {
      if (merged[key] === undefined) delete merged[key];
    }
    byId.set(subagent.id, merged);
  }
  return [...byId.values()];
};
