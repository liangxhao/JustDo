import type { ChatTranscriptState, HistorySource } from './chat-transcript-state';

export interface HistoryRequestIdentity {
  sessionKey: string;
  sessionId: string | null;
  historyGeneration: number;
}

export interface HistoryReconciliationResult {
  accepted: boolean;
  messages: unknown[];
  persistedToolCallIds: Set<string>;
  reason?: 'stale-request' | 'lower-authority' | 'regressive-tail';
}

const SOURCE_AUTHORITY: Record<HistorySource, number> = {
  optimistic: 0,
  'sqlite-fallback': 1,
  gateway: 2,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageRole(message: unknown): string {
  const record = asRecord(message);
  return typeof record?.role === 'string' ? record.role.toLowerCase() : '';
}

function messageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) return typeof message === 'string' ? message : '';
  if (typeof record.content === 'string') return record.content.trim();
  if (typeof record.text === 'string') return record.text.trim();
  if (!Array.isArray(record.content)) return '';
  return record.content
    .map(block => {
      const value = asRecord(block);
      return typeof value?.text === 'string' ? value.text : '';
    })
    .join('')
    .trim();
}

function durableMessageId(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  for (const key of ['entryId', 'messageId', 'id', 'seq']) {
    const value = record[key];
    if (typeof value === 'string' && value) return `${key}:${value}`;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return `${key}:${value}`;
  }
  return null;
}

export function deterministicHistoryKey(message: unknown, index: number): string {
  const durable = durableMessageId(message);
  if (durable) return `history:${durable}`;
  const text = messageText(message);
  let hash = 2166136261;
  const source = `${messageRole(message)}\0${text}`;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `history:fallback:${(hash >>> 0).toString(36)}:${index}`;
}

export function extractToolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const key of ['toolCallId', 'tool_call_id', 'tool_use_id']) {
      const id = record[key];
      if (typeof id === 'string' && id) ids.add(id);
    }
    if (record.content !== value) visit(record.content);
    if (record.tool_calls !== value) visit(record.tool_calls);
  };
  messages.forEach(visit);
  return ids;
}

function isRegressive(previous: unknown[], next: unknown[]): boolean {
  if (next.length >= previous.length || next.length === 0) return false;
  for (let index = 0; index < next.length; index += 1) {
    const previousKey = deterministicHistoryKey(previous[index], index);
    const nextKey = deterministicHistoryKey(next[index], index);
    if (previousKey !== nextKey) return false;
  }
  return true;
}

export function reconcileHistory(
  state: ChatTranscriptState,
  params: {
    request: HistoryRequestIdentity;
    source: HistorySource;
    messages: unknown[];
  },
): HistoryReconciliationResult {
  if (
    params.request.sessionKey !== state.sessionKey ||
    params.request.historyGeneration !== state.historyGeneration ||
    (params.request.sessionId && state.sessionId && params.request.sessionId !== state.sessionId)
  ) {
    return {
      accepted: false,
      messages: state.persistedMessages,
      persistedToolCallIds: extractToolCallIds(state.persistedMessages),
      reason: 'stale-request',
    };
  }
  if (SOURCE_AUTHORITY[params.source] < SOURCE_AUTHORITY[state.historySource]) {
    return {
      accepted: false,
      messages: state.persistedMessages,
      persistedToolCallIds: extractToolCallIds(state.persistedMessages),
      reason: 'lower-authority',
    };
  }
  if (
    params.source === 'gateway' &&
    state.historySource === 'gateway' &&
    isRegressive(state.persistedMessages, params.messages)
  ) {
    return {
      accepted: false,
      messages: state.persistedMessages,
      persistedToolCallIds: extractToolCallIds(state.persistedMessages),
      reason: 'regressive-tail',
    };
  }

  state.persistedMessages = params.messages;
  state.historySource = params.source;
  state.revision += 1;
  return {
    accepted: true,
    messages: params.messages,
    persistedToolCallIds: extractToolCallIds(params.messages),
  };
}
