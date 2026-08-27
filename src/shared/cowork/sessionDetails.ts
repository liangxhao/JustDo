export interface SessionDetailTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Displayed total: the four visible token categories must add up exactly. */
export const sumSessionDetailTokenUsage = (usage: SessionDetailTokenUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

export const CoworkSessionDetailsIpc = {
  Get: 'cowork:session:details',
} as const;

export interface SessionDetailStats {
  summary: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  models: string[];
  tokenUsage: SessionDetailTokenUsage;
  totalTokens: number;
  hasTokenUsage: boolean;
}

export type CoworkSessionDetailsResult<TSession> =
  | {
      success: true;
      session: TSession;
      stats: SessionDetailStats;
      gatewaySessionId?: string;
    }
  | { success: false; error: string };

interface SessionDetailMessage {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  modelName?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

interface SessionDetailSource {
  messages: SessionDetailMessage[];
}

const normalizeSummary = (content: string): string | null => {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}...` : normalized;
};

const addTokenValue = (total: number, value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? total + value : total;

/**
 * Build the best available fallback when authoritative Gateway usage cannot
 * be read. Callers should prefer Gateway raw-transcript usage for lifetime statistics.
 */
export const buildLocalSessionDetailStats = (session: SessionDetailSource): SessionDetailStats => {
  const tokenUsage: SessionDetailTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const models = new Set<string>();
  const userMessageIds = new Set<string>();
  const assistantMessageIds = new Set<string>();
  const toolCallIds = new Set<string>();
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
    const hasRecordedTokenValue = [
      message.usage.input,
      message.usage.output,
      message.usage.cacheRead,
      message.usage.cacheWrite,
    ].some(
      value => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    );
    if (!hasRecordedTokenValue) continue;
    // Every assistant usage record represents a model request. Identical text
    // and token counts can legitimately occur in separate requests, so never
    // deduplicate usage by content.
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
    totalTokens: sumSessionDetailTokenUsage(tokenUsage),
    hasTokenUsage,
  };
};
