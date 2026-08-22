import type { NormalizedAgentEvent, NormalizedChatEvent } from '@shared/openclaw/agentEvent';
import {
  classifyAgentEvent,
  classifyChatEvent,
  normalizeToolEvent,
} from '@shared/openclaw/messageDomain';

import {
  type AssistantTurn,
  beginAssistantTurn,
  bindAssistantTurnRunId,
  type ChatTranscriptState,
  type ContentItem,
  eventMatchesTranscriptSession,
  MAX_LIVE_TOOL_OUTPUT_CHARS,
  pruneRecentRuns,
  RECENT_RUN_RETENTION_MS,
  type ThinkingItem,
  type ToolItem,
  type TranscriptReducerDependencies,
  type TurnItem,
  type TurnStatus,
} from './chat-transcript-state';
import {
  hasToolResultPayload,
  inferSessionsYieldInput,
  isSessionsYieldTool,
} from './tool-lifecycle';

export type TranscriptReduceResult =
  'applied' | 'ignored-session' | 'ignored-run' | 'ignored-sequence' | 'ignored-stream';

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function boundOutput(value: string): string {
  if (value.length <= MAX_LIVE_TOOL_OUTPUT_CHARS) return value;
  return `[output truncated]\n${value.slice(-MAX_LIVE_TOOL_OUTPUT_CHARS)}`;
}

function completeRunningThinking(turn: AssistantTurn, seq: number, now: number): void {
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === 'thinking' && tail.status === 'running') {
    tail.status = 'completed';
    tail.lastSeq = seq;
    tail.updatedAt = now;
  }
}

function completeStreamingContent(turn: AssistantTurn, seq: number, now: number): void {
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === 'content' && tail.status === 'streaming') {
    tail.status = 'completed';
    tail.lastSeq = seq;
    tail.updatedAt = now;
  }
}

function createBase(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
  prefix: string,
) {
  return {
    id: dependencies.createId(prefix),
    runId: turn.runId,
    firstSeq: event.agentSeq,
    lastSeq: event.agentSeq,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
  };
}

function updateSnapshot(previous: string, next: string, replace: boolean): string {
  if (replace || !previous) return next;
  if (next.startsWith(previous) || previous.startsWith(next)) {
    return next.length >= previous.length ? next : previous;
  }
  return next;
}

function snapshotDistanceFromCurrent(candidate: string, current: string): number {
  const normalizedCandidate = candidate.trimStart();
  const normalizedCurrent = current.trimStart();
  if (normalizedCandidate === normalizedCurrent) return 0;
  if (normalizedCandidate.startsWith(normalizedCurrent)) {
    return normalizedCandidate.length - normalizedCurrent.length;
  }
  if (normalizedCurrent.startsWith(normalizedCandidate)) {
    return normalizedCurrent.length - normalizedCandidate.length;
  }
  return Number.POSITIVE_INFINITY;
}

function stripCompletedContentSegments(turn: AssistantTurn, snapshot: string): string {
  let text = snapshot;
  for (const item of turn.items) {
    if (item.type !== 'content' || item.status === 'streaming') continue;
    const committed = item.text.trim();
    if (!committed) continue;
    const trimmed = text.trimStart();
    if (trimmed.startsWith(committed)) {
      text = trimmed.slice(committed.length).trimStart();
    }
  }
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === 'content') {
    const rawDistance = snapshotDistanceFromCurrent(snapshot, tail.text);
    const strippedDistance = snapshotDistanceFromCurrent(text, tail.text);
    if (rawDistance <= strippedDistance) return snapshot;
  }
  return text;
}

function reduceThinking(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): void {
  const text = stringValue(event.data.text) ?? stringValue(event.data.delta);
  if (text === null) return;
  completeStreamingContent(turn, event.agentSeq, event.timestamp);
  const tail = turn.items[turn.items.length - 1];
  if (tail?.type === 'thinking' && tail.status === 'running') {
    const isDelta = event.data.delta !== undefined && event.data.text === undefined;
    tail.text = isDelta
      ? `${tail.text}${text}`
      : updateSnapshot(tail.text, text, event.data.replace === true);
    tail.lastSeq = event.agentSeq;
    tail.updatedAt = event.timestamp;
    return;
  }
  const item: ThinkingItem = {
    ...createBase(turn, event, dependencies, 'thinking'),
    type: 'thinking',
    status: 'running',
    text,
  };
  turn.items.push(item);
}

function reduceContent(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): void {
  const snapshot = stringValue(event.data.text);
  const delta = stringValue(event.data.delta);
  // Native agent assistant snapshots are scoped to the current model message.
  // Only chat snapshots/finals can represent the cumulative visible turn.
  const text = snapshot ?? delta;
  if (text === null) return;
  completeRunningThinking(turn, event.agentSeq, event.timestamp);
  const tail = turn.items[turn.items.length - 1];
  const replace = event.data.replace === true;
  if (tail?.type === 'content' && tail.status === 'streaming') {
    if (delta !== null && snapshot === null && !replace) {
      tail.text += delta;
      tail.sourceMode = 'delta';
    } else {
      tail.text = updateSnapshot(tail.text, text, replace);
      tail.sourceMode = replace ? 'replaceable' : 'snapshot';
    }
    tail.lastSeq = event.agentSeq;
    tail.updatedAt = event.timestamp;
    return;
  }
  const item: ContentItem = {
    ...createBase(turn, event, dependencies, 'content'),
    type: 'content',
    status: 'streaming',
    text,
    sourceMode: replace ? 'replaceable' : snapshot !== null ? 'snapshot' : 'delta',
  };
  turn.items.push(item);
}

function reduceTool(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): boolean {
  const normalized = normalizeToolEvent(event.data);
  const toolCallId = normalized.toolCallId;
  if (!toolCallId) return false;
  const existing = turn.toolById.get(toolCallId);
  const resolved = normalizeToolEvent(event.data, existing?.name ?? 'tool');
  const resolvedInput =
    resolved.input ??
    existing?.input ??
    inferSessionsYieldInput(resolved.name, resolved.output ?? existing?.output);
  const sessionsYieldHasPayload =
    hasToolResultPayload({
      output: resolved.output ?? undefined,
      error: resolved.error ?? undefined,
    }) ||
    (existing !== undefined && hasToolResultPayload(existing));
  const outputlessSessionsYieldResult =
    isSessionsYieldTool(resolved.name) &&
    resolved.status === 'completed' &&
    !sessionsYieldHasPayload;
  const status = outputlessSessionsYieldResult ? 'running' : resolved.status;

  if (existing) {
    existing.name = resolved.name;
    if (resolvedInput !== undefined && resolvedInput !== null) existing.input = resolvedInput;
    if (resolved.output !== null && !outputlessSessionsYieldResult) {
      existing.output = boundOutput(resolved.output);
    }
    if (resolved.error !== null && !outputlessSessionsYieldResult) {
      existing.error = boundOutput(resolved.error);
    }
    if (existing.status === 'running' || status !== 'running') {
      existing.status = status;
    }
    existing.lastSeq = event.agentSeq;
    existing.updatedAt = event.timestamp;
    return true;
  }

  completeRunningThinking(turn, event.agentSeq, event.timestamp);
  const previous = turn.items[turn.items.length - 1];
  if (previous?.type === 'content' && previous.status === 'streaming') {
    previous.status = 'completed';
    previous.followingToolCallId = toolCallId;
    previous.lastSeq = event.agentSeq;
    previous.updatedAt = event.timestamp;
  }
  const item: ToolItem = {
    ...createBase(turn, event, dependencies, 'tool'),
    type: 'tool',
    status,
    toolCallId,
    name: resolved.name,
    ...(resolvedInput !== undefined && resolvedInput !== null ? { input: resolvedInput } : {}),
    ...(normalized.output !== null && !outputlessSessionsYieldResult
      ? { output: boundOutput(normalized.output) }
      : {}),
    ...(normalized.error !== null && !outputlessSessionsYieldResult
      ? { error: boundOutput(normalized.error) }
      : {}),
  };
  turn.items.push(item);
  turn.toolById.set(toolCallId, item);
  return true;
}

function admitTurn(
  state: ChatTranscriptState,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): AssistantTurn | null {
  pruneRecentRuns(state, dependencies.now());
  const tombstone = state.recentRuns.get(event.runId);
  const active = state.activeTurn;
  const admission = classifyAgentEvent({
    selected: state,
    activeRun: active,
    event,
    terminalRun: Boolean(tombstone?.terminalStatus),
  });
  if (
    admission === 'ignored-session' ||
    admission === 'ignored-run' ||
    admission === 'ignored-sequence' ||
    admission === 'ignored-terminal'
  ) {
    return null;
  }
  if (admission === 'bind-provisional-run' && active) {
    bindAssistantTurnRunId(state, active.runId, event.runId);
  } else if (admission === 'start-run') {
    return beginAssistantTurn(
      state,
      {
        runId: event.runId,
        sessionId: event.sessionId,
        lifecycleGeneration: event.lifecycleGeneration,
        startedAt: event.timestamp,
      },
      dependencies,
    );
  }
  const admitted = state.activeTurn;
  if (admitted && !admitted.sessionId && event.sessionId) admitted.sessionId = event.sessionId;
  if (admitted && !admitted.lifecycleGeneration && event.lifecycleGeneration) {
    admitted.lifecycleGeneration = event.lifecycleGeneration;
  }
  return admitted;
}

export function reduceAgentEvent(
  state: ChatTranscriptState,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): TranscriptReduceResult {
  if (!eventMatchesTranscriptSession(state, event)) return 'ignored-session';
  const previousTurn = state.activeTurn;
  const admission = classifyAgentEvent({
    selected: state,
    activeRun: previousTurn,
    event,
    terminalRun: Boolean(state.recentRuns.get(event.runId)?.terminalStatus),
  });
  if (admission === 'ignored-session') return 'ignored-session';
  if (admission === 'ignored-sequence') return 'ignored-sequence';
  if (admission === 'ignored-run' || admission === 'ignored-terminal') return 'ignored-run';
  const turn = admitTurn(state, event, dependencies);
  if (!turn) return 'ignored-run';
  if (turn.sessionId && event.sessionId && turn.sessionId !== event.sessionId) {
    return 'ignored-session';
  }
  if (
    turn.lifecycleGeneration &&
    event.lifecycleGeneration &&
    turn.lifecycleGeneration !== event.lifecycleGeneration
  ) {
    return 'ignored-run';
  }
  let applied = true;
  if (event.stream === 'thinking') {
    reduceThinking(turn, event, dependencies);
  } else if (event.stream === 'assistant') {
    reduceContent(turn, event, dependencies);
  } else if (event.stream === 'tool') {
    applied = reduceTool(turn, event, dependencies);
  } else if (
    event.stream === 'lifecycle' ||
    event.stream === 'item' ||
    event.stream === 'compaction'
  ) {
    // Ordering still advances for admitted non-display Agent events.
  } else {
    return 'ignored-stream';
  }

  if (!applied) return 'ignored-stream';
  turn.lastAgentSeq = event.agentSeq;
  state.revision += 1;
  return 'applied';
}

function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '';
  const record = message as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (!Array.isArray(record.content)) return '';
  return record.content
    .map(block => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
      const value = block as Record<string, unknown>;
      return typeof value.text === 'string' ? value.text : '';
    })
    .join('');
}

function finishTurnItems(turn: AssistantTurn, status: TurnStatus, now: number): void {
  for (const item of turn.items) {
    if (item.type === 'thinking' && item.status === 'running') {
      item.status = status === 'final' ? 'completed' : 'interrupted';
      item.updatedAt = now;
    } else if (item.type === 'tool' && item.status === 'running') {
      if (status === 'final' && isSessionsYieldTool(item.name) && !hasToolResultPayload(item)) {
        continue;
      }
      item.status = status === 'error' ? 'failed' : status === 'final' ? 'completed' : 'cancelled';
      item.updatedAt = now;
    } else if (item.type === 'content' && item.status === 'streaming') {
      item.status = status === 'final' ? 'completed' : 'interrupted';
      item.updatedAt = now;
    }
  }
}

export function reduceChatEvent(
  state: ChatTranscriptState,
  event: NormalizedChatEvent,
  dependencies: TranscriptReducerDependencies,
): TranscriptReduceResult {
  const admission = classifyChatEvent({
    selected: state,
    activeRun: state.activeTurn,
    event,
  });
  if (admission === 'ignored-session') return 'ignored-session';
  let turn = state.activeTurn;
  if (admission === 'start-run' && event.runId) {
    turn = beginAssistantTurn(
      state,
      {
        runId: event.runId,
        sessionId: event.sessionId,
        lifecycleGeneration: event.lifecycleGeneration,
      },
      dependencies,
    );
  }
  if (!turn) return 'ignored-run';
  if (admission === 'bind-provisional-run' && event.runId) {
    if (!bindAssistantTurnRunId(state, turn.runId, event.runId)) return 'ignored-run';
    turn = state.activeTurn;
  }
  if (admission === 'ignored-run') return 'ignored-run';
  if (!turn) return 'ignored-run';
  if (event.sessionId && turn.sessionId && event.sessionId !== turn.sessionId) {
    return 'ignored-session';
  }
  if (
    event.lifecycleGeneration &&
    turn.lifecycleGeneration &&
    event.lifecycleGeneration !== turn.lifecycleGeneration
  ) {
    return 'ignored-run';
  }

  if (event.state === 'delta') {
    const messageText = event.message !== undefined ? extractMessageText(event.message) : null;
    const synthetic: NormalizedAgentEvent = {
      runId: turn.runId,
      sessionKey: state.sessionKey,
      sessionId: event.sessionId,
      lifecycleGeneration: event.lifecycleGeneration,
      agentId: null,
      spawnedBy: null,
      agentSeq: turn.lastAgentSeq + 1,
      frameSeq: event.frameSeq,
      deliveryEvent: 'agent',
      stream: 'assistant',
      timestamp: dependencies.now(),
      data: {
        ...(event.deltaText !== undefined ? { delta: event.deltaText } : {}),
        ...(messageText !== null ? { text: stripCompletedContentSegments(turn, messageText) } : {}),
        replace: event.replace,
      },
    };
    reduceContent(turn, synthetic, dependencies);
    state.revision += 1;
    return 'applied';
  }

  const now = dependencies.now();
  const finalText = extractMessageText(event.message);
  if (finalText && event.state === 'final') {
    const currentSegmentText = stripCompletedContentSegments(turn, finalText);
    const tail = turn.items[turn.items.length - 1];
    if (tail?.type === 'content' && currentSegmentText) {
      tail.text = updateSnapshot(tail.text, currentSegmentText, true);
      tail.updatedAt = now;
    } else if (currentSegmentText) {
      turn.items.push({
        id: dependencies.createId('content'),
        runId: turn.runId,
        firstSeq: turn.lastAgentSeq,
        lastSeq: turn.lastAgentSeq,
        startedAt: now,
        updatedAt: now,
        type: 'content',
        status: 'completed',
        text: currentSegmentText,
        sourceMode: 'replaceable',
      });
    }
  }

  turn.status = event.state;
  turn.endedAt = now;
  finishTurnItems(turn, event.state, now);
  if (event.state === 'aborted' || event.state === 'error') {
    const message =
      event.errorMessage?.trim() ||
      (event.state === 'aborted' ? 'The run was interrupted.' : 'The run failed.');
    const terminal: TurnItem = {
      id: dependencies.createId('terminal'),
      runId: turn.runId,
      firstSeq: turn.lastAgentSeq,
      lastSeq: turn.lastAgentSeq,
      startedAt: now,
      updatedAt: now,
      type: 'terminal',
      status: event.state,
      message,
    };
    turn.items.push(terminal);
  }
  state.recentRuns.set(turn.runId, {
    runId: turn.runId,
    sessionId: turn.sessionId,
    lifecycleGeneration: turn.lifecycleGeneration,
    lastAgentSeq: turn.lastAgentSeq,
    terminalStatus: event.state,
    expiresAt: now + RECENT_RUN_RETENTION_MS,
  });
  pruneRecentRuns(state, now);
  state.revision += 1;
  return 'applied';
}
