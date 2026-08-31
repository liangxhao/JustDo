import type { GatewayClientLike } from '../gateway/types';

export type GatewayRequestClient = Pick<GatewayClientLike, 'request'>;

export const SUBAGENT_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus =
  (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

export const SUBAGENT_LABEL_SOURCES = {
  TASK_NAME: 'taskName',
  LABEL: 'label',
  TASK: 'task',
} as const;

export type SubagentLabelSource =
  (typeof SUBAGENT_LABEL_SOURCES)[keyof typeof SUBAGENT_LABEL_SOURCES];

export type GatewaySubagent = {
  id: string;
  sessionKey: string;
  sessionId?: string;
  label: string;
  labelSource: SubagentLabelSource;
  status: SubagentStatus;
  task?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
};

type GatewaySubagentProjection = Omit<GatewaySubagent, 'label' | 'labelSource'> & {
  label?: string;
  labelSource?: SubagentLabelSource;
};

export type GatewaySubagentListMetadata = {
  subagents: GatewaySubagent[];
  persistedHistoryComplete: boolean;
  structuredToolComplete: boolean;
};

type ListGatewaySubagentsOptions = {
  client: GatewayClientLike;
  parentKeys: string[];
  includePersistedHistory?: boolean;
  includeStructuredTool?: boolean;
  includeMalformedForRuntimeControl?: boolean;
};

const SUBAGENT_RECENT_MINUTES = 24 * 60;
const PERSISTED_SESSION_PAGE_SIZE = 500;
const SUBAGENT_TASK_TITLE_MAX_CHARS = 48;
const warnedMalformedSubagentKeys = new Set<string>();
const SUBAGENT_LABEL_SOURCE_PRIORITY: Record<SubagentLabelSource, number> = {
  [SUBAGENT_LABEL_SOURCES.TASK_NAME]: 0,
  [SUBAGENT_LABEL_SOURCES.LABEL]: 1,
  [SUBAGENT_LABEL_SOURCES.TASK]: 2,
};

const isSubagentStatus = (value: unknown): value is SubagentStatus =>
  Object.values(SUBAGENT_STATUSES).includes(value as SubagentStatus);

const resolveStatus = (row: Record<string, unknown>): SubagentStatus => {
  if (row.status === 'pending' || row.subagentRunState === 'pending') {
    return SUBAGENT_STATUSES.PENDING;
  }
  if (
    row.hasActiveRun === true ||
    row.hasActiveSubagentRun === true ||
    row.subagentRunState === 'active'
  ) {
    return SUBAGENT_STATUSES.RUNNING;
  }
  if (isSubagentStatus(row.status)) return row.status;
  if (row.subagentRunState === 'interrupted') return SUBAGENT_STATUSES.FAILED;
  return SUBAGENT_STATUSES.DONE;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const summarizeTask = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const firstLine = value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const normalized = firstLine.replace(/\s+/gu, ' ');
  const characters = Array.from(normalized);
  if (characters.length <= SUBAGENT_TASK_TITLE_MAX_CHARS) return normalized;
  return `${characters.slice(0, SUBAGENT_TASK_TITLE_MAX_CHARS).join('')}…`;
};

const resolveSubagentTitle = (
  row: Record<string, unknown>,
): { label: string; labelSource: SubagentLabelSource } | null => {
  const taskName = optionalString(row.taskName);
  if (taskName) {
    return { label: taskName, labelSource: SUBAGENT_LABEL_SOURCES.TASK_NAME };
  }
  const label = optionalString(row.label);
  if (label) {
    return { label, labelSource: SUBAGENT_LABEL_SOURCES.LABEL };
  }
  const task = summarizeTask(row.task);
  if (task) {
    return { label: task, labelSource: SUBAGENT_LABEL_SOURCES.TASK };
  }
  return null;
};

const warnMalformedSubagentOnce = (sessionKey: string): void => {
  if (warnedMalformedSubagentKeys.has(sessionKey)) return;
  warnedMalformedSubagentKeys.add(sessionKey);
  console.warn('[SubagentGateway] Skipping subagent without taskName, label, or task', {
    sessionKey,
  });
};

const mergeSessionProjection = (
  target: Map<string, GatewaySubagentProjection>,
  sessionKey: string,
  row: Record<string, unknown>,
): boolean => {
  const existing = target.get(sessionKey);
  if (!existing) return false;

  const title = resolveSubagentTitle(row);
  if (
    title &&
    (existing.labelSource === undefined ||
      SUBAGENT_LABEL_SOURCE_PRIORITY[title.labelSource] <=
        SUBAGENT_LABEL_SOURCE_PRIORITY[existing.labelSource])
  ) {
    existing.label = title.label;
    existing.labelSource = title.labelSource;
  }
  existing.model ??= optionalString(row.model);
  existing.sessionId ??= optionalString(row.sessionId);
  existing.startedAt ??= optionalNumber(row.startedAt);
  existing.endedAt ??= optionalNumber(row.endedAt);
  existing.runtimeMs ??= optionalNumber(row.runtimeMs);
  existing.totalTokens ??= optionalNumber(row.totalTokens);
  existing.task ??= optionalString(row.task);
  return true;
};

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

const resolveToolStatus = (row: Record<string, unknown>): SubagentStatus => {
  const pendingDescendants = optionalNumber(row.pendingDescendants) ?? 0;
  if (pendingDescendants > 0) return SUBAGENT_STATUSES.RUNNING;

  const value = optionalString(row.status)?.toLowerCase();
  if (value === 'pending') return SUBAGENT_STATUSES.PENDING;
  if (value === 'running' || value === 'active' || value?.startsWith('active (')) {
    return SUBAGENT_STATUSES.RUNNING;
  }
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
  target: Map<string, GatewaySubagentProjection>,
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
    const title = resolveSubagentTitle(value);
    target.set(sessionKey, {
      id: sessionKey,
      sessionKey,
      sessionId: optionalString(value.sessionId),
      ...(title ?? {}),
      status: resolveToolStatus(value),
      task: optionalString(value.task),
      model: optionalString(value.model),
      startedAt: optionalNumber(value.startedAt),
      endedAt: optionalNumber(value.endedAt),
      runtimeMs: optionalNumber(value.runtimeMs),
      totalTokens: optionalNumber(value.totalTokens),
    });
  }
};

export const mergeGatewaySubagentSnapshots = (
  retained: GatewaySubagent[],
  current: GatewaySubagent[],
): GatewaySubagent[] => {
  const bySessionKey = new Map(retained.map(subagent => [subagent.sessionKey, { ...subagent }]));
  for (const subagent of current) {
    const previous = bySessionKey.get(subagent.sessionKey);
    if (!previous) {
      bySessionKey.set(subagent.sessionKey, { ...subagent });
      continue;
    }
    const preferCurrentLabel =
      SUBAGENT_LABEL_SOURCE_PRIORITY[subagent.labelSource] <=
      SUBAGENT_LABEL_SOURCE_PRIORITY[previous.labelSource];
    bySessionKey.set(subagent.sessionKey, {
      ...previous,
      id: subagent.id,
      sessionKey: subagent.sessionKey,
      sessionId: subagent.sessionId ?? previous.sessionId,
      label: preferCurrentLabel ? subagent.label : previous.label,
      labelSource: preferCurrentLabel ? subagent.labelSource : previous.labelSource,
      status: subagent.status,
      task: subagent.task ?? previous.task,
      model: subagent.model ?? previous.model,
      startedAt: subagent.startedAt ?? previous.startedAt,
      endedAt: subagent.endedAt ?? previous.endedAt,
      runtimeMs: subagent.runtimeMs ?? previous.runtimeMs,
      totalTokens: subagent.totalTokens ?? previous.totalTokens,
    });
  }
  return [...bySessionKey.values()];
};

export const listPersistedGatewaySessions = async (
  client: GatewayRequestClient,
): Promise<Array<Record<string, unknown>>> => {
  const sessions: Array<Record<string, unknown>> = [];
  let offset = 0;

  while (true) {
    const result = await client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      limit: PERSISTED_SESSION_PAGE_SIZE,
      offset,
    });
    const page = result.sessions ?? [];
    sessions.push(...page);
    if (page.length < PERSISTED_SESSION_PAGE_SIZE) break;
    offset += PERSISTED_SESSION_PAGE_SIZE;
  }

  return sessions;
};

export const listGatewaySubagentDescendants = async (
  client: GatewayRequestClient,
  rootKeys: string[],
): Promise<Array<{ sessionKey: string; sessionId: string; label: string }>> => {
  const rows = await listPersistedGatewaySessions(client);
  const childrenByParent = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const sessionKey = optionalString(row.key);
    if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
    const parentKeys = new Set(
      [optionalString(row.spawnedBy), optionalString(row.parentSessionKey)].filter(
        (value): value is string => value !== undefined,
      ),
    );
    for (const parentKey of parentKeys) {
      const children = childrenByParent.get(parentKey) ?? [];
      children.push(row);
      childrenByParent.set(parentKey, children);
    }
  }

  const visited = new Set(rootKeys);
  const queue = [...rootKeys];
  const descendants: Array<Record<string, unknown>> = [];
  while (queue.length > 0) {
    const parentKey = queue.shift()!;
    for (const row of childrenByParent.get(parentKey) ?? []) {
      const sessionKey = optionalString(row.key);
      if (!sessionKey || visited.has(sessionKey)) continue;
      visited.add(sessionKey);
      queue.push(sessionKey);
      descendants.push(row);
    }
  }

  const resolved: Array<{ sessionKey: string; sessionId: string; label: string }> = [];
  const concurrency = 8;
  for (let offset = 0; offset < descendants.length; offset += concurrency) {
    const batch = descendants.slice(offset, offset + concurrency);
    resolved.push(
      ...(await Promise.all(
        batch.map(async row => {
          const sessionKey = optionalString(row.key)!;
          let sessionId = optionalString(row.sessionId);
          if (!sessionId) {
            const described = await client.request<{
              session?: Record<string, unknown> | null;
            }>('sessions.describe', { key: sessionKey });
            sessionId = optionalString(described.session?.sessionId);
          }
          if (!sessionId) throw new Error(`Gateway Session ID unavailable for ${sessionKey}`);
          return {
            sessionKey,
            sessionId,
            label: resolveSubagentTitle(row)?.label ?? sessionKey.split(':').pop() ?? sessionKey,
          };
        }),
      )),
    );
  }
  return resolved;
};

/**
 * Invokes OpenClaw's structured `subagents` tool through the public Gateway API.
 * The session projection supplements completed runs older than the tool's
 * 24-hour maximum recent window. Lightweight runtime polling can opt out of the
 * persisted history scan when a retained snapshot is already available. The
 * structured tool remains the authority for current lifecycle state.
 */
const collectGatewaySubagents = async (
  options: ListGatewaySubagentsOptions,
): Promise<{
  subagents: GatewaySubagentProjection[];
  persistedHistoryComplete: boolean;
  structuredToolComplete: boolean;
}> => {
  const bySessionKey = new Map<string, GatewaySubagentProjection>();
  let persistedHistoryComplete = true;
  let structuredToolComplete = true;

  for (const parentKey of options.parentKeys) {
    if (options.includeStructuredTool !== false) {
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
        structuredToolComplete = false;
        console.warn('[SubagentGateway] Failed to invoke structured subagent list', {
          parentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // The tool intentionally caps completed runs at 24 hours. Keep the
    // registry-backed session projection as a fallback for permanent history.
    const result = await options.client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      spawnedBy: parentKey,
      limit: 100,
    });

    for (const row of result.sessions ?? []) {
      const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
      if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
      if (mergeSessionProjection(bySessionKey, sessionKey, row)) continue;
      const title = resolveSubagentTitle(row);
      bySessionKey.set(sessionKey, {
        id: sessionKey,
        sessionKey,
        sessionId: optionalString(row.sessionId),
        ...(title ?? {}),
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
      for (const row of await listPersistedGatewaySessions(options.client)) {
        const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
        if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
        if (!rowBelongsToParent(row, parentKeySet)) continue;
        if (mergeSessionProjection(bySessionKey, sessionKey, row)) continue;
        const title = resolveSubagentTitle(row);
        bySessionKey.set(sessionKey, {
          id: sessionKey,
          sessionKey,
          sessionId: optionalString(row.sessionId),
          ...(title ?? {}),
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
      persistedHistoryComplete = false;
      console.warn('[SubagentGateway] Failed to list persisted subagent sessions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const subagents = [...bySessionKey.values()];
  for (const subagent of subagents) {
    if (subagent.label === undefined || subagent.labelSource === undefined) {
      warnMalformedSubagentOnce(subagent.sessionKey);
    }
  }
  return { subagents, persistedHistoryComplete, structuredToolComplete };
};

const filterWellFormedSubagents = (
  subagents: GatewaySubagentProjection[],
): GatewaySubagent[] =>
  subagents.filter(
    (subagent): subagent is GatewaySubagent =>
      typeof subagent.label === 'string' && subagent.labelSource !== undefined,
  );

export const listGatewaySubagentsWithMetadata = async (
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagentListMetadata> => {
  const result = await collectGatewaySubagents(options);
  return {
    ...result,
    subagents: filterWellFormedSubagents(result.subagents),
  };
};

export function listGatewaySubagents(
  options: ListGatewaySubagentsOptions & { includeMalformedForRuntimeControl: true },
): Promise<GatewaySubagentProjection[]>;
export function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagent[]>;
export async function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagentProjection[]> {
  const result = await collectGatewaySubagents(options);
  return options.includeMalformedForRuntimeControl
    ? result.subagents
    : filterWellFormedSubagents(result.subagents);
}
