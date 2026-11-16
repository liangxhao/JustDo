import {
  type CoworkSubagentAction,
  CoworkSubagentActions,
  type CoworkSubagentControlResult,
  type CoworkSubagentDetailTask,
  SubagentReadFailure,
} from '../../../shared/cowork/subagentDetails';
import { redactLogText } from '../../core/logging/logRedaction';
import { isVisibleNativeChildSession } from '../../openclaw/sessions/visibleChildSession';
import type { GatewayClientLike } from '../gateway/types';
import { SubagentReadError } from './subagentRead';
import {
  OPENCLAW_COMPACT_SESSION_ROW_MODE,
  parseSessionsListPageV2026_10_6,
  parseSessionsListResultV2026_10_6,
} from './wire/v2026_10_6';

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

type ListGatewaySubagentsOptions = {
  client: GatewayRequestClient;
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
const DESCENDANT_DISCOVERY_INCOMPLETE =
  'OpenClaw descendant discovery is incomplete; session stop was not confirmed.';
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
const controlParentKey = (row: SessionRow): string | undefined => optionalString(row.spawnedBy);
const browseParentKey = (row: SessionRow): string | undefined => {
  const agentId = optionalString(row.key)?.split(':', 3)[1];
  return agentId && isVisibleNativeChildSession(row, agentId)
    ? optionalString(row.parentSessionKey)
    : controlParentKey(row);
};
const fromSession = (row: SessionRow, parentKey = browseParentKey(row)): GatewaySubagent | null => {
  const key = optionalString(row.key);
  if (!key || !parentKey) return null;
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
    parentTaskId: parentKey,
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
  options: { offset: number; limit?: number; rowMode?: 'compact'; browse?: boolean; parentKey?: string },
) => {
  // The native spawnedBy query uses expiring control links and can omit completed
  // children whose durable row still has spawnedBy. Read native rows and match
  // their explicit ancestry locally; do not infer membership or cache history.
  const { limit = SESSION_PAGE_SIZE, rowMode, browse, parentKey } = options;
  let { offset } = options;
  for (;;) {
    const response = await client.request('sessions.list', {
      limit, offset, archived: 'all', ...(rowMode ? { rowMode } : {}),
    });
    const page = parseSessionPage(response, offset, browse);
    const sessions = parentKey
      ? page.sessions.filter(row => browseParentKey(row) === parentKey)
      : page.sessions;
    if (sessions.length || !page.hasMore) return { ...page, sessions };
    offset = page.nextOffset!;
  }
};

function parseSessionPage(value: unknown, offset: number, browse?: boolean) {
  try {
    const page = browse
      ? parseSessionsListPageV2026_10_6(value)
      : parseSessionsListResultV2026_10_6(value);
    if (page.hasMore && (page.nextOffset == null || page.nextOffset <= offset)) {
      throw new Error('OpenClaw sessions.list cursor did not advance');
    }
    return page;
  } catch (error) {
    throw new SubagentReadError(
      SubagentReadFailure.InvalidData,
      error instanceof Error ? error.message : 'Invalid sessions.list response',
    );
  }
}

const listSessions = async (
  client: GatewayRequestClient,
  options: { rowMode?: 'compact'; browse?: boolean } = {},
): Promise<SessionRow[]> => {
  const rows: SessionRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await readPage(client, { ...options, offset });
    rows.push(...page.sessions);
    if (!page.hasMore) return rows;
    offset = page.nextOffset!;
  }
};
export const listPersistedGatewaySessions = (client: GatewayRequestClient): Promise<SessionRow[]> =>
  listSessions(client, { rowMode: OPENCLAW_COMPACT_SESSION_ROW_MODE });

// Keep one read in flight and one shared follow-up. A request arriving during
// a read waits for the follow-up, so an intervening sessions.changed is not lost.
// Settled rows are never retained as a second catalog authority.
export const createPersistedGatewaySessionReader = (client: GatewayRequestClient) => {
  let running: Promise<SessionRow[]> | null = null;
  let queued: {
    promise: Promise<SessionRow[]>;
    resolve: (rows: SessionRow[]) => void;
    reject: (error: unknown) => void;
  } | null = null;
  const start = (): Promise<SessionRow[]> => {
    running = listPersistedGatewaySessions(client).finally(() => {
      running = null;
      const followUp = queued;
      queued = null;
      if (followUp) void start().then(followUp.resolve, followUp.reject);
    });
    return running;
  };
  return (): Promise<SessionRow[]> => {
    if (!running) return start();
    if (!queued) {
      let resolve!: (rows: SessionRow[]) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<SessionRow[]>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      queued = { promise, resolve, reject };
    }
    return queued.promise;
  };
};
const describe = async (
  client: GatewayRequestClient,
  key: string,
  options?: { requireExactKey: boolean },
): Promise<SessionRow | null> => {
  const result = await client.request<{ session?: SessionRow | null }>('sessions.describe', {
    key,
  });
  if (result?.session === null) return null;
  if (!result?.session || typeof result.session.key !== 'string') {
    throw new SubagentReadError(SubagentReadFailure.InvalidData, 'Invalid sessions.describe response');
  }
  if (result.session.key !== key) {
    if (options?.requireExactKey) {
      throw new SubagentReadError(SubagentReadFailure.InvalidData, 'sessions.describe returned a different session key');
    }
    return null;
  }
  return result.session;
};

export async function findGatewaySubagentChild(
  client: GatewayRequestClient,
  rootKeys: string[],
  key: string,
): Promise<GatewaySubagent | null> {
  if (!rootKeys.length || rootKeys.includes(key)) return null;
  const row = await describe(client, key, { requireExactKey: true });
  if (!row) return null;
  const parentKey = browseParentKey(row);
  if (!parentKey || !rootKeys.includes(parentKey)) return null;
  if (!optionalString(row.sessionId)) {
    throw new SubagentReadError(SubagentReadFailure.InvalidData, 'Native child session ID is missing');
  }
  return fromSession(row, parentKey);
}
export const getGatewaySubagentDetails = async (
  client: GatewayRequestClient,
  taskId: string,
): Promise<GatewaySubagent | null> => {
  const row = await describe(client, taskId);
  return row ? fromSession(row) : null;
};
const requireSubagentRow = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  taskId: string,
  parentOf: (row: SessionRow) => string | undefined,
): Promise<SessionRow> => {
  if (!taskId.trim() || !rootKeys.length || rootKeys.includes(taskId))
    throw new SubagentReadError(SubagentReadFailure.SessionUnavailable, 'Subagent task does not belong to this session');
  const row = await describe(client, taskId);
  if (!row || !parentOf(row)) {
    throw new SubagentReadError(SubagentReadFailure.SessionUnavailable, 'Subagent task was not found');
  }
  const visited = new Set([taskId]);
  let parent = parentOf(row);
  while (parent && visited.size <= 64) {
    if (rootKeys.includes(parent)) return row;
    if (visited.has(parent)) {
      throw new SubagentReadError(SubagentReadFailure.InvalidData, 'Invalid subagent ancestry');
    }
    visited.add(parent);
    const ancestor = await describe(client, parent);
    parent = ancestor ? parentOf(ancestor) : undefined;
  }
  throw new SubagentReadError(SubagentReadFailure.SessionUnavailable, 'Subagent task does not belong to this session');
};
export const requireGatewaySubagentOwnership = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  taskId: string,
): Promise<GatewaySubagent> => {
  const row = await requireSubagentRow(client, rootKeys, taskId, controlParentKey);
  return fromSession(row, controlParentKey(row))!;
};

export const requireGatewaySubagentForBrowsing = (
  client: GatewayRequestClient,
  rootKeys: string[],
  taskId: string,
): Promise<SessionRow> => requireSubagentRow(client, rootKeys, taskId, browseParentKey);
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
      if (browseParentKey(row) !== parent) continue;
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
export async function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagent[]> {
  const subagents = new Map<string, GatewaySubagent>();
  const parents = new Set(options.parentKeys);
  if (!parents.size) return [];

  const parentOf = options.requireComplete ? controlParentKey : browseParentKey;
  try {
    for (const row of await listSessions(options.client, { browse: !options.requireComplete })) {
      const parentKey = parentOf(row);
      if (!parentKey || !parents.has(parentKey)) continue;
      const child = fromSession(row, parentKey);
      if (child) subagents.set(child.id, child);
    }
  } catch (error) {
    if (!options.requireComplete) throw error;
    const detail = JSON.stringify({ error: redactLogText(String(error)).slice(0, 500) });
    console.warn(`[SubagentGateway] Failed to list native child sessions ${detail}`);
    throw new Error(DESCENDANT_DISCOVERY_INCOMPLETE);
  }

  const children = [...subagents.values()];
  if (
    options.requireComplete &&
    children.some(child => child.status === SUBAGENT_STATUSES.UNKNOWN)
  ) {
    throw new Error(DESCENDANT_DISCOVERY_INCOMPLETE);
  }
  return children;
}

export const listGatewaySubagentChildren = async (
  client: GatewayRequestClient,
  rootKeys: string[],
  parentTaskId?: string,
  cursor?: string,
): Promise<{ subagents: GatewaySubagent[]; nextCursor?: string }> => {
  if (parentTaskId) await requireGatewaySubagentForBrowsing(client, rootKeys, parentTaskId);
  const keys = parentTaskId ? [parentTaskId] : [...new Set(rootKeys)];
  let index = 0,
    offset = 0;
  if (cursor !== undefined) {
    const invalidCursor = () => new SubagentReadError(
      SubagentReadFailure.PageExpired, 'Invalid session page cursor',
    );
    if (cursor.length > 8192) throw invalidCursor();
    let page: Record<string, unknown>;
    try {
      page = JSON.parse(cursor) as Record<string, unknown>;
    } catch {
      throw invalidCursor();
    }
    if (
      !page ||
      page.binding !== JSON.stringify(keys) ||
      !Number.isSafeInteger(page.index) ||
      (page.index as number) < 0 ||
      (page.index as number) >= keys.length ||
      !Number.isSafeInteger(page.offset) ||
      (page.offset as number) < 0
    )
      throw invalidCursor();
    index = page.index as number;
    offset = page.offset as number;
  }
  if (!keys.length) return { subagents: [] };
  const page = await readPage(client, { parentKey: keys[index], offset, limit: 50, browse: true });
  const subagents = page.sessions.flatMap(row => {
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
  const row = await describe(client, target.sessionKey);
  const current = row && controlParentKey(row) ? fromSession(row, controlParentKey(row)) : null;
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
