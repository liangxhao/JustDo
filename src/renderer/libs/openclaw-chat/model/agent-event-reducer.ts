import type { NormalizedAgentEvent, NormalizedChatEvent } from '@shared/openclaw/agentEvent';

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
  readToolCallId,
  readToolError,
  readToolInput,
  readToolName,
  readToolOutput,
} from './tool-message-adapter';

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

function toolStatus(phase: string, failed: boolean): ToolItem['status'] {
  if (failed) return 'failed';
  if (phase === 'cancelled' || phase === 'canceled' || phase === 'aborted') return 'cancelled';
  if (
    phase === 'result' ||
    phase === 'end' ||
    phase === 'complete' ||
    phase === 'completed' ||
    phase === 'done'
  ) {
    return 'completed';
  }
  return 'running';
}

function reduceTool(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): boolean {
  const toolCallId = readToolCallId(event.data);
  if (!toolCallId) return false;
  const phase = typeof event.data.phase === 'string' ? event.data.phase.trim().toLowerCase() : '';
  const existing = turn.toolById.get(toolCallId);
  const name = readToolName(event.data, existing?.name ?? 'tool');
  const input = readToolInput(event.data);
  const output = readToolOutput(event.data);
  const error = readToolError(event.data, output);
  const status = toolStatus(phase, error.failed);

  if (existing) {
    existing.name = name;
    if (input !== undefined && input !== null) existing.input = input;
    if (output !== null) existing.output = boundOutput(output);
    if (error.message !== null) existing.error = boundOutput(error.message);
    existing.status = status;
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
    name,
    ...(input !== undefined && input !== null ? { input } : {}),
    ...(output !== null ? { output: boundOutput(output) } : {}),
    ...(error.message !== null ? { error: boundOutput(error.message) } : {}),
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
  if (tombstone?.terminalStatus) return null;

  const active = state.activeTurn;
  if (active) {
    if (active.runId === event.runId) return active;
    if (active.status !== 'running') {
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
    if (active.runId.startsWith('justdo-')) {
      bindAssistantTurnRunId(state, active.runId, event.runId);
      return state.activeTurn;
    }
    return null;
  }
  if (event.spawnedBy) return null;
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

export function reduceAgentEvent(
  state: ChatTranscriptState,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): TranscriptReduceResult {
  if (!eventMatchesTranscriptSession(state, event)) return 'ignored-session';
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
  if (event.agentSeq <= turn.lastAgentSeq) return 'ignored-sequence';

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
  if (event.sessionKey !== state.sessionKey) return 'ignored-session';
  let turn = state.activeTurn;
  if (!turn && event.runId && event.state === 'delta') {
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
  if (event.runId && turn.runId !== event.runId) {
    if (!bindAssistantTurnRunId(state, turn.runId, event.runId)) return 'ignored-run';
    turn = state.activeTurn;
  }
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
        ...(event.message !== undefined ? { text: extractMessageText(event.message) } : {}),
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
    const tail = turn.items[turn.items.length - 1];
    if (tail?.type === 'content') {
      tail.text = updateSnapshot(tail.text, finalText, true);
      tail.updatedAt = now;
    } else {
      turn.items.push({
        id: dependencies.createId('content'),
        runId: turn.runId,
        firstSeq: turn.lastAgentSeq,
        lastSeq: turn.lastAgentSeq,
        startedAt: now,
        updatedAt: now,
        type: 'content',
        status: 'completed',
        text: finalText,
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
