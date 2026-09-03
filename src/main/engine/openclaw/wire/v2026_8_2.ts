export const OPENCLAW_WIRE_VERSION = 'v2026.8.2' as const;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} must be a string`);
  }
  return value;
};

const optionalNonNegativeInteger = (
  value: unknown,
  field: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} must be a non-negative integer`);
  }
  return value as number;
};

export type OpenClawSessionRowV2026_8_2 = {
  key: string;
  modelProvider?: string;
  model?: string;
  [key: string]: unknown;
};

export type OpenClawSessionsListResultV2026_8_2 = {
  sessions: OpenClawSessionRowV2026_8_2[];
  nextOffset?: number | null;
  hasMore?: boolean;
};

export const parseSessionsListResultV2026_8_2 = (
  value: unknown,
): OpenClawSessionsListResultV2026_8_2 => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.list returned an invalid payload`);
  }
  const sessions = value.sessions.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new Error(
        `${OPENCLAW_WIRE_VERSION} sessions.list sessions[${index}] is missing key`,
      );
    }
    return {
      ...entry,
      key: entry.key,
      modelProvider: optionalString(
        entry.modelProvider,
        `sessions.list sessions[${index}].modelProvider`,
      ),
      model: optionalString(entry.model, `sessions.list sessions[${index}].model`),
    };
  });
  const nextOffset =
    value.nextOffset === null
      ? null
      : optionalNonNegativeInteger(value.nextOffset, 'sessions.list nextOffset');
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.list hasMore must be a boolean`);
  }
  return {
    sessions,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(typeof value.hasMore === 'boolean' ? { hasMore: value.hasMore } : {}),
  };
};

export const parseModelReferenceV2026_8_2 = (
  value: unknown,
): { provider: string; model: string; reference: string } | null => {
  const reference =
    typeof value === 'string'
      ? value.trim()
      : isRecord(value) && typeof value.primary === 'string'
        ? value.primary.trim()
        : '';
  const separator = reference.indexOf('/');
  if (separator <= 0 || separator === reference.length - 1) return null;
  return {
    provider: reference.slice(0, separator),
    model: reference.slice(separator + 1),
    reference,
  };
};

export type OpenClawChatHistoryResultV2026_8_2 = {
  messages: unknown[];
  hasMore: boolean;
  nextOffset?: number;
};

export const parseChatHistoryResultV2026_8_2 = (
  value: unknown,
): OpenClawChatHistoryResultV2026_8_2 => {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history returned an invalid payload`);
  }
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history hasMore must be a boolean`);
  }
  const hasMore = value.hasMore === true;
  const nextOffset = optionalNonNegativeInteger(value.nextOffset, 'chat.history nextOffset');
  if (hasMore && nextOffset === undefined) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history omitted nextOffset for a partial page`);
  }
  return {
    messages: value.messages,
    hasMore,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
};

export type OpenClawHistoryDetailsResultV2026_8_2 = {
  toolInputs: Record<string, { name?: string; input: unknown }>;
  compactionDetails: Record<
    string,
    { summary?: string; tokensBefore?: number; tokensAfter?: number }
  >;
};

export const parseHistoryDetailsResultV2026_8_2 = (
  value: unknown,
): OpenClawHistoryDetailsResultV2026_8_2 => {
  if (!isRecord(value) || !isRecord(value.toolInputs) || !isRecord(value.compactionDetails)) {
    throw new Error(
      `${OPENCLAW_WIRE_VERSION} justdoRuntimeBridge.historyDetails returned an invalid payload`,
    );
  }
  const toolInputs: OpenClawHistoryDetailsResultV2026_8_2['toolInputs'] = {};
  for (const [id, detail] of Object.entries(value.toolInputs)) {
    if (!isRecord(detail) || !Object.hasOwn(detail, 'input')) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} history tool input ${id} is malformed`);
    }
    const name = optionalString(detail.name, `history tool input ${id}.name`);
    toolInputs[id] = { ...(name ? { name } : {}), input: detail.input };
  }
  const compactionDetails: OpenClawHistoryDetailsResultV2026_8_2['compactionDetails'] = {};
  for (const [id, detail] of Object.entries(value.compactionDetails)) {
    if (!isRecord(detail)) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} compaction detail ${id} is malformed`);
    }
    const summary = optionalString(detail.summary, `compaction detail ${id}.summary`);
    const tokensBefore =
      detail.tokensBefore === undefined
        ? undefined
        : optionalNonNegativeInteger(detail.tokensBefore, `compaction detail ${id}.tokensBefore`);
    const tokensAfter =
      detail.tokensAfter === undefined
        ? undefined
        : optionalNonNegativeInteger(detail.tokensAfter, `compaction detail ${id}.tokensAfter`);
    compactionDetails[id] = {
      ...(summary ? { summary } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    };
  }
  return { toolInputs, compactionDetails };
};

export const OPENCLAW_TASK_STATUSES_V2026_8_2 = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type OpenClawTaskStatusV2026_8_2 =
  (typeof OPENCLAW_TASK_STATUSES_V2026_8_2)[number];

export type OpenClawTaskSummaryV2026_8_2 = {
  id: string;
  status: OpenClawTaskStatusV2026_8_2;
  runtime?: string;
  kind?: string;
  title?: string;
  sessionKey?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  runId?: string;
  agentId?: string;
  createdAt?: string | number;
  startedAt?: string | number;
  endedAt?: string | number;
  prompt?: string;
  result?: string;
  error?: string;
  [key: string]: unknown;
};

const parseTaskTimestamp = (value: unknown, field: string): string | number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || (Number.isInteger(value) && (value as number) >= 0)) {
    return value as string | number;
  }
  throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} is not a timestamp`);
};

export const parseTaskSummaryV2026_8_2 = (
  value: unknown,
  field = 'task',
): OpenClawTaskSummaryV2026_8_2 => {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} is missing id`);
  }
  if (
    typeof value.status !== 'string' ||
    !OPENCLAW_TASK_STATUSES_V2026_8_2.includes(value.status as OpenClawTaskStatusV2026_8_2)
  ) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} has an invalid status`);
  }
  const strings = Object.fromEntries(
    ['runtime', 'kind', 'title', 'sessionKey', 'childSessionKey', 'parentTaskId', 'runId', 'agentId', 'prompt', 'result', 'error']
      .map(key => [key, optionalString(value[key], `${field}.${key}`)] as const)
      .filter(([, entry]) => entry !== undefined),
  );
  return {
    ...value,
    id: value.id,
    status: value.status as OpenClawTaskStatusV2026_8_2,
    ...strings,
    createdAt: parseTaskTimestamp(value.createdAt, `${field}.createdAt`),
    startedAt: parseTaskTimestamp(value.startedAt, `${field}.startedAt`),
    endedAt: parseTaskTimestamp(value.endedAt, `${field}.endedAt`),
  };
};

export const parseTasksListResultV2026_8_2 = (
  value: unknown,
): { tasks: OpenClawTaskSummaryV2026_8_2[]; nextCursor?: string } => {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} tasks.list returned an invalid payload`);
  }
  const nextCursor = optionalString(value.nextCursor, 'tasks.list nextCursor');
  return {
    tasks: value.tasks.map((task, index) =>
      parseTaskSummaryV2026_8_2(task, `tasks.list tasks[${index}]`),
    ),
    ...(nextCursor ? { nextCursor } : {}),
  };
};

export const parseTasksGetResultV2026_8_2 = (
  value: unknown,
): { task: OpenClawTaskSummaryV2026_8_2 } => {
  if (!isRecord(value)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} tasks.get returned an invalid payload`);
  }
  return { task: parseTaskSummaryV2026_8_2(value.task, 'tasks.get task') };
};

export type OpenClawTaskEventV2026_8_2 =
  | { action: 'upserted'; task: OpenClawTaskSummaryV2026_8_2 }
  | { action: 'deleted'; taskId: string }
  | { action: 'restored' };

export const parseTaskEventV2026_8_2 = (value: unknown): OpenClawTaskEventV2026_8_2 => {
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} task event returned an invalid payload`);
  }
  if (value.action === 'upserted') {
    return { action: 'upserted', task: parseTaskSummaryV2026_8_2(value.task, 'task event task') };
  }
  if (value.action === 'deleted') {
    if (typeof value.taskId !== 'string' || !value.taskId) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} deleted task event is missing taskId`);
    }
    return { action: 'deleted', taskId: value.taskId };
  }
  if (value.action === 'restored') return { action: 'restored' };
  throw new Error(`${OPENCLAW_WIRE_VERSION} task event has an invalid action`);
};
