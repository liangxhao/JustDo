import { isGatewayInjectedModelRef } from '../openclaw/modelRef';

export interface SessionDetailTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const isSessionDetailModelVisible = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return (
    !isGatewayInjectedModelRef(value) &&
    normalized !== 'delivery-mirror' &&
    normalized !== 'openclaw/delivery-mirror'
  );
};

/** Fallback total for providers that do not report a canonical aggregate. */
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
  lastActivity?: number;
}

export type CoworkSessionDetailsResult<TSession> =
  | {
      success: true;
      session: TSession;
      stats: SessionDetailStats;
      gatewaySessionId?: string;
    }
  | { success: false; error: string };
