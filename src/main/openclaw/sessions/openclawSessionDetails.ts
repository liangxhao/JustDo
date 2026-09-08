import {
  isSessionDetailModelVisible,
  type SessionDetailStats,
  type SessionDetailTokenUsage,
  sumSessionDetailTokenUsage,
} from '../../../shared/cowork/sessionDetails';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { extractGatewayHistoryEntries } from './openclawHistory';
import { extractOpenClawTokenUsage } from './openclawTokenUsage';

export type GatewaySessionUsageLoader = (
  sessionKey: string,
  revision?: number,
) => Promise<unknown | null>;
export type GatewaySessionHistoryLoader = (
  sessionKey: string,
  fallbackSessionId?: string,
  revision?: number,
) => Promise<unknown[] | null>;

interface GatewaySessionUsageRequestOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  cacheDiscriminator?: number;
}

const DEFAULT_USAGE_CACHE_MAX_ATTEMPTS = 21;
const DEFAULT_USAGE_CACHE_RETRY_DELAY_MS = 250;
let usageRequestSequence = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readMessageCount = (
  counts: Record<string, unknown> | undefined,
  key: string,
): number => nonNegativeNumber(counts?.[key]) ?? 0;

const readModelNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const models = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const provider = nonEmptyString(item.provider);
    const model = nonEmptyString(item.model);
    if (!model) continue;
    const modelRef =
      provider && !model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
        ? `${provider}/${model}`
        : model;
    if (isSessionDetailModelVisible(modelRef)) models.add(modelRef);
  }
  return [...models];
};

const readTimestamp = (value: unknown): number | undefined => {
  const numeric = nonNegativeNumber(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined;
};

const readVisibleActivity = (
  messages: unknown[] | null | undefined,
): {
  summary: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
} | null => {
  if (!messages) return null;
  const entries = extractGatewayHistoryEntries(messages);
  const userEntries = entries.filter(entry => entry.role === 'user');
  const assistantEntries = entries.filter(entry => entry.role === 'assistant');
  const firstUserMessage = userEntries[0]?.text;
  return {
    summary: firstUserMessage ? Array.from(firstUserMessage).slice(0, 240).join('') : null,
    messageCount: userEntries.length + assistantEntries.length,
    userMessageCount: userEntries.length,
    assistantMessageCount: assistantEntries.length,
    toolCallCount: entries.filter(entry => entry.role === 'tool_use').length,
  };
};

/** Combines current-instance usage with the matching visible history projection. */
export const buildGatewaySessionDetailStats = (
  value: unknown,
  summary: string | null,
  historyMessages?: unknown[] | null,
): SessionDetailStats | null => {
  if (!isRecord(value)) return null;
  const counts = isRecord(value.messageCounts) ? value.messageCounts : undefined;
  const userMessageCount = readMessageCount(counts, 'user');
  const assistantMessageCount = readMessageCount(counts, 'assistant');
  const tokenSnapshot = extractOpenClawTokenUsage(value);
  const tokenUsage: SessionDetailTokenUsage = {
    input: tokenSnapshot?.input ?? 0,
    output: tokenSnapshot?.output ?? 0,
    cacheRead: tokenSnapshot?.cacheRead ?? 0,
    cacheWrite: tokenSnapshot?.cacheWrite ?? 0,
  };
  const totalTokens = tokenSnapshot?.total ?? sumSessionDetailTokenUsage(tokenUsage);
  const modelUsage = Array.isArray(value.modelUsage) ? value.modelUsage : [];
  const visibleActivity = readVisibleActivity(historyMessages);
  const lastActivity = readTimestamp(value.lastActivity);

  return {
    summary: visibleActivity?.summary ?? summary,
    messageCount:
      visibleActivity?.messageCount ??
      nonNegativeNumber(counts?.total) ??
      userMessageCount + assistantMessageCount,
    userMessageCount: visibleActivity?.userMessageCount ?? userMessageCount,
    assistantMessageCount: visibleActivity?.assistantMessageCount ?? assistantMessageCount,
    toolCallCount: visibleActivity?.toolCallCount ?? readMessageCount(counts, 'toolCalls'),
    models: readModelNames(modelUsage),
    tokenUsage,
    totalTokens,
    hasTokenUsage: totalTokens > 0 || sumSessionDetailTokenUsage(tokenUsage) > 0,
    ...(lastActivity !== undefined ? { lastActivity } : {}),
  };
};

/** Loads current physical-session usage directly from OpenClaw's transcript rollup. */
export const requestGatewaySessionUsage = async (
  client: GatewayClientLike,
  sessionKey: string,
  options: GatewaySessionUsageRequestOptions = {},
): Promise<unknown | null> => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_USAGE_CACHE_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? DEFAULT_USAGE_CACHE_RETRY_DELAY_MS,
  );
  const wait =
    options.wait ??
    ((delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs)));
  const requestedDiscriminator = options.cacheDiscriminator;
  const cacheDiscriminator =
    typeof requestedDiscriminator === 'number' &&
    Number.isSafeInteger(requestedDiscriminator) &&
    requestedDiscriminator > 0
      ? requestedDiscriminator
      : ((usageRequestSequence =
          (usageRequestSequence % (Number.MAX_SAFE_INTEGER - 1)) + 1));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // OpenClaw v2026.9.2 includes `limit` in the outer cache key even for an
    // exact-key lookup. A session-revision discriminator avoids an older
    // stale-while-revalidate entry without creating one key per retry attempt.
    const result = await client.request<{
      sessions?: unknown[];
      cacheStatus?: { status?: unknown };
    }>('sessions.usage', {
      key: sessionKey,
      range: 'all',
      groupBy: 'instance',
      limit: cacheDiscriminator,
    });
    if (result.cacheStatus?.status === 'fresh') {
      const row = Array.isArray(result.sessions) ? result.sessions.find(isRecord) : undefined;
      return row && 'usage' in row ? (row.usage ?? {}) : null;
    }
    if (attempt < maxAttempts) await wait(retryDelayMs);
  }

  throw new Error('Gateway usage cache did not become fresh');
};
