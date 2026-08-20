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
  runtime?: 'subagent' | 'acp';
};

type GatewaySubagentProjection = Omit<GatewaySubagent, 'label' | 'labelSource'> & {
  label?: string;
  labelSource?: SubagentLabelSource;
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

const resolveChildRuntime = (sessionKey: string): 'subagent' | 'acp' | undefined => {
  if (sessionKey.includes(':acp:')) return 'acp';
  if (sessionKey.includes(':subagent:')) return 'subagent';
  return undefined;
};

const isDelegatedChildSessionKey = (sessionKey: string): boolean =>
  resolveChildRuntime(sessionKey) !== undefined;

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

const resolveToolStatus = (value: unknown): SubagentStatus => {
  if (value === 'pending') return SUBAGENT_STATUSES.PENDING;
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
      status: resolveToolStatus(value.status),
      task: optionalString(value.task),
      model: optionalString(value.model),
      startedAt: optionalNumber(value.startedAt),
      endedAt: optionalNumber(value.endedAt),
      runtimeMs: optionalNumber(value.runtimeMs),
      totalTokens: optionalNumber(value.totalTokens),
      runtime: resolveChildRuntime(sessionKey),
    });
  }
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

/**
 * Invokes OpenClaw's structured `subagents` tool through the public Gateway API.
 * The session projection supplements completed runs older than the tool's
 * 24-hour maximum recent window. Lightweight runtime polling can opt out of the
 * structured tool to avoid touching the parent session's tool-loop counters.
 */
export function listGatewaySubagents(
  options: ListGatewaySubagentsOptions & { includeMalformedForRuntimeControl: true },
): Promise<GatewaySubagentProjection[]>;
export function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagent[]>;
export async function listGatewaySubagents(
  options: ListGatewaySubagentsOptions,
): Promise<GatewaySubagentProjection[]> {
  const bySessionKey = new Map<string, GatewaySubagentProjection>();

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
      if (!sessionKey || !isDelegatedChildSessionKey(sessionKey)) continue;
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
        runtime: resolveChildRuntime(sessionKey),
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
        if (!sessionKey || !isDelegatedChildSessionKey(sessionKey)) continue;
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
          runtime: resolveChildRuntime(sessionKey),
        });
      }
    } catch (error) {
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
  if (options.includeMalformedForRuntimeControl) return subagents;
  return subagents.filter(
    (subagent): subagent is GatewaySubagent =>
      typeof subagent.label === 'string' && subagent.labelSource !== undefined,
  );
}
