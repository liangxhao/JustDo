export interface SessionDetailTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const HIDDEN_SESSION_DETAIL_MODELS = new Set(['openclaw/gateway-injected']);

export const isSessionDetailModelVisible = (value: string): boolean =>
  !HIDDEN_SESSION_DETAIL_MODELS.has(value.trim().toLowerCase());

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
