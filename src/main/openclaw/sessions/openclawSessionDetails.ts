import {
  isSessionDetailModelVisible,
  type SessionDetailStats,
  type SessionDetailTokenUsage,
  sumSessionDetailTokenUsage,
} from '../../../shared/cowork/sessionDetails';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { extractOpenClawTokenUsage } from './openclawTokenUsage';

export type GatewaySessionUsageLoader = (sessionKey: string) => Promise<unknown | null>;

interface GatewaySessionUsageRequestOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}

const DEFAULT_USAGE_CACHE_MAX_ATTEMPTS = 21;
const DEFAULT_USAGE_CACHE_RETRY_DELAY_MS = 250;

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
    const modelRef = provider && !model.includes('/') ? `${provider}/${model}` : model;
    if (isSessionDetailModelVisible(modelRef)) models.add(modelRef);
  }
  return [...models];
};

/**
 * Converts OpenClaw's raw-transcript usage summary into the detail-card shape.
 * `sessions.usage` accumulates each assistant request independently and keeps
 * the four displayed token categories. The displayed total is their exact sum.
 */
export const buildGatewaySessionDetailStats = (
  value: unknown,
  summary: string | null,
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
  const totalTokens = sumSessionDetailTokenUsage(tokenUsage);
  const modelUsage = Array.isArray(value.modelUsage) ? value.modelUsage : [];
  const hasModelRequests = modelUsage.some(
    item => isRecord(item) && (nonNegativeNumber(item.count) ?? 0) > 0,
  );

  return {
    summary,
    messageCount: nonNegativeNumber(counts?.total) ?? userMessageCount + assistantMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount: readMessageCount(counts, 'toolCalls'),
    models: readModelNames(modelUsage),
    tokenUsage,
    totalTokens,
    hasTokenUsage: hasModelRequests || totalTokens > 0,
  };
};

/** Loads the complete logical-session usage directly from OpenClaw's raw transcript. */
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await client.request<{
      sessions?: unknown[];
      cacheStatus?: { status?: unknown };
    }>('sessions.usage', {
      key: sessionKey,
      range: 'all',
      groupBy: 'family',
      limit: 1,
    });
    if (result.cacheStatus?.status === 'fresh') {
      const row = Array.isArray(result.sessions) ? result.sessions.find(isRecord) : undefined;
      return row && 'usage' in row ? row.usage : null;
    }
    if (attempt < maxAttempts) await wait(retryDelayMs);
  }

  throw new Error('Gateway usage cache did not become fresh');
};
