import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { messageSessionMatches, normalizeMessageSessionKey } from '@shared/openclaw/messageDomain';

export type TurnStatus = 'running' | 'final' | 'aborted' | 'error';
export type ProcessStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type HistorySource = 'gateway' | 'optimistic';

export interface BaseTurnItem {
  id: string;
  runId: string;
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
  updatedAt: number;
}

export interface ThinkingItem extends BaseTurnItem {
  type: 'thinking';
  status: ProcessStatus;
  text: string;
  /** Authoritative history text awaiting a matching delayed Agent snapshot. */
  recoveredSnapshotText?: string;
}

export interface ToolItem extends BaseTurnItem {
  type: 'tool';
  status: ProcessStatus;
  toolCallId: string;
  name: string;
  /** History restored the card before its canonical Agent sequence arrived. */
  agentSequencePending?: boolean;
  input?: unknown;
  output?: string;
  error?: string;
}

export interface ContentItem extends BaseTurnItem {
  type: 'content';
  status: 'streaming' | 'completed' | 'interrupted';
  text: string;
  sourceMode: 'delta' | 'snapshot' | 'replaceable';
  followingToolCallId?: string;
  /** Authoritative history text awaiting a matching delayed Agent snapshot. */
  recoveredSnapshotText?: string;
  /** Optimistic managed-terminal observation that can still be committed or rolled back. */
  terminalGuardObservationToken?: string;
}

export interface TerminalItem extends BaseTurnItem {
  type: 'terminal';
  status: 'aborted' | 'error';
  message: string;
}

export type TurnItem = ThinkingItem | ToolItem | ContentItem | TerminalItem;

export interface AssistantTurn {
  id: string;
  runId: string;
  sessionId: string | null;
  lifecycleGeneration: string | null;
  sessionKey: string;
  status: TurnStatus;
  lastAgentSeq: number;
  /**
   * Per projected activity owner sequence fences. A history in-flight snapshot
   * can arrive after a newer live event for another owner, so the run-wide
   * high-water mark alone cannot decide whether that snapshot fills a gap.
   */
  activityEventSeqById?: Map<string, number>;
  startedAt: number;
  endedAt?: number;
  modelRef?: string;
  items: TurnItem[];
  toolById: Map<string, ToolItem>;
}

export type AssistantTurnTiming = Pick<
  AssistantTurn,
  'runId' | 'status' | 'startedAt' | 'endedAt' | 'modelRef'
>;

export interface RecentRunState {
  runId: string;
  sessionId: string | null;
  lifecycleGeneration: string | null;
  lastAgentSeq: number;
  terminalStatus: Exclude<TurnStatus, 'running'> | null;
  expiresAt: number;
}

export interface ChatTranscriptState {
  sessionKey: string;
  sessionId: string | null;
  persistedMessages: unknown[];
  historySource: HistorySource;
  historyGeneration: number;
  activeTurn: AssistantTurn | null;
  recentRuns: Map<string, RecentRunState>;
  revision: number;
}

export interface TranscriptReducerDependencies {
  now: () => number;
  createId: (prefix: string) => string;
}

export const MAX_LIVE_TOOL_OUTPUT_CHARS = 120_000;
export const MAX_RECENT_RUNS = 24;
export const RECENT_RUN_RETENTION_MS = 5 * 60 * 1000;

export function createChatTranscriptState(
  sessionKey = '',
  sessionId: string | null = null,
): ChatTranscriptState {
  return {
    sessionKey,
    sessionId,
    persistedMessages: [],
    historySource: 'optimistic',
    historyGeneration: 0,
    activeTurn: null,
    recentRuns: new Map(),
    revision: 0,
  };
}

export function resetChatTranscriptState(
  state: ChatTranscriptState,
  sessionKey: string,
  sessionId: string | null,
): void {
  state.sessionKey = sessionKey;
  state.sessionId = sessionId;
  state.persistedMessages = [];
  state.historySource = 'optimistic';
  state.historyGeneration += 1;
  state.activeTurn = null;
  state.recentRuns.clear();
  state.revision += 1;
}

export function beginAssistantTurn(
  state: ChatTranscriptState,
  params: {
    runId: string;
    sessionId?: string | null;
    lifecycleGeneration?: string | null;
    startedAt?: number;
  },
  dependencies: TranscriptReducerDependencies,
): AssistantTurn {
  const turn: AssistantTurn = {
    id: dependencies.createId('turn'),
    runId: params.runId,
    sessionId: params.sessionId ?? state.sessionId,
    lifecycleGeneration: params.lifecycleGeneration ?? null,
    sessionKey: state.sessionKey,
    status: 'running',
    lastAgentSeq: -1,
    activityEventSeqById: new Map(),
    startedAt: params.startedAt ?? dependencies.now(),
    items: [],
    toolById: new Map(),
  };
  state.activeTurn = turn;
  state.revision += 1;
  return turn;
}

export function bindAssistantTurnRunId(
  state: ChatTranscriptState,
  provisionalRunId: string,
  runId: string,
): boolean {
  const turn = state.activeTurn;
  if (!turn || turn.runId !== provisionalRunId || !provisionalRunId.startsWith('justdo-')) {
    return false;
  }
  turn.runId = runId;
  for (const item of turn.items) item.runId = runId;
  state.revision += 1;
  return true;
}

export function eventMatchesTranscriptSession(
  state: ChatTranscriptState,
  event: Pick<NormalizedAgentEvent, 'sessionKey' | 'sessionId'>,
): boolean {
  return messageSessionMatches(state, event);
}

/**
 * Gateway events may use either `justdo:<id>` or
 * `agent:<agent-id>:justdo:<id>` for the same managed session. No other suffix
 * relationship is an alias.
 */
export function normalizeTranscriptSessionKey(sessionKey: string): string {
  return normalizeMessageSessionKey(sessionKey);
}

export function pruneRecentRuns(state: ChatTranscriptState, now: number): void {
  for (const [runId, run] of state.recentRuns) {
    if (run.expiresAt <= now) state.recentRuns.delete(runId);
  }
  while (state.recentRuns.size > MAX_RECENT_RUNS) {
    const oldest = state.recentRuns.keys().next().value as string | undefined;
    if (!oldest) break;
    state.recentRuns.delete(oldest);
  }
}
