import type { GatewayClientLike } from '../gateway/types';

export const SUBAGENT_STATUSES = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus =
  (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

export type GatewaySubagent = {
  id: string;
  sessionKey: string;
  label: string;
  status: SubagentStatus;
  task?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
};

const SUBAGENT_RECENT_MINUTES = 24 * 60;
const PERSISTED_SESSION_PAGE_SIZE = 500;

const isSubagentStatus = (value: unknown): value is SubagentStatus =>
  Object.values(SUBAGENT_STATUSES).includes(value as SubagentStatus);

const resolveStatus = (row: Record<string, unknown>): SubagentStatus => {
  if (row.hasActiveSubagentRun === true || row.subagentRunState === 'active') {
    return SUBAGENT_STATUSES.RUNNING;
  }
  if (isSubagentStatus(row.status)) return row.status;
  if (row.subagentRunState === 'interrupted') return SUBAGENT_STATUSES.FAILED;
  return SUBAGENT_STATUSES.DONE;
};

const resolveLabel = (row: Record<string, unknown>, sessionKey: string): string => {
  // OpenClaw's registry naming semantics first; session-derived fields are
  // fallbacks because older Gateway versions do not project taskName/task.
  for (const value of [
    row.label,
    row.taskName,
    row.task,
    row.derivedTitle,
    row.displayName,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return sessionKey.split(':').at(-1) || 'Subagent';
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const rowBelongsToParent = (row: Record<string, unknown>, parentKeys: Set<string>): boolean => {
  const spawnedBy = optionalString(row.spawnedBy);
  const parentSessionKey = optionalString(row.parentSessionKey);
  return (
    (spawnedBy !== undefined && parentKeys.has(spawnedBy)) ||
    (parentSessionKey !== undefined && parentKeys.has(parentSessionKey))
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resolveToolStatus = (value: unknown): SubagentStatus => {
  if (value === 'running' || value === 'active') return SUBAGENT_STATUSES.RUNNING;
  if (isSubagentStatus(value)) return value;
  if (value === 'error') return SUBAGENT_STATUSES.FAILED;
  return SUBAGENT_STATUSES.DONE;
};

const extractToolDetails = (result: unknown): Record<string, unknown> | null => {
  if (!isRecord(result) || result.ok !== true || !isRecord(result.output)) return null;
  if (isRecord(result.output.details)) return result.output.details;
  return result.output.status === 'ok' ? result.output : null;
};

const addToolSubagents = (
  target: Map<string, GatewaySubagent>,
  details: Record<string, unknown>,
): void => {
  const rows = [
    ...(Array.isArray(details.active) ? details.active : []),
    ...(Array.isArray(details.recent) ? details.recent : []),
  ];
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const sessionKey = optionalString(value.sessionKey);
    if (!sessionKey) continue;
    target.set(sessionKey, {
      id: sessionKey,
      sessionKey,
      label:
        optionalString(value.taskName) ||
        optionalString(value.label) ||
        optionalString(value.task) ||
        sessionKey.split(':').at(-1) ||
        'Subagent',
      status: resolveToolStatus(value.status),
      task: optionalString(value.task),
      model: optionalString(value.model),
      startedAt: optionalNumber(value.startedAt),
      endedAt: optionalNumber(value.endedAt),
      runtimeMs: optionalNumber(value.runtimeMs),
      totalTokens: optionalNumber(value.totalTokens),
    });
  }
};

const listPersistedSessions = async (
  client: GatewayClientLike,
): Promise<Array<Record<string, unknown>>> => {
  const sessions: Array<Record<string, unknown>> = [];
  let offset = 0;

  while (true) {
    const result = await client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      limit: PERSISTED_SESSION_PAGE_SIZE,
      offset,
      includeDerivedTitles: true,
    });
    const page = result.sessions ?? [];
    sessions.push(...page);
    if (page.length < PERSISTED_SESSION_PAGE_SIZE) break;
    offset += PERSISTED_SESSION_PAGE_SIZE;
  }

  return sessions;
};

/**
 * Invokes OpenClaw's structured `subagents` tool through the public Gateway API.
 * The session projection only supplements completed runs older than the tool's
 * 24-hour maximum recent window.
 */
export const listGatewaySubagents = async (options: {
  client: GatewayClientLike;
  parentKeys: string[];
  includePersistedHistory?: boolean;
}): Promise<GatewaySubagent[]> => {
  const bySessionKey = new Map<string, GatewaySubagent>();

  for (const parentKey of options.parentKeys) {
    try {
      const toolResult = await options.client.request<unknown>('tools.invoke', {
        name: 'subagents',
        args: {
          action: 'list',
          recentMinutes: SUBAGENT_RECENT_MINUTES,
        },
        sessionKey: parentKey,
      });
      const details = extractToolDetails(toolResult);
      if (details) addToolSubagents(bySessionKey, details);
    } catch (error) {
      console.warn('[SubagentGateway] Failed to invoke structured subagent list', {
        parentKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // The tool intentionally caps completed runs at 24 hours. Keep the
    // registry-backed session projection as a fallback for permanent history.
    const result = await options.client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      spawnedBy: parentKey,
      limit: 100,
      includeDerivedTitles: true,
    });

    for (const row of result.sessions ?? []) {
      const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
      if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
      if (bySessionKey.has(sessionKey)) continue;
      bySessionKey.set(sessionKey, {
        id: sessionKey,
        sessionKey,
        label: resolveLabel(row, sessionKey),
        status: resolveStatus(row),
        model: optionalString(row.model),
        startedAt: optionalNumber(row.startedAt),
        endedAt: optionalNumber(row.endedAt),
        runtimeMs: optionalNumber(row.runtimeMs),
        totalTokens: optionalNumber(row.totalTokens),
      });
    }
  }

  if (options.includePersistedHistory !== false) {
    // `sessions.list({ spawnedBy })` follows OpenClaw's live child-link policy,
    // so completed children can age out of that projection. List persisted
    // sessions broadly and filter locally to keep long-retained subagent history
    // visible when archiveAfterMinutes is configured as 0.
    const parentKeySet = new Set(options.parentKeys);
    try {
      for (const row of await listPersistedSessions(options.client)) {
        const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
        if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
        if (!rowBelongsToParent(row, parentKeySet)) continue;
        if (bySessionKey.has(sessionKey)) continue;
        bySessionKey.set(sessionKey, {
          id: sessionKey,
          sessionKey,
          label: resolveLabel(row, sessionKey),
          status: resolveStatus(row),
          task: optionalString(row.task),
          model: optionalString(row.model),
          startedAt: optionalNumber(row.startedAt),
          endedAt: optionalNumber(row.endedAt),
          runtimeMs: optionalNumber(row.runtimeMs),
          totalTokens: optionalNumber(row.totalTokens),
        });
      }
    } catch (error) {
      console.warn('[SubagentGateway] Failed to list persisted subagent sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return [...bySessionKey.values()];
};
