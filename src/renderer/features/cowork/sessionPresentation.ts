import type {
  CoworkSession,
  CoworkSessionSummary,
  TokenUsage,
} from '@/features/cowork/coworkTypes';

export type SessionDateGroupKey =
  'pinned' | 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'earlier';

export interface SessionDateGroup {
  key: SessionDateGroupKey;
  sessions: CoworkSessionSummary[];
}

export interface SessionDetailStats {
  summary: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  models: string[];
  tokenUsage: Required<TokenUsage>;
  hasTokenUsage: boolean;
}

const DATE_GROUP_ORDER: SessionDateGroupKey[] = [
  'pinned',
  'today',
  'yesterday',
  'previous7Days',
  'previous30Days',
  'earlier',
];

const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary): number => {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt;
};

const localCalendarDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
};

export const getSessionDateGroupKey = (
  session: CoworkSessionSummary,
  now: number = Date.now(),
): SessionDateGroupKey => {
  if (session.pinned) return 'pinned';

  const dayDifference = localCalendarDay(now) - localCalendarDay(session.updatedAt);
  if (dayDifference <= 0) return 'today';
  if (dayDifference === 1) return 'yesterday';
  if (dayDifference <= 7) return 'previous7Days';
  if (dayDifference <= 30) return 'previous30Days';
  return 'earlier';
};

export const groupSessionsByDate = (
  sessions: CoworkSessionSummary[],
  now: number = Date.now(),
): SessionDateGroup[] => {
  const grouped = new Map<SessionDateGroupKey, CoworkSessionSummary[]>();
  for (const session of sessions) {
    const key = getSessionDateGroupKey(session, now);
    const values = grouped.get(key) ?? [];
    values.push(session);
    grouped.set(key, values);
  }

  return DATE_GROUP_ORDER.flatMap(key => {
    const values = grouped.get(key);
    return values?.length ? [{ key, sessions: values.sort(sortByRecentActivity) }] : [];
  });
};

const normalizeSummary = (content: string): string | null => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}...` : normalized;
};

const addTokenValue = (total: number, value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? total + value : total;

export const buildSessionDetailStats = (session: CoworkSession): SessionDetailStats => {
  const tokenUsage: Required<TokenUsage> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const models = new Set<string>();
  const userMessageIds = new Set<string>();
  const assistantMessageIds = new Set<string>();
  const toolCallIds = new Set<string>();
  const assistantUsageFingerprints = new Set<string>();
  let hasTokenUsage = false;

  for (const message of session.messages) {
    const metadataModelName =
      typeof message.metadata?.modelName === 'string' ? message.metadata.modelName.trim() : '';
    const modelName = message.modelName?.trim() || metadataModelName;
    if (modelName) models.add(modelName);

    if (message.type === 'user' && message.content.trim()) userMessageIds.add(message.id);
    if (message.type === 'assistant' && message.content.trim()) assistantMessageIds.add(message.id);
    if (message.type === 'tool_use') {
      const toolUseId = message.metadata?.toolUseId;
      toolCallIds.add(typeof toolUseId === 'string' && toolUseId.trim() ? toolUseId : message.id);
    }

    if (!message.usage) continue;
    const hasRecordedTokenValue = Object.values(message.usage).some(
      value => typeof value === 'number' && Number.isFinite(value),
    );
    if (!hasRecordedTokenValue) continue;
    if (message.type === 'assistant') {
      const usageFingerprint = JSON.stringify([
        message.content.trim(),
        message.usage.input ?? null,
        message.usage.output ?? null,
        message.usage.cacheRead ?? null,
        message.usage.cacheWrite ?? null,
      ]);
      if (assistantUsageFingerprints.has(usageFingerprint)) continue;
      assistantUsageFingerprints.add(usageFingerprint);
    }
    hasTokenUsage = true;
    tokenUsage.input = addTokenValue(tokenUsage.input, message.usage.input);
    tokenUsage.output = addTokenValue(tokenUsage.output, message.usage.output);
    tokenUsage.cacheRead = addTokenValue(tokenUsage.cacheRead, message.usage.cacheRead);
    tokenUsage.cacheWrite = addTokenValue(tokenUsage.cacheWrite, message.usage.cacheWrite);
  }

  const summary = session.messages
    .filter(message => message.type === 'user')
    .map(message => normalizeSummary(message.content))
    .find((value): value is string => value !== null);
  const userMessageCount = userMessageIds.size;
  const assistantMessageCount = assistantMessageIds.size;

  return {
    summary: summary ?? null,
    messageCount: userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount: toolCallIds.size,
    models: [...models],
    tokenUsage,
    hasTokenUsage,
  };
};
