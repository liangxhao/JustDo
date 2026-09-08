import { normalizeMessageSessionKey } from '@shared/openclaw/messageDomain';

export const resolveContextUsageDisplay = (totalTokens: number, contextTokens: number) => {
  const normalizedContextTokens = Math.max(0, contextTokens);
  const normalizedTotalTokens = Math.max(0, totalTokens);
  const usedTokens =
    normalizedContextTokens > 0
      ? Math.min(normalizedTotalTokens, normalizedContextTokens)
      : normalizedTotalTokens;
  const percentage =
    normalizedContextTokens > 0
      ? Math.min(100, Math.round((usedTokens / normalizedContextTokens) * 100))
      : 0;
  return {
    usedTokens,
    percentage,
    overflowed: normalizedContextTokens > 0 && normalizedTotalTokens > normalizedContextTokens,
  };
};

export const contextUsageMatchesSession = (
  usageSessionKey: string,
  sessionId: string,
  agentId: string | null | undefined,
): boolean => {
  const expectedSessionKey = `agent:${agentId?.trim() || 'main'}:justdo:${sessionId}`;
  return (
    normalizeMessageSessionKey(usageSessionKey).toLowerCase() ===
    normalizeMessageSessionKey(expectedSessionKey).toLowerCase()
  );
};
