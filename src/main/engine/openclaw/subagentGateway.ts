import type { GatewayClientLike } from '../gateway/types';
import {
  type OpenClawTaskStatusV2026_9_2,
  type OpenClawTaskSummaryV2026_9_2,
  type OpenClawTaskTerminalOutcomeV2026_9_2,
  parseSessionsListResultV2026_9_2,
  parseTasksGetResultV2026_9_2,
  parseTasksListResultV2026_9_2,
} from './wire/v2026_9_2';

export type GatewayRequestClient = Pick<GatewayClientLike, 'request'>;

export const SUBAGENT_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
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
  hydrateTaskDetails?: boolean;
  includeMalformedForRuntimeControl?: boolean;
  requireComplete?: boolean;
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

const mapTaskStatus = (
  status: OpenClawTaskStatusV2026_9_2,
  terminalOutcome?: OpenClawTaskTerminalOutcomeV2026_9_2,
): SubagentStatus => {
  switch (status) {
    case 'queued':
      return SUBAGENT_STATUSES.PENDING;
    case 'running':
      return SUBAGENT_STATUSES.RUNNING;
    case 'completed':
      return terminalOutcome === 'blocked' ? SUBAGENT_STATUSES.BLOCKED : SUBAGENT_STATUSES.DONE;
    case 'cancelled':
      return SUBAGENT_STATUSES.KILLED;
    case 'timed_out':
      return SUBAGENT_STATUSES.TIMEOUT;
    case 'failed':
      return SUBAGENT_STATUSES.FAILED;
  }
};

const resolveTaskTitle = (
  task: OpenClawTaskSummaryV2026_9_2,
): { label: string; labelSource: SubagentLabelSource } => {
  const label = optionalString(task.title);
  if (label) return { label, labelSource: SUBAGENT_LABEL_SOURCES.LABEL };
  const prompt = summarizeTask(task.prompt);
  if (prompt) return { label: prompt, labelSource: SUBAGENT_LABEL_SOURCES.TASK };
  return { label: task.id, labelSource: SUBAGENT_LABEL_SOURCES.TASK_NAME };
};

const isSubagentTask = (task: OpenClawTaskSummaryV2026_9_2): boolean =>
  task.runtime === 'subagent' || task.kind === 'subagent';

const toGatewaySubagent = (
  task: OpenClawTaskSummaryV2026_9_2,
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
  const startedAt = toTimestamp(task.startedAt);
  const updatedAt = toTimestamp(
    typeof task.updatedAt === 'string' || typeof task.updatedAt === 'number'
      ? task.updatedAt
      : undefined,
  );
  const endedAt = toTimestamp(task.endedAt);
  return {
    id: task.id,
    taskName: task.id,
    sessionKey,
    ...resolveTaskTitle(task),
    status: mapTaskStatus(task.status, task.terminalOutcome),
    task: optionalString(task.prompt) ?? optionalString(task.title),
    runId: optionalString(task.runId),
    startedAt,
    updatedAt,
    endedAt,
    ...(startedAt !== undefined && endedAt !== undefined
      ? { runtimeMs: Math.max(0, endedAt - startedAt) }
      : {}),
    progressSummary: optionalString(task.progressSummary),
    terminalSummary: optionalString(task.terminalSummary),
    error: optionalString(task.error),
    lastActivity: optionalString(task.lastActivity),
    lastToolName: optionalString(task.lastToolName),
    toolUseCount: optionalNumber(task.toolUseCount),
  };
};

const listTaskPages = async (
  client: GatewayRequestClient,
  sessionKey: string,
): Promise<OpenClawTaskSummaryV2026_9_2[]> => {
  const tasks: OpenClawTaskSummaryV2026_9_2[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    if (cursor && seenCursors.has(cursor)) {
      throw new Error('OpenClaw tasks.list returned a repeated cursor');
    }
    if (cursor) seenCursors.add(cursor);
    const page = parseTasksListResultV2026_9_2(
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
  tasks: OpenClawTaskSummaryV2026_9_2[],
): Promise<OpenClawTaskSummaryV2026_9_2[]> => {
  const hydrated: OpenClawTaskSummaryV2026_9_2[] = [];
  for (let offset = 0; offset < tasks.length; offset += TASK_DETAIL_CONCURRENCY) {
    hydrated.push(
      ...(await Promise.all(
        tasks.slice(offset, offset + TASK_DETAIL_CONCURRENCY).map(async task => {
          try {
            return parseTasksGetResultV2026_9_2(
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

export const listPersistedGatewaySessions = async (
  client: GatewayRequestClient,
): Promise<Array<Record<string, unknown>>> => {
  const sessions: Array<Record<string, unknown>> = [];
  let offset = 0;
  const seenOffsets = new Set<number>();
  while (!seenOffsets.has(offset)) {
    seenOffsets.add(offset);
    const page = parseSessionsListResultV2026_9_2(
      await client.request('sessions.list', {
        limit: SESSION_PAGE_SIZE,
        offset,
        archived: 'all',
      }),
    );
    sessions.push(...page.sessions);
    if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) break;
    if (page.nextOffset <= offset) throw new Error('OpenClaw sessions.list cursor did not advance');
    offset = page.nextOffset;
  }
  return sessions;
};

const readSessionModelReference = (session: Record<string, unknown>): string | undefined => {
  const provider = optionalString(session.modelProvider);
  const model = optionalString(session.model);
  if (!model) return undefined;
  return provider && !model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
    ? `${provider}/${model}`
    : model;
};

const SESSION_STATUS_MAP: Record<string, SubagentStatus> = {
  queued: SUBAGENT_STATUSES.PENDING,
  running: SUBAGENT_STATUSES.RUNNING,
  done: SUBAGENT_STATUSES.DONE,
  failed: SUBAGENT_STATUSES.FAILED,
  killed: SUBAGENT_STATUSES.KILLED,
  timeout: SUBAGENT_STATUSES.TIMEOUT,
};

const readSessionActiveRunId = (
  session: Record<string, unknown>,
  excludingRunId?: string,
): string | undefined => {
  const candidates = [
    optionalString(session.lifecycleRunId),
    ...(Array.isArray(session.activeRunIds) ? session.activeRunIds.map(optionalString) : []),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && (excludingRunId === undefined || candidate !== excludingRunId),
  );
};

const readSessionRunId = (session: Record<string, unknown>): string | undefined =>
  readSessionActiveRunId(session) ?? optionalString(session.lastRunId);

const hydrateSubagentFromSession = (
  subagent: GatewaySubagent,
  session: Record<string, unknown> | undefined,
): GatewaySubagent => {
  if (!session) return subagent;
  const sessionId = optionalString(session.sessionId);
  const model = readSessionModelReference(session);
  const totalTokens = optionalNumber(session.totalTokens);
  const sessionStatus = optionalString(session.status);
  const taskIsTerminal =
    subagent.status !== SUBAGENT_STATUSES.PENDING &&
    subagent.status !== SUBAGENT_STATUSES.RUNNING;
  const replacementRunId = taskIsTerminal
    ? readSessionActiveRunId(session, subagent.runId)
    : undefined;
  const sessionRunId = replacementRunId ?? readSessionRunId(session);
  const projectedStatus = sessionStatus ? SESSION_STATUS_MAP[sessionStatus] : undefined;
  const active =
    session.subagentRunState === 'active' ||
    projectedStatus === SUBAGENT_STATUSES.PENDING ||
    projectedStatus === SUBAGENT_STATUSES.RUNNING;
  const startedAt = toTimestamp(
    typeof session.startedAt === 'string' || typeof session.startedAt === 'number'
      ? session.startedAt
      : undefined,
  );
  const endedAt = toTimestamp(
    typeof session.endedAt === 'string' || typeof session.endedAt === 'number'
      ? session.endedAt
      : undefined,
  );
  const runtimeMs = optionalNumber(session.runtimeMs);
  const updatedAt = toTimestamp(
    typeof session.updatedAt === 'string' || typeof session.updatedAt === 'number'
      ? session.updatedAt
      : undefined,
  );
  // A terminal task event can land before sessions.list/describe catches up.
  // Only let the Session lifecycle override task state when its revision is at
  // least as new. A newer active Session row is authoritative for follow-ups.
  const equalRevisionReplacement =
    active &&
    taskIsTerminal &&
    subagent.runId !== undefined &&
    replacementRunId !== undefined;
  const sessionLifecycleIsCurrent =
    updatedAt !== undefined &&
    (subagent.updatedAt === undefined ||
      updatedAt > subagent.updatedAt ||
      (updatedAt === subagent.updatedAt && (!active || !taskIsTerminal || equalRevisionReplacement)));
  const useActiveSessionLifecycle = active && sessionLifecycleIsCurrent;
  const status = sessionLifecycleIsCurrent
    ? useActiveSessionLifecycle
      ? (projectedStatus ?? SUBAGENT_STATUSES.RUNNING)
      : projectedStatus === SUBAGENT_STATUSES.DONE &&
          subagent.status === SUBAGENT_STATUSES.BLOCKED
        ? SUBAGENT_STATUSES.BLOCKED
        : (projectedStatus ?? subagent.status)
    : subagent.status;
  const hydrated: GatewaySubagent = {
    ...subagent,
    status,
    ...(sessionLifecycleIsCurrent && sessionRunId ? { runId: sessionRunId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(sessionLifecycleIsCurrent && startedAt !== undefined ? { startedAt } : {}),
    ...(sessionLifecycleIsCurrent && updatedAt !== undefined ? { updatedAt } : {}),
    ...(sessionLifecycleIsCurrent && runtimeMs !== undefined
      ? {
          runtimeMs,
          ...(status === SUBAGENT_STATUSES.RUNNING ? { runtimeSampledAt: Date.now() } : {}),
        }
      : {}),
    ...(sessionLifecycleIsCurrent && !active && endedAt !== undefined ? { endedAt } : {}),
  };
  if (useActiveSessionLifecycle) {
    delete hydrated.endedAt;
    delete hydrated.terminalSummary;
    delete hydrated.error;
  } else if (
    hydrated.status !== SUBAGENT_STATUSES.PENDING &&
    hydrated.status !== SUBAGENT_STATUSES.RUNNING
  ) {
    delete hydrated.runtimeSampledAt;
  }
  return hydrated;
};

export const getGatewaySubagentDetails = async (
  client: GatewayRequestClient,
  taskId: string,
): Promise<GatewaySubagent | null> => {
  const task = parseTasksGetResultV2026_9_2(
    await client.request('tasks.get', { taskId }),
  ).task;
  if (!isSubagentTask(task)) return null;
  const subagent = toGatewaySubagent(task);
  if (!subagent || typeof subagent.label !== 'string' || !subagent.labelSource) return null;
  const wellFormedSubagent: GatewaySubagent = {
    ...subagent,
    label: subagent.label,
    labelSource: subagent.labelSource,
  };
  const described = await client.request<{ session?: Record<string, unknown> | null }>(
    'sessions.describe',
    { key: wellFormedSubagent.sessionKey },
  );
  let session = described.session ?? undefined;
  const taskUpdatedAt = wellFormedSubagent.updatedAt;
  const sessionUpdatedAt = session
    ? toTimestamp(
        typeof session.updatedAt === 'string' || typeof session.updatedAt === 'number'
          ? session.updatedAt
          : undefined,
      )
    : undefined;
  const taskIsTerminal =
    wellFormedSubagent.status !== SUBAGENT_STATUSES.PENDING &&
    wellFormedSubagent.status !== SUBAGENT_STATUSES.RUNNING;
  const sessionAppearsActive =
    session?.subagentRunState === 'active' ||
    session?.status === 'queued' ||
    session?.status === 'running';
  // sessions.describe does not project activeRunIds in OpenClaw v2026.9.2.
  // Resolve the rare same-millisecond terminal/replacement ambiguity through
  // sessions.list, whose async projection includes the active run identity.
  if (
    session &&
    taskIsTerminal &&
    sessionAppearsActive &&
    taskUpdatedAt !== undefined &&
    sessionUpdatedAt === taskUpdatedAt &&
    !readSessionActiveRunId(session, wellFormedSubagent.runId)
  ) {
    try {
      const listed = (await listPersistedGatewaySessions(client)).find(
        candidate => optionalString(candidate.key) === wellFormedSubagent.sessionKey,
      );
      if (listed) session = listed;
    } catch (error) {
      // This lookup only disambiguates a same-revision replacement. The task's
      // terminal state remains the safe result when the optional list fails.
      console.warn('[OpenClawSubagents] Failed to resolve replacement run identity', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return hydrateSubagentFromSession(wellFormedSubagent, session);
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
  const tasksById = new Map<string, OpenClawTaskSummaryV2026_9_2>();
  let complete = true;
  for (const parentKey of options.parentKeys) {
    try {
      let tasks = await listTaskPages(options.client, parentKey);
      if (options.hydrateDetails !== false && options.hydrateTaskDetails !== false) {
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
      const sessions = new Map<string, Record<string, unknown>>();
      for (let offset = 0; offset < subagents.length; offset += TASK_DETAIL_CONCURRENCY) {
        const described = await Promise.all(
          subagents.slice(offset, offset + TASK_DETAIL_CONCURRENCY).map(async subagent => {
            const result = await options.client.request<{
              session?: Record<string, unknown> | null;
            }>('sessions.describe', { key: subagent.sessionKey });
            return [subagent.sessionKey, result.session] as const;
          }),
        );
        for (const [sessionKey, session] of described) {
          if (session) sessions.set(sessionKey, session);
        }
      }

      // sessions.describe omits activeRunIds. Only the same-revision terminal
      // replacement ambiguity needs the heavier persisted-session projection.
      const ambiguousReplacementKeys = new Set(
        subagents.flatMap(subagent => {
          const session = sessions.get(subagent.sessionKey);
          if (!session) return [];
          const taskIsTerminal =
            subagent.status !== SUBAGENT_STATUSES.PENDING &&
            subagent.status !== SUBAGENT_STATUSES.RUNNING;
          const sessionAppearsActive =
            session.subagentRunState === 'active' ||
            session.status === 'queued' ||
            session.status === 'running';
          const sessionUpdatedAt = toTimestamp(
            typeof session.updatedAt === 'string' || typeof session.updatedAt === 'number'
              ? session.updatedAt
              : undefined,
          );
          return taskIsTerminal &&
            sessionAppearsActive &&
            subagent.updatedAt !== undefined &&
            sessionUpdatedAt === subagent.updatedAt &&
            !readSessionActiveRunId(session, subagent.runId)
            ? [subagent.sessionKey]
            : [];
        }),
      );
      if (ambiguousReplacementKeys.size > 0) {
        try {
          for (const session of await listPersistedGatewaySessions(options.client)) {
            const sessionKey = optionalString(session.key);
            if (!sessionKey || !ambiguousReplacementKeys.has(sessionKey)) continue;
            const described = sessions.get(sessionKey);
            if (!described) continue;
            sessions.set(sessionKey, {
              ...described,
              ...(session.lifecycleRunId !== undefined
                ? { lifecycleRunId: session.lifecycleRunId }
                : {}),
              ...(session.activeRunIds !== undefined ? { activeRunIds: session.activeRunIds } : {}),
            });
          }
        } catch (error) {
          console.warn('[SubagentGateway] Failed to resolve replacement run identity', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      subagents = subagents.map(subagent => {
        const session = sessions.get(subagent.sessionKey);
        if (!session) return subagent;
        return hydrateSubagentFromSession(subagent as GatewaySubagent, session);
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
  if (options.requireComplete && !result.taskLedgerComplete) {
    throw new Error('OpenClaw descendant discovery is incomplete; session stop was not confirmed.');
  }
  return options.includeMalformedForRuntimeControl
    ? result.subagents
    : filterWellFormedSubagents(result.subagents);
}
