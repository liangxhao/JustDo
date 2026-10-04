export const OPENCLAW_WIRE_VERSION = 'v2026.9.8' as const;

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

const optionalNonNegativeInteger = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} ${field} must be a non-negative integer`);
  }
  return value as number;
};

export type OpenClawSessionRowV2026_9_8 = {
  key: string;
  modelProvider?: string;
  model?: string;
  [key: string]: unknown;
};

export type OpenClawSessionsListResultV2026_9_8 = {
  sessions: OpenClawSessionRowV2026_9_8[];
  nextOffset?: number | null;
  hasMore?: boolean;
};

export const parseSessionsListResultV2026_9_8 = (
  value: unknown,
): OpenClawSessionsListResultV2026_9_8 => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.list returned an invalid payload`);
  }
  const sessions = value.sessions.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || entry.key.length === 0) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.list sessions[${index}] is missing key`);
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

export type OpenClawSessionsSearchHitV2026_9_8 = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  snippet: string;
  score: number;
};

export type OpenClawSessionsSearchResultV2026_9_8 = {
  results: OpenClawSessionsSearchHitV2026_9_8[];
  indexing: boolean;
  truncated: boolean;
};

export const parseSessionsSearchResultV2026_9_8 = (
  value: unknown,
): OpenClawSessionsSearchResultV2026_9_8 => {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.search returned an invalid payload`);
  }
  if (value.results.length > 25) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.search returned more than 25 results`);
  }
  const results = value.results.map((entry, index): OpenClawSessionsSearchHitV2026_9_8 => {
    if (
      !isRecord(entry) ||
      typeof entry.sessionKey !== 'string' ||
      !entry.sessionKey ||
      typeof entry.sessionId !== 'string' ||
      !entry.sessionId ||
      typeof entry.messageId !== 'string' ||
      !entry.messageId ||
      (entry.role !== 'user' && entry.role !== 'assistant') ||
      !Number.isInteger(entry.timestamp) ||
      (entry.timestamp as number) < 0 ||
      typeof entry.snippet !== 'string' ||
      entry.snippet.length > 501 ||
      typeof entry.score !== 'number' ||
      !Number.isFinite(entry.score)
    ) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.search results[${index}] is malformed`);
    }
    return {
      sessionKey: entry.sessionKey,
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      role: entry.role,
      timestamp: entry.timestamp as number,
      snippet: entry.snippet,
      score: entry.score,
    };
  });
  if (value.indexing !== undefined && typeof value.indexing !== 'boolean') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.search indexing must be a boolean`);
  }
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} sessions.search truncated must be a boolean`);
  }
  return {
    results,
    indexing: value.indexing === true,
    truncated: value.truncated === true,
  };
};

export const parseModelReferenceV2026_9_8 = (
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

export type OpenClawChatHistoryResultV2026_9_8 = {
  messages: unknown[];
  activity?: unknown[];
  hasMore: boolean;
  nextOffset?: number;
  totalMessages?: number;
  deltaCursor?: string;
};

const parseChatHistoryActivity = (value: unknown): unknown[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      entry =>
        !isRecord(entry) ||
        typeof entry.messageId !== 'string' ||
        !Array.isArray(entry.items) ||
        entry.items.some(item => !isRecord(item)),
    )
  ) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history activity is malformed`);
  }
  return value;
};

export const parseChatHistoryResultV2026_9_8 = (
  value: unknown,
): OpenClawChatHistoryResultV2026_9_8 => {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history returned an invalid payload`);
  }
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history hasMore must be a boolean`);
  }
  const hasMore = value.hasMore === true;
  const activity = parseChatHistoryActivity(value.activity);
  const nextOffset = optionalNonNegativeInteger(value.nextOffset, 'chat.history nextOffset');
  const totalMessages = optionalNonNegativeInteger(
    value.totalMessages,
    'chat.history totalMessages',
  );
  const deltaCursor = optionalString(value.deltaCursor, 'chat.history deltaCursor');
  if (hasMore && nextOffset === undefined) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history omitted nextOffset for a partial page`);
  }
  return {
    messages: value.messages,
    ...(activity ? { activity } : {}),
    hasMore,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(totalMessages !== undefined ? { totalMessages } : {}),
    ...(deltaCursor !== undefined ? { deltaCursor } : {}),
  };
};

export type OpenClawChatHistoryCursorResultV2026_9_8 =
  | { kind: 'reset' }
  | { kind: 'delta'; messages: unknown[]; activity?: unknown[]; deltaCursor: string };

export const parseChatHistoryCursorResultV2026_9_8 = (
  value: unknown,
): OpenClawChatHistoryCursorResultV2026_9_8 => {
  if (!isRecord(value)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history cursor returned an invalid payload`);
  }
  if (value.kind === 'reset') return { kind: 'reset' };
  if (value.kind !== 'delta' || !Array.isArray(value.messages)) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history cursor returned an invalid outcome`);
  }
  const deltaCursor = optionalString(value.deltaCursor, 'chat.history cursor deltaCursor');
  if (deltaCursor === undefined) {
    throw new Error(`${OPENCLAW_WIRE_VERSION} chat.history delta omitted deltaCursor`);
  }
  const activity = parseChatHistoryActivity(value.activity);
  return {
    kind: 'delta',
    messages: value.messages,
    deltaCursor,
    ...(activity ? { activity } : {}),
  };
};

export type OpenClawHistoryDetailsResultV2026_9_8 = {
  toolInputs: Record<string, { name?: string; input: unknown }>;
  compactionDetails: Record<
    string,
    { summary?: string; tokensBefore?: number; tokensAfter?: number }
  >;
};

export const parseHistoryDetailsResultV2026_9_8 = (
  value: unknown,
): OpenClawHistoryDetailsResultV2026_9_8 => {
  if (!isRecord(value) || !isRecord(value.toolInputs) || !isRecord(value.compactionDetails)) {
    throw new Error(
      `${OPENCLAW_WIRE_VERSION} runtimeServices.historyDetails returned an invalid payload`,
    );
  }
  const toolInputs: OpenClawHistoryDetailsResultV2026_9_8['toolInputs'] = {};
  for (const [id, detail] of Object.entries(value.toolInputs)) {
    if (!isRecord(detail) || !Object.hasOwn(detail, 'input')) {
      throw new Error(`${OPENCLAW_WIRE_VERSION} history tool input ${id} is malformed`);
    }
    const name = optionalString(detail.name, `history tool input ${id}.name`);
    toolInputs[id] = { ...(name ? { name } : {}), input: detail.input };
  }
  const compactionDetails: OpenClawHistoryDetailsResultV2026_9_8['compactionDetails'] = {};
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
