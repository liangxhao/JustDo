/**
 * Shared gateway types used by connectionManager, event handlers, and the main adapter.
 */

export type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

export type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

export type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

export type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

export type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
};

export type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  /** Alternative field name used by some gateway events (e.g., agent lifecycle events) */
  session?: string;
  stream?: string;
  data?: unknown;
  /** Gateway tool event fields: tool='result:sessions_spawn', call='toolCallId', meta='label xxx' */
  tool?: string;
  call?: string;
  meta?: string;
  err?: boolean;
};

export type ExecApprovalRequestedPayload = {
  id?: string;
  request?: {
    command?: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
    agentId?: string | null;
  };
};

export type ExecApprovalResolvedPayload = {
  id?: string;
};

export type TextStreamMode = 'unknown' | 'snapshot' | 'delta';

export type BufferedChatEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

export type BufferedAgentEvent = {
  payload: unknown;
  seq: number | undefined;
  bufferedAt: number;
};

export type ChannelHistorySyncEntry = {
  role: 'user' | 'assistant';
  text: string;
};

export type ActiveTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  turnToken: number;
  knownRunIds: Set<string>;
  assistantMessageId: string | null;
  committedAssistantText: string;
  currentAssistantSegmentText: string;
  currentText: string;
  /** Highest text length from agent assistant events (immune to chat delta noise). */
  agentAssistantTextLength: number;
  currentContentText: string;
  currentContentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  textStreamMode: TextStreamMode;
  toolUseMessageIdByToolCallId: Map<string, string>;
  toolResultMessageIdByToolCallId: Map<string, string>;
  toolResultTextByToolCallId: Map<string, string>;
  stopRequested: boolean;
  /** True while async user message prefetch is in progress for channel sessions. */
  pendingUserSync: boolean;
  /** Chat events buffered while pendingUserSync is true. */
  bufferedChatPayloads: BufferedChatEvent[];
  /** Agent events buffered while pendingUserSync is true. */
  bufferedAgentPayloads: BufferedAgentEvent[];
  /** Client-side timeout watchdog timer (fallback for missing gateway abort events). */
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** Message ID for current thinking stream (created on first thinking event). */
  currentThinkingMessageId: string | null;
  /** Accumulated thinking content for current stream. */
  currentThinkingContent: string;
  /** True when thinking stream has ended (first text or non-thinking event received). */
  thinkingStreamEnded: boolean;
  /** Model name for this turn's assistant messages (captured at turn start). */
  modelName: string;
};
