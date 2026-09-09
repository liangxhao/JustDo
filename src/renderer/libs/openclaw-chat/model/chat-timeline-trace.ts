import type { AssistantTurn, ChatTranscriptState, TurnItem } from './chat-transcript-state';

export const CHAT_TIMELINE_TRACE_ENABLED =
  import.meta.env?.DEV === true && import.meta.env?.VITE_DEBUG_CHAT_TIMELINE === 'true';

const LIMIT = 80;
const PREFIX = '[ChatTimelineTrace] ';
const trackedEvents = new Set(['agent', 'session.tool', 'session.message', 'chat']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 180) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Correlate text revisions without logging message text, tool arguments or results. */
export function traceTextIdentity(value: unknown): { length: number; hash: string } | undefined {
  if (typeof value !== 'string') return undefined;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return { length: value.length, hash: (hash >>> 0).toString(16) };
}

export function summarizeTimelineEvent(value: unknown): Record<string, unknown> | null {
  const event = record(value);
  if (typeof event.event !== 'string' || !trackedEvents.has(event.event)) return null;
  const payload = record(event.payload);
  const data = record(payload.data);
  const message = record(payload.message);
  const marker = record(message.__openclaw);
  return {
    event: event.event,
    frameSeq: number(event.seq),
    runId: id(payload.runId),
    sessionKey: id(payload.sessionKey),
    sessionId: id(payload.sessionId),
    lifecycleGeneration: id(payload.lifecycleGeneration),
    agentId: id(payload.agentId),
    spawnedBy: id(payload.spawnedBy),
    seq: number(payload.seq),
    ts: number(payload.ts),
    stream: id(payload.stream),
    phase: id(data.phase),
    kind: id(data.kind),
    itemId: id(data.itemId),
    toolCallId: id(data.toolCallId),
    firstSeq: number(data.progressSegmentFirstSeq),
    segmentStartedAt: number(data.progressSegmentStartedAt),
    text: traceTextIdentity(data.thinking ?? data.text ?? data.progressText),
    delta: traceTextIdentity(data.delta),
    replace: data.replace === true,
    message: {
      role: id(message.role),
      timestamp: number(message.timestamp),
      runId: id(marker.runId ?? message.runId),
      messageSeq: number(marker.messageSeq),
      toolCallId: id(message.toolCallId),
      blocks: Array.isArray(message.content)
        ? message.content.slice(0, LIMIT).map(value => {
            const block = record(value);
            return {
              type: id(block.type),
              id: id(block.id),
              text: traceTextIdentity(block.thinking ?? block.text),
            };
          })
        : undefined,
    },
  };
}

function itemIdentity(item: TurnItem): Record<string, unknown> {
  return {
    id: item.id,
    type: item.type,
    firstSeq: item.firstSeq,
    lastSeq: item.lastSeq,
    status: item.status,
    startedAt: item.startedAt,
    text: 'text' in item ? traceTextIdentity(item.text) : undefined,
    ...(item.type === 'tool'
      ? {
          toolCallId: item.toolCallId,
          pending: item.agentSequencePending,
          unconfirmed: item.agentSequenceUnconfirmed,
        }
      : {}),
  };
}

function turnIdentity(turn: AssistantTurn | null): unknown {
  return turn
    ? {
        runId: turn.runId,
        sessionId: turn.sessionId,
        lifecycleGeneration: turn.lifecycleGeneration,
        lastSeq: turn.lastAgentSeq,
        snapshotSeq: turn.lastSnapshotAgentSeq,
        status: turn.status,
        count: turn.items.length,
        items: turn.items.slice(-LIMIT).map(itemIdentity),
      }
    : null;
}

function write(stage: string, detail: Record<string, unknown>): void {
  if (CHAT_TIMELINE_TRACE_ENABLED)
    console.debug(PREFIX + JSON.stringify({ at: Date.now(), stage, ...detail }));
}

export function traceTimelineWire(event: unknown): void {
  if (!CHAT_TIMELINE_TRACE_ENABLED) return;
  const summary = summarizeTimelineEvent(event);
  if (summary) write('wire', summary);
}

export function traceTimelineController(
  event: unknown,
  state: ChatTranscriptState,
  phase: 'before' | 'after',
  chatRunId: string | null,
): void {
  if (!CHAT_TIMELINE_TRACE_ENABLED) return;
  const summary = summarizeTimelineEvent(event);
  if (summary)
    write(`controller-${phase}`, {
      event: summary,
      sessionKey: state.sessionKey,
      revision: state.revision,
      chatRunId,
      turn: turnIdentity(state.activeTurn),
    });
}

type ProjectionItem = { kind: string; key: string; item?: TurnItem; items?: TurnItem[] };

export function traceTimelineProjection(
  sessionKey: string,
  persisted: readonly ProjectionItem[],
  active: readonly ProjectionItem[],
): void {
  if (!CHAT_TIMELINE_TRACE_ENABLED) return;
  const project = (items: readonly ProjectionItem[]) =>
    items.slice(-LIMIT).map(item => ({
      kind: item.kind,
      key: item.key,
      items: item.items?.slice(-LIMIT).map(itemIdentity),
      item: item.item ? itemIdentity(item.item) : undefined,
    }));
  write('projection', { sessionKey, persisted: project(persisted), active: project(active) });
}

export function traceTimelineDom(sessionKey: string, root: ShadowRoot | null): void {
  if (!CHAT_TIMELINE_TRACE_ENABLED || !root) return;
  const nodes = root.querySelectorAll(
    '[data-live-process-id],[data-inline-process-id],[data-process-summary-key],.chat-thinking--streaming',
  );
  write('dom', {
    sessionKey,
    count: nodes.length,
    nodes: Array.from(nodes)
      .slice(-LIMIT)
      .map(node => ({
        live: node.getAttribute('data-live-process-id'),
        inline: node.getAttribute('data-inline-process-id'),
        summary: node.getAttribute('data-process-summary-key'),
        thinking: node.classList.contains('chat-thinking--streaming'),
        text: traceTextIdentity(node.textContent),
      })),
  });
}
