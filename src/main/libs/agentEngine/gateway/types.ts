/**
 * Shared gateway types for the simplified v2026.5.22 adapter.
 *
 * Replaces the 22-field ActiveTurn with an 8-field SessionTurn,
 * aligned with openclaw webchat's ChatState pattern.
 */

// ─── Gateway Client ─────────────────────────────────────────────────────────

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

// ─── Chat Events ────────────────────────────────────────────────────────────

export type ChatEventState = 'delta' | 'final' | 'aborted' | 'error';

export type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: ChatEventState;
  message?: unknown;
  errorMessage?: string;
  stopReason?: string;
};

// ─── Agent Events ───────────────────────────────────────────────────────────

export type AgentEventPayload = {
  seq?: number;
  runId?: string;
  sessionKey?: string;
  session?: string;
  stream?: string;
  data?: unknown;
  tool?: string;
  call?: string;
  meta?: string;
  err?: boolean;
};

// ─── Approval Events ────────────────────────────────────────────────────────

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

// ─── Tool Stream (aligned with openclaw webchat app-tool-stream.ts) ─────────

export type ToolStreamEntry = {
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  name: string;
  args?: unknown;
  output?: string;
  emitted?: boolean;
  startedAt: number;
  updatedAt: number;
};

// ─── Session Turn (replaces 22-field ActiveTurn) ────────────────────────────

/**
 * Per-session turn state, aligned with openclaw webchat's ChatState.
 * One SessionTurn per active session, not 25+ scattered Maps.
 */
export type SessionTurn = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  turnToken: number;
  /** Full accumulated text from chat delta events (gateway sends snapshot, not增量). */
  chatStream: string;
  /** Assistant text already finalized before tool calls in this run. */
  committedAssistantSegments: string[];
  /** Tool stream entries keyed by toolCallId. */
  toolStreamById: Map<string, ToolStreamEntry>;
  /** Accumulated thinking content. */
  thinkingContent: string;
  thinkingMessageId: string | null;
  /** Whether the user requested a stop. */
  stopRequested: boolean;
  /** Message ID of the current streaming assistant message. */
  assistantMessageId: string | null;
  /** Model name for this turn. */
  modelName: string;
  /** Set of known runIds for this turn (main + announce). */
  knownRunIds: Set<string>;
};
