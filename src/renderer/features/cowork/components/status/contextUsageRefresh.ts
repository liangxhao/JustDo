import { normalizeMessageSessionKey } from '@shared/openclaw/messageDomain';

import type { ChatContextUsageSnapshot } from '@/libs/openclaw-chat/gateway/chat-controller';

// OpenClaw 2026.9.6 can omit the last-prompt budget before the first request
// or when the model/window changes. These fallbacks are current API states,
// not compatibility with an older Gateway.
export const resolveContextUsageLimit = (
  usage: Pick<ChatContextUsageSnapshot, 'contextTokens' | 'promptBudgetTokens'>,
  fallback?: number,
) => {
  const validLimit = (value: number | null | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (validLimit(usage.promptBudgetTokens)) {
    return { contextTokens: usage.promptBudgetTokens, fromLastPrompt: true };
  }
  return {
    contextTokens: validLimit(usage.contextTokens)
      ? usage.contextTokens
      : validLimit(fallback)
        ? fallback
        : 0,
    fromLastPrompt: false,
  };
};

export const resolveContextUsageDisplay = (totalTokens: number, contextTokens: number) => {
  const normalizedContextTokens = Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
  const normalizedTotalTokens = Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
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
