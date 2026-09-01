import type { GatewayClientLike } from '../gateway/types';
import {
  type OpenClawTaskStatusV2026_8_1,
  type OpenClawTaskSummaryV2026_8_1,
  parseSessionsListResultV2026_8_1,
  parseTasksGetResultV2026_8_1,
  parseTasksListResultV2026_8_1,
} from './wire/v2026_8_1';

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
  taskName: string;
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
  taskLedgerComplete: boolean;
};

type ListGatewaySubagentsOptions = {
  client: GatewayClientLike;
  parentKeys: string[];
  hydrateDetails?: boolean;
  includeMalformedForRuntimeControl?: boolean;
};

const TASK_PAGE_SIZE = 500;
const SESSION_PAGE_SIZE = 500;
const TASK_DETAIL_CONCURRENCY = 8;
const TASK_TITLE_MAX_CHARS = 48;
const warnedMalformedTaskIds = new Set<string>();
const LABEL_PRIORITY: Record<SubagentLabelSource, number> = {
  [SUBAGENT_LABEL_SOURCES.LABEL]: 0,
  [SUBAGENT_LABEL_SOURCES.TASK]: 1,
  [SUBAGENT_LABEL_SOURCES.TASK_NAME]: 2,
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toTimestamp = (value: string | number | undefined): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const summarizeTask = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const firstLine = value
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const normalized = firstLine.replace(/\s+/gu, ' ');
  const characters = Array.from(normalized);
  return characters.length <= TASK_TITLE_MAX_CHARS
    ? normalized
    : `${characters.slice(0, TASK_TITLE_MAX_CHARS).join('')}…`;
};

const mapTaskStatus = (status: OpenClawTaskStatusV2026_8_1): SubagentStatus => {
  switch (status) {
    case 'queued':
      return SUBAGENT_STATUSES.PENDING;
    case 'running':
      return SUBAGENT_STATUSES.RUNNING;
    case 'completed':
      return SUBAGENT_STATUSES.DONE;
    case 'cancelled':
      return SUBAGENT_STATUSES.KILLED;
    case 'timed_out':
      return SUBAGENT_STATUSES.TIMEOUT;
    case 'failed':
      return SUBAGENT_STATUSES.FAILED;
  }
};

const resolveTaskTitle = (
  task: OpenClawTaskSummaryV2026_8_1,
): { label: string; labelSource: SubagentLabelSource } => {
  const label = optionalString(task.title);
  if (label) return { label, labelSource: SUBAGENT_LABEL_SOURCES.LABEL };
  const prompt = summarizeTask(task.prompt);
  if (prompt) return { label: prompt, labelSource: SUBAGENT_LABEL_SOURCES.TASK };
  return { label: task.id, labelSource: SUBAGENT_LABEL_SOURCES.TASK_NAME };
};

const isSubagentTask = (task: OpenClawTaskSummaryV2026_8_1): boolean =>
  task.runtime === 'subagent' || task.kind === 'subagent';

const toGatewaySubagent = (
  task: OpenClawTaskSummaryV2026_8_1,
): GatewaySubagentProjection | null => {
  const sessionKey = optionalString(task.childSessionKey);
  if (!sessionKey) {
    if (!warnedMalformedTaskIds.has(task.id)) {
      warnedMalformedTaskIds.add(task.id);
      console.warn('[SubagentGateway] Skipping native subagent task without childSessionKey', {
        taskId: task.id,
      });
    }
    return null;
  }
  const startedAt = toTimestamp(task.startedAt) ?? toTimestamp(task.createdAt);
  const endedAt = toTimestamp(task.endedAt);
  return {
    id: task.id,
    taskName: task.id,
    sessionKey,
    ...resolveTaskTitle(task),
    status: mapTaskStatus(task.status),
    task: optionalString(task.prompt),
    startedAt,
    endedAt,
    ...(startedAt !== undefined && endedAt !== undefined
      ? { runtimeMs: Math.max(0, endedAt - startedAt) }
      : {}),
  };
};

const listTaskPages = async (
  client: GatewayRequestClient,
  sessionKey: string,
): Promise<OpenClawTaskSummaryV2026_8_1[]> => {
  const tasks: OpenClawTaskSummaryV2026_8_1[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('OpenClaw tasks.list returned a repeated cursor');
    }
    if (cursor) seenCursors.add(cursor);
    const page = parseTasksListResultV2026_8_1(
      await client.request('tasks.list', {
        sessionKey,
        limit: TASK_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
    );
    tasks.push(...page.tasks.filter(isSubagentTask));
    cursor = page.nextCursor;
  } while (cursor);
  return tasks;
};

const hydrateTaskDetails = async (
  client: GatewayRequestClient,
  tasks: OpenClawTaskSummaryV2026_8_1[],
): Promise<OpenClawTaskSummaryV2026_8_1[]> => {
  const hydrated: OpenClawTaskSummaryV2026_8_1[] = [];
  for (let offset = 0; offset < tasks.length; offset += TASK_DETAIL_CONCURRENCY) {
    hydrated.push(
      ...(await Promise.all(
        tasks.slice(offset, offset + TASK_DETAIL_CONCURRENCY).map(async task => {
          try {
            return parseTasksGetResultV2026_8_1(
              await client.request('tasks.get', { taskId: task.id }),
            ).task;
          } catch (error) {
            console.warn('[SubagentGateway] Failed to load native task details', {
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return task;
          }
        }),
      )),
    );
  }
  return hydrated;
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
    byId.set(subagent.id, {
      ...previous,
      ...subagent,
      label: preferCurrentLabel ? subagent.label : previous.label,
      labelSource: preferCurrentLabel ? subagent.labelSource : previous.labelSource,
      sessionId: subagent.sessionId ?? previous.sessionId,
      task: subagent.task ?? previous.task,
      model: subagent.model ?? previous.model,
      startedAt: subagent.startedAt ?? previous.startedAt,
      endedAt: subagent.endedAt ?? previous.endedAt,
      runtimeMs: subagent.runtimeMs ?? previous.runtimeMs,
      totalTokens: subagent.totalTokens ?? previous.totalTokens,
    });
  }
  return [...byId.values()];
};

export const listPersistedGatewaySessions = async (
  client: GatewayRequestClient,
): Promise<Array<Record<string, unknown>>> => {
  const sessions: Array<Record<string, unknown>> = [];
  let offset = 0;
  const seenOffsets = new Set<number>();
  while (!seenOffsets.has(offset)) {
    seenOffsets.add(offset);
    const page = parseSessionsListResultV2026_8_1(
      await client.request('sessions.list', { limit: SESSION_PAGE_SIZE, offset }),
    );
    sessions.push(...page.sessions);
    if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) break;
    if (page.nextOffset <= offset) throw new Error('OpenClaw sessions.list cursor did not advance');
    offset = page.nextOffset;
  }
  return sessions;
};

export const listGatewaySubagentDescendants = async (
  client: GatewayRequestClient,
  rootKeys: string[],
): Promise<Array<{ sessionKey: string; sessionId: string; label: string }>> => {
  const visited = new Set(rootKeys);
  const queue = [...rootKeys];
  const descendants: Array<{ sessionKey: string; label: string }> = [];
  while (queue.length > 0) {
    const parentKey = queue.shift()!;
    for (const task of await listTaskPages(client, parentKey)) {
      const sessionKey = optionalString(task.childSessionKey);
      if (!sessionKey || visited.has(sessionKey)) continue;
      visited.add(sessionKey);
      queue.push(sessionKey);
      descendants.push({ sessionKey, label: resolveTaskTitle(task).label });
    }
  }

  const result: Array<{ sessionKey: string; sessionId: string; label: string }> = [];
  for (let offset = 0; offset < descendants.length; offset += TASK_DETAIL_CONCURRENCY) {
    result.push(
      ...(await Promise.all(
        descendants.slice(offset, offset + TASK_DETAIL_CONCURRENCY).map(async descendant => {
          const described = await client.request<{
            session?: Record<string, unknown> | null;
          }>('sessions.describe', { key: descendant.sessionKey });
          const sessionId = optionalString(described.session?.sessionId);
          if (!sessionId) {
            throw new Error(`Gateway Session ID unavailable for ${descendant.sessionKey}`);
          }
          return { ...descendant, sessionId };
        }),
      )),
    );
  }
  return result;
};

const collectGatewaySubagents = async (
  options: ListGatewaySubagentsOptions,
): Promise<{
  subagents: GatewaySubagentProjection[];
  taskLedgerComplete: boolean;
}> => {
  const tasksById = new Map<string, OpenClawTaskSummaryV2026_8_1>();
  let complete = true;
  for (const parentKey of options.parentKeys) {
    try {
      let tasks = await listTaskPages(options.client, parentKey);
      if (options.hydrateDetails !== false) {
        tasks = await hydrateTaskDetails(options.client, tasks);
      }
      for (const task of tasks) tasksById.set(task.id, task);
    } catch (error) {
      complete = false;
      console.warn('[SubagentGateway] Failed to list native subagent tasks', {
        parentKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let subagents = [...tasksById.values()].flatMap(task => {
      const subagent = toGatewaySubagent(task);
      return subagent ? [subagent] : [];
    });
  if (options.hydrateDetails !== false && subagents.length > 0) {
    try {
      const sessions = new Map(
        (await listPersistedGatewaySessions(options.client)).map(session => [
          optionalString(session.key),
          session,
        ]),
      );
      subagents = subagents.map(subagent => {
        const session = sessions.get(subagent.sessionKey);
        if (!session) return subagent;
        return {
          ...subagent,
          sessionId: optionalString(session.sessionId) ?? subagent.sessionId,
          model: optionalString(session.model) ?? subagent.model,
          totalTokens: optionalNumber(session.totalTokens) ?? subagent.totalTokens,
        };
      });
    } catch (error) {
      console.warn('[SubagentGateway] Failed to hydrate native session details', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { subagents, taskLedgerComplete: complete };
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
  return { ...result, subagents: filterWellFormedSubagents(result.subagents) };
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
