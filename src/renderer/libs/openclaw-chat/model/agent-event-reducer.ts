import {
  type NormalizedAgentEvent,
  type NormalizedChatEvent,
  readTerminalGuardObservation,
  type TerminalGuardObservation,
} from '@shared/openclaw/agentEvent';
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

export interface RecoveredPreToolSegment {
  type: 'thinking' | 'content';
  text: string;
}

export interface AgentEventReduceOptions {
  /** Allow an in-flight history snapshot to fill an owner absent from newer live state. */
  allowSequenceBackfill?: boolean;
  /** An independently delivered recovery snapshot, not a consumed live event. */
  replaySnapshot?: boolean;
}

export function readPreambleText(data: Record<string, unknown>): string | null {
  return data.kind === 'preamble' &&
    typeof data.progressText === 'string' &&
    data.progressText.trim()
    ? data.progressText
    : null;
}

function snapshotSegmentFirstSeq(event: NormalizedAgentEvent): number | null {
  const value = event.data.progressSegmentFirstSeq;
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= event.agentSeq
    ? value
    : null;
}

function segmentStartedAt(event: NormalizedAgentEvent): number {
  const value = event.data.progressSegmentStartedAt;
  return snapshotSegmentFirstSeq(event) !== null &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= event.timestamp
    ? value
    : event.timestamp;
}

function agentTailAtSequence(turn: AssistantTurn, seq: number): TurnItem | undefined {
  let preceding: TurnItem | undefined;
  for (const item of turn.items) {
    if (item.firstSeq > seq) break;
    preceding = item;
  }
  return preceding;
}

function textOwnerForEvent(turn: AssistantTurn, event: NormalizedAgentEvent, backfill: boolean) {
  const firstSeq = snapshotSegmentFirstSeq(event);
  if (firstSeq !== null) {
    const type = event.stream === 'thinking' ? 'thinking' : 'content';
    const owned = turn.items.find(item => item.type === type && item.firstSeq === firstSeq);
    if (owned) return owned;
    // History may have restored an unsequenced pre-Tool segment first. Bind it
    // within the known Tool sequence or completion boundaries. An assistant
    // row's model-start timestamp cannot identify the Tool execution boundary.
    const text = stringValue(event.data.thinking) ?? stringValue(event.data.text);
    if (!text?.trim()) return undefined;
    const startedAt = segmentStartedAt(event);
    const matches = turn.items.filter((item, index) => {
      if (
        item.type !== type ||
        !item.recoveredSnapshotText ||
        (item.type === 'content' && item.preambleItemId !== undefined)
      )
        return false;
      if (
        turn.activityEventSeqById?.has(`segment:${JSON.stringify([event.stream, item.firstSeq])}`)
      )
        return false;
      const nextTool = turn.items.slice(index + 1).find(candidate => candidate.type === 'tool');
      const previousTool = turn.items
        .slice(0, index)
        .reverse()
        .find(candidate => candidate.type === 'tool');
      if (
        !nextTool ||
        (nextTool.agentSequenceUnconfirmed === true &&
          nextTool.historyCompletedAt !== undefined &&
          startedAt > nextTool.historyCompletedAt) ||
        (nextTool.agentSequenceUnconfirmed !== true &&
          nextTool.agentSequencePending === true &&
          startedAt > nextTool.startedAt) ||
        (!nextTool.agentSequencePending &&
          !nextTool.agentSequenceUnconfirmed &&
          firstSeq >= nextTool.firstSeq) ||
        (previousTool &&
          !previousTool.agentSequencePending &&
          !previousTool.agentSequenceUnconfirmed &&
          firstSeq <= previousTool.firstSeq)
      )
        return false;
      return item.recoveredSnapshotText.startsWith(text.trim());
    });
    if (matches.length !== 1) return undefined;
    matches[0].firstSeq = firstSeq;
    matches[0].startedAt = Math.min(matches[0].startedAt, startedAt);
    return matches[0];
  }
  const tail = backfill ? agentTailAtSequence(turn, event.agentSeq) : activeAgentTail(turn);
  return tail?.type === 'content' && tail.preambleItemId !== undefined ? undefined : tail;
}

function finishTextBeforeKnownBoundaries(turn: AssistantTurn): void {
  for (let index = 0; index < turn.items.length - 1; index += 1) {
    const item = turn.items[index];
    const next = turn.items[index + 1];
    if (item.type === 'thinking' && item.status === 'running') item.status = 'completed';
    if (item.type === 'content') {
      if (item.status === 'streaming') item.status = 'completed';
      if (next.type === 'tool') item.followingToolCallId = next.toolCallId;
    }
  }
}

function preservesRecoveredText(
  turn: AssistantTurn,
  item: ThinkingItem | ContentItem,
  event: NormalizedAgentEvent,
  text: string,
): boolean {
  if (!item.recoveredSnapshotText?.startsWith(text.trim())) return false;
  const nextTool = turn.items
    .slice(turn.items.indexOf(item) + 1)
    .find(candidate => candidate.type === 'tool');
  // The history repair describes the text before this Tool. Its protected
  // prefix cannot veto a later authoritative correction of the same owner.
  return Boolean(nextTool && event.timestamp > 0 && event.timestamp <= nextTool.startedAt);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function activeAgentTailIndex(turn: AssistantTurn): number {
  const pendingToolIndex = turn.items.findIndex(
    item => item.type === 'tool' && item.agentSequencePending === true,
  );
  return (pendingToolIndex < 0 ? turn.items.length : pendingToolIndex) - 1;
}

function pendingRecoveredTool(turn: AssistantTurn): ToolItem | undefined {
  return turn.items.find(
    (item): item is ToolItem => item.type === 'tool' && item.agentSequencePending === true,
  );
}

function thinkingBeforeTool(turn: AssistantTurn, tool: ToolItem): ThinkingItem | undefined {
  const toolIndex = turn.items.indexOf(tool);
  if (toolIndex < 0) return undefined;
  for (let index = toolIndex - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === 'tool') break;
    if (item.type === 'thinking') return item;
  }
  return undefined;
}

function contentBeforeTool(turn: AssistantTurn, tool: ToolItem): ContentItem | undefined {
  const toolIndex = turn.items.indexOf(tool);
  if (toolIndex < 0) return undefined;
  for (let index = toolIndex - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === 'tool') break;
    if (item.type === 'content') return item;
  }
  return undefined;
}

function activeAgentTail(turn: AssistantTurn): TurnItem | undefined {
  return turn.items[activeAgentTailIndex(turn)];
}

function appendAgentItem(turn: AssistantTurn, item: TurnItem): void {
  const pendingToolIndex = turn.items.findIndex(
    candidate => candidate.type === 'tool' && candidate.agentSequencePending === true,
  );
  if (pendingToolIndex < 0) turn.items.push(item);
  else turn.items.splice(pendingToolIndex, 0, item);
}

function itemToolCallId(data: Record<string, unknown>): string | null {
  for (const value of [
    data.toolCallId,
    data.tool_call_id,
    data.toolUseId,
    data.tool_use_id,
    data.callId,
  ]) {
    const explicit = stringValue(value)?.trim();
    if (explicit) return explicit;
  }
  const itemId = stringValue(data.itemId)?.trim() ?? '';
  const match = /^(?:tool|command|patch):(.+)$/i.exec(itemId);
  return match?.[1]?.trim() || null;
}

function eventItemId(data: Record<string, unknown>): string | null {
  return stringValue(data.itemId)?.trim() || stringValue(data.id)?.trim() || null;
}

function activityEventIdentity(event: NormalizedAgentEvent): string {
  const segmentFirstSeq = snapshotSegmentFirstSeq(event);
  if (segmentFirstSeq !== null && (event.stream === 'thinking' || event.stream === 'assistant')) {
    return `segment:${JSON.stringify([event.stream, segmentFirstSeq])}`;
  }
  if (event.stream === 'tool') {
    const toolCallId = itemToolCallId(event.data);
    if (toolCallId) return `tool:${JSON.stringify(toolCallId)}`;
  }
  if (event.stream === 'item') {
    const kind = stringValue(event.data.kind)?.trim() || 'item';
    const itemId = eventItemId(event.data) ?? 'latest';
    return `item:${JSON.stringify([kind, itemId])}`;
  }
  const itemId = eventItemId(event.data);
  return itemId
    ? `stream:${JSON.stringify([event.stream, itemId])}`
    : `stream:${JSON.stringify(event.stream)}`;
}

function toolTerminalIdentity(ownerIdentity: string): string {
  return `${ownerIdentity}:result`;
}

function isTerminalToolEvent(event: NormalizedAgentEvent): boolean {
  if (event.stream !== 'tool') return false;
  const phase = stringValue(event.data.phase)?.trim().toLowerCase();
  return phase === 'result' || phase === 'error' || phase === 'failed';
}

function fillsMissingToolInput(turn: AssistantTurn, event: NormalizedAgentEvent): boolean {
  if (event.stream !== 'tool' || event.deliveryEvent !== 'session.tool') return false;
  const normalized = normalizeToolEvent(event.data);
  const existing = normalized.toolCallId ? turn.toolById.get(normalized.toolCallId) : undefined;
  return (
    existing !== undefined &&
    existing.status !== 'running' &&
    existing.input === undefined &&
    normalized.input !== undefined &&
    normalized.input !== null
  );
}

function acceptsBackfillSequence(turn: AssistantTurn, event: NormalizedAgentEvent): boolean {
  if (fillsMissingToolInput(turn, event)) return true;
  const ownerIdentity = activityEventIdentity(event);
  const sequences = turn.activityEventSeqById;
  if (event.stream === 'tool' && !isTerminalToolEvent(event)) {
    const terminalSeq = sequences?.get(toolTerminalIdentity(ownerIdentity));
    if (terminalSeq !== undefined && event.agentSeq <= terminalSeq) return false;
  }
  const previous = sequences?.get(ownerIdentity);
  return previous === undefined || event.agentSeq > previous;
}

function recordActivitySequence(turn: AssistantTurn, event: NormalizedAgentEvent): void {
  const ownerIdentity = activityEventIdentity(event);
  const sequences = (turn.activityEventSeqById ??= new Map());
  sequences.set(ownerIdentity, Math.max(sequences.get(ownerIdentity) ?? -1, event.agentSeq));
  if (isTerminalToolEvent(event)) {
    const terminalIdentity = toolTerminalIdentity(ownerIdentity);
    sequences.set(
      terminalIdentity,
      Math.max(sequences.get(terminalIdentity) ?? -1, event.agentSeq),
    );
  }
}

function insertAgentItemBySequence(turn: AssistantTurn, item: TurnItem): void {
  const insertionIndex = turn.items.findIndex(candidate =>
    candidate.type === 'tool' && candidate.agentSequencePending === true
      ? candidate.agentSequenceUnconfirmed === true ||
        (item.startedAt > 0 && item.startedAt <= candidate.startedAt)
      : candidate.type === 'tool' &&
          candidate.agentSequenceUnconfirmed === true &&
          candidate.historyCompletedAt !== undefined &&
          item.startedAt > 0
        ? item.startedAt <= candidate.historyCompletedAt
        : candidate.firstSeq > item.firstSeq,
  );
  if (insertionIndex < 0) turn.items.push(item);
  else turn.items.splice(insertionIndex, 0, item);
}

export function confirmRecoveredToolSequence(
  turn: AssistantTurn,
  tool: ToolItem,
  seq: number,
  timestamp: number,
  source: 'agent' | 'history' = 'agent',
): boolean {
  if (
    tool.agentSequencePending !== true &&
    tool.agentSequenceUnconfirmed !== true &&
    (source === 'history' || seq >= tool.firstSeq)
  )
    return false;
  let toolIndex = turn.items.indexOf(tool);
  delete tool.agentSequencePending;
  if (source === 'history') {
    tool.agentSequenceUnconfirmed = true;
  } else {
    tool.firstSeq = seq;
    delete tool.agentSequenceUnconfirmed;
    delete tool.historyCompletedAt;
    if (toolIndex >= 0) {
      turn.items.splice(toolIndex, 1);
      insertAgentItemBySequence(turn, tool);
      toolIndex = turn.items.indexOf(tool);
    }
  }
  const previous = toolIndex > 0 ? turn.items[toolIndex - 1] : undefined;
  for (const item of turn.items) {
    if (
      item.type === 'content' &&
      item !== previous &&
      item.followingToolCallId === tool.toolCallId
    ) {
      delete item.followingToolCallId;
    }
  }
  if (previous?.type === 'thinking' && previous.status === 'running') {
    previous.status = 'completed';
    previous.lastSeq = Math.max(previous.lastSeq, seq);
    previous.updatedAt = Math.max(previous.updatedAt, timestamp);
  } else if (previous?.type === 'content') {
    if (previous.status === 'streaming') previous.status = 'completed';
    previous.followingToolCallId = tool.toolCallId;
    previous.lastSeq = Math.max(previous.lastSeq, seq);
    previous.updatedAt = Math.max(previous.updatedAt, timestamp);
  }
  return true;
}

export function hydrateToolPrecedingThinking(
  turn: AssistantTurn,
  tool: ToolItem,
  text: string | null,
  authoritative: boolean,
  seq: number,
  timestamp: number,
  dependencies: TranscriptReducerDependencies,
): boolean {
  if (!authoritative && tool.agentSequencePending !== true) return false;
  const normalizedText = text?.trim() || null;
  const authoritativeText = authoritative ? normalizedText : null;
  const existing = thinkingBeforeTool(turn, tool);
  if (existing) {
    let changed = false;
    if (normalizedText && existing.text !== normalizedText) {
      existing.text = authoritative
        ? normalizedText
        : updateSnapshot(existing.text, normalizedText, false);
      changed = true;
    }
    if (
      authoritativeText &&
      existing.recoveredSnapshotText === undefined &&
      existing.text === authoritativeText &&
      changed
    ) {
      existing.recoveredSnapshotText = authoritativeText;
    }
    if (existing.status === 'running') {
      existing.status = 'completed';
      changed = true;
    }
    existing.lastSeq = Math.max(existing.lastSeq, seq);
    existing.updatedAt = Math.max(existing.updatedAt, timestamp);
    return changed;
  }
  if (!normalizedText) return false;
  const toolIndex = turn.items.indexOf(tool);
  if (toolIndex < 0) return false;
  let insertionIndex = toolIndex;
  while (insertionIndex > 0 && turn.items[insertionIndex - 1].type !== 'tool') {
    insertionIndex -= 1;
  }
  turn.items.splice(insertionIndex, 0, {
    id: dependencies.createId('history-thinking'),
    runId: turn.runId,
    firstSeq: seq,
    lastSeq: seq,
    startedAt: Math.min(timestamp, tool.startedAt),
    updatedAt: timestamp,
    type: 'thinking',
    status: 'completed',
    text: normalizedText,
    ...(authoritativeText ? { recoveredSnapshotText: authoritativeText } : {}),
  });
  return true;
}

export function hydrateToolPrecedingContent(
  turn: AssistantTurn,
  tool: ToolItem,
  text: string | null,
  authoritative: boolean,
  seq: number,
  timestamp: number,
  dependencies: TranscriptReducerDependencies,
): boolean {
  if (!authoritative && tool.agentSequencePending !== true) return false;
  const normalizedText = text?.trim() || null;
  const authoritativeText = authoritative ? normalizedText : null;
  const existing = contentBeforeTool(turn, tool);
  if (existing) {
    let changed = false;
    if (normalizedText && existing.text !== normalizedText) {
      existing.text = authoritative
        ? normalizedText
        : updateSnapshot(existing.text, normalizedText, false);
      changed = true;
    }
    if (
      authoritativeText &&
      existing.recoveredSnapshotText === undefined &&
      existing.text === authoritativeText &&
      changed
    ) {
      existing.recoveredSnapshotText = authoritativeText;
    }
    if (existing.status === 'streaming') {
      existing.status = 'completed';
      changed = true;
    }
    if (existing.followingToolCallId !== tool.toolCallId) {
      existing.followingToolCallId = tool.toolCallId;
      changed = true;
    }
    existing.lastSeq = Math.max(existing.lastSeq, seq);
    existing.updatedAt = Math.max(existing.updatedAt, timestamp);
    return changed;
  }
  if (!normalizedText) return false;
  const toolIndex = turn.items.indexOf(tool);
  if (toolIndex < 0) return false;
  turn.items.splice(toolIndex, 0, {
    id: dependencies.createId('history-content'),
    runId: turn.runId,
    firstSeq: seq,
    lastSeq: seq,
    startedAt: Math.min(timestamp, tool.startedAt),
    updatedAt: timestamp,
    type: 'content',
    status: 'completed',
    text: normalizedText,
    sourceMode: 'snapshot',
    followingToolCallId: tool.toolCallId,
    ...(authoritativeText ? { recoveredSnapshotText: authoritativeText } : {}),
  });
  return true;
}

export function hydrateToolPrecedingSegments(
  turn: AssistantTurn,
  tool: ToolItem,
  segments: RecoveredPreToolSegment[],
  seq: number,
  timestamp: number,
  dependencies: TranscriptReducerDependencies,
): boolean {
  const normalized = segments.flatMap(segment => {
    const text = segment.text.trim();
    return text ? [{ type: segment.type, text } as RecoveredPreToolSegment] : [];
  });
  if (normalized.length === 0) return false;
  const toolIndex = turn.items.indexOf(tool);
  if (toolIndex < 0) return false;
  let startIndex = toolIndex;
  while (startIndex > 0 && turn.items[startIndex - 1].type !== 'tool') startIndex -= 1;
  const existing = turn.items.slice(startIndex, toolIndex);
  const recoveredItems: Array<ThinkingItem | ContentItem> = [];
  const normalizedText = (text: string) => text.replace(/\s+/g, ' ').trim();
  const isPreamble = (item: TurnItem): item is ContentItem =>
    item.type === 'content' && item.preambleItemId !== undefined;
  let cursor = 0;
  let changed = false;

  for (const segment of normalized) {
    // session.message can omit commentary even though the native item stream
    // already displayed it. Align the fields it does carry, consuming each
    // existing owner once; absence from this projection is not a deletion.
    const matchIndex = existing.findIndex(
      (item, index) =>
        index >= cursor &&
        item.type === segment.type &&
        (!isPreamble(item) || normalizedText(segment.text).startsWith(normalizedText(item.text))),
    );
    if (matchIndex >= 0) {
      for (; cursor < matchIndex; cursor += 1) {
        const skipped = existing[cursor];
        if (isPreamble(skipped)) recoveredItems.push(skipped);
      }
      const item = existing[cursor++];
      if (item.type !== 'thinking' && item.type !== 'content') continue;
      if (item.text !== segment.text) {
        item.text = segment.text;
        item.recoveredSnapshotText = segment.text;
        changed = true;
      }
      recoveredItems.push(item);
    } else {
      const base = {
        id: dependencies.createId(`history-${segment.type}`),
        runId: turn.runId,
        firstSeq: seq,
        lastSeq: seq,
        startedAt: Math.min(timestamp, tool.startedAt),
        updatedAt: timestamp,
        status: 'completed' as const,
        text: segment.text,
        recoveredSnapshotText: segment.text,
      };
      recoveredItems.push(
        segment.type === 'thinking'
          ? { ...base, type: 'thinking' }
          : { ...base, type: 'content', sourceMode: 'snapshot' },
      );
    }
  }
  for (; cursor < existing.length; cursor += 1) {
    const remaining = existing[cursor];
    if (isPreamble(remaining)) recoveredItems.push(remaining);
  }
  for (const [index, item] of recoveredItems.entries()) {
    if (item.status === 'running' || item.status === 'streaming') {
      item.status = 'completed';
      item.recoveredSnapshotText = item.text;
      changed = true;
    }
    item.lastSeq = Math.max(item.lastSeq, seq);
    item.updatedAt = Math.max(item.updatedAt, timestamp);
    if (item.type === 'content') {
      const followingToolCallId = index === recoveredItems.length - 1 ? tool.toolCallId : undefined;
      if (item.followingToolCallId !== followingToolCallId) {
        if (followingToolCallId) item.followingToolCallId = followingToolCallId;
        else delete item.followingToolCallId;
        changed = true;
      }
    }
  }
  if (
    existing.length !== recoveredItems.length ||
    existing.some((item, index) => item !== recoveredItems[index])
  ) {
    turn.items.splice(startIndex, existing.length, ...recoveredItems);
    changed = true;
  }
  return changed;
}

function completeRunningThinking(turn: AssistantTurn, seq: number, now: number): void {
  const tail = activeAgentTail(turn);
  if (tail?.type === 'thinking' && tail.status === 'running') {
    tail.status = 'completed';
    tail.lastSeq = seq;
    tail.updatedAt = now;
  }
}

function completeStreamingContent(turn: AssistantTurn, seq: number, now: number): void {
  const tail = activeAgentTail(turn);
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
    firstSeq: snapshotSegmentFirstSeq(event) ?? event.agentSeq,
    lastSeq: event.agentSeq,
    startedAt: segmentStartedAt(event),
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
  const tail = activeAgentTail(turn);
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
  backfill = false,
): void {
  const snapshot = stringValue(event.data.thinking) ?? stringValue(event.data.text);
  const delta = stringValue(event.data.delta);
  const isDelta = delta !== null && (snapshot === null || !snapshot.trim());
  const text = isDelta ? delta : (snapshot ?? delta);
  if (text === null) return;
  if (!text.trim()) {
    const tail = textOwnerForEvent(turn, event, backfill);
    // Empty snapshots are transport/control frames, not process boundaries. A
    // whitespace-only delta can still be meaningful inside an existing stream.
    if (isDelta && tail?.type === 'thinking' && tail.status === 'running' && tail.text) {
      tail.text += text;
      tail.lastSeq = event.agentSeq;
      tail.updatedAt = event.timestamp;
    }
    return;
  }
  const normalizedText = text.trim();
  const recovered =
    snapshotSegmentFirstSeq(event) === null
      ? turn.items.find(
          (item): item is ThinkingItem =>
            item.type === 'thinking' &&
            typeof item.recoveredSnapshotText === 'string' &&
            item.recoveredSnapshotText.includes(normalizedText),
        )
      : undefined;
  if (recovered) {
    recovered.lastSeq = Math.max(recovered.lastSeq, event.agentSeq);
    recovered.updatedAt = Math.max(recovered.updatedAt, event.timestamp);
    if (recovered.recoveredSnapshotText === normalizedText) {
      delete recovered.recoveredSnapshotText;
    }
    return;
  }
  const recoveredTool =
    snapshotSegmentFirstSeq(event) === null ? pendingRecoveredTool(turn) : undefined;
  if (recoveredTool) {
    const existing = thinkingBeforeTool(turn, recoveredTool);
    if (existing) {
      const authoritativeText = existing.recoveredSnapshotText;
      if (authoritativeText) {
        existing.text = authoritativeText;
      } else {
        existing.text = isDelta
          ? `${existing.text}${text}`
          : updateSnapshot(existing.text, text, event.data.replace === true);
      }
      existing.status = 'completed';
      existing.lastSeq = event.agentSeq;
      existing.updatedAt = event.timestamp;
      return;
    }
    hydrateToolPrecedingThinking(
      turn,
      recoveredTool,
      text,
      false,
      event.agentSeq,
      event.timestamp,
      dependencies,
    );
    return;
  }
  const tail = textOwnerForEvent(turn, event, backfill);
  if (!backfill && tail?.type !== 'thinking')
    completeStreamingContent(turn, event.agentSeq, event.timestamp);
  if (
    tail?.type === 'thinking' &&
    (tail.status === 'running' || backfill || snapshotSegmentFirstSeq(event) !== null)
  ) {
    tail.text = isDelta
      ? `${tail.text}${text}`
      : updateSnapshot(
          tail.text,
          text,
          event.data.replace === true && !preservesRecoveredText(turn, tail, event, text),
        );
    if (!isDelta && tail.recoveredSnapshotText === text.trim()) delete tail.recoveredSnapshotText;
    tail.lastSeq = event.agentSeq;
    tail.updatedAt = event.timestamp;
    return;
  }
  const item: ThinkingItem = {
    ...createBase(turn, event, dependencies, 'thinking'),
    type: 'thinking',
    status:
      backfill && turn.items.some(candidate => candidate.firstSeq > event.agentSeq)
        ? 'completed'
        : 'running',
    text,
  };
  if (backfill || snapshotSegmentFirstSeq(event) !== null) insertAgentItemBySequence(turn, item);
  else appendAgentItem(turn, item);
}

function reducePreamble(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
): void {
  const text = readPreambleText(event.data);
  if (!text) return;
  const itemId = eventItemId(event.data);
  const nativeFirstSeq = snapshotSegmentFirstSeq(event);
  const existing = turn.items.find(
    (item): item is ContentItem =>
      item.type === 'content' &&
      item.preambleItemId !== undefined &&
      (itemId !== null
        ? item.preambleItemId === itemId
        : nativeFirstSeq !== null
          ? item.firstSeq === nativeFirstSeq
          : item.preambleItemId === '' && item.status === 'streaming'),
  );
  const content = reduceContent(
    turn,
    {
      ...event,
      stream: 'assistant',
      data: {
        text,
        replace: true,
        progressSegmentFirstSeq: existing?.firstSeq ?? nativeFirstSeq ?? event.agentSeq,
        progressSegmentStartedAt:
          typeof event.data.progressSegmentStartedAt === 'number'
            ? event.data.progressSegmentStartedAt
            : (existing?.startedAt ?? event.timestamp),
      },
    },
    dependencies,
    true,
  );
  if (!content) return;
  content.preambleItemId = itemId ?? '';
  if (event.data.phase === 'end') content.status = 'completed';
  finishTextBeforeKnownBoundaries(turn);
}

function reduceContent(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
  backfill = false,
): ContentItem | null {
  const snapshot = stringValue(event.data.text);
  const delta = stringValue(event.data.delta);
  // Native agent assistant snapshots are scoped to the current model message.
  // Only chat snapshots/finals can represent the cumulative visible turn.
  const isDelta = delta !== null && (snapshot === null || !snapshot.trim());
  const text = isDelta ? delta : (snapshot ?? delta);
  if (text === null) return null;
  if (!text.trim()) {
    const tail = textOwnerForEvent(turn, event, backfill);
    if (isDelta && tail?.type === 'content' && tail.status === 'streaming' && tail.text) {
      tail.text += text;
      tail.sourceMode = 'delta';
      tail.lastSeq = event.agentSeq;
      tail.updatedAt = event.timestamp;
      return tail;
    }
    return null;
  }
  if (snapshotSegmentFirstSeq(event) === null && snapshot !== null && snapshot.trim()) {
    const normalizedSnapshot = snapshot.trim();
    const recovered = turn.items.find(
      (item): item is ContentItem =>
        item.type === 'content' &&
        item.preambleItemId === undefined &&
        typeof item.recoveredSnapshotText === 'string' &&
        item.recoveredSnapshotText.startsWith(normalizedSnapshot),
    );
    if (recovered) {
      recovered.lastSeq = Math.max(recovered.lastSeq, event.agentSeq);
      recovered.updatedAt = Math.max(recovered.updatedAt, event.timestamp);
      if (recovered.recoveredSnapshotText === normalizedSnapshot) {
        delete recovered.recoveredSnapshotText;
      }
      return recovered;
    }
  }
  const recoveredTool =
    snapshotSegmentFirstSeq(event) === null ? pendingRecoveredTool(turn) : undefined;
  if (recoveredTool) {
    const existing = contentBeforeTool(turn, recoveredTool);
    if (existing) {
      const authoritativeText = existing.recoveredSnapshotText;
      if (authoritativeText) {
        existing.text = authoritativeText;
      } else {
        existing.text = isDelta
          ? `${existing.text}${text}`
          : updateSnapshot(existing.text, text, event.data.replace === true);
      }
      existing.status = 'completed';
      existing.followingToolCallId = recoveredTool.toolCallId;
      existing.lastSeq = event.agentSeq;
      existing.updatedAt = event.timestamp;
      return existing;
    }
    const hydrated = hydrateToolPrecedingContent(
      turn,
      recoveredTool,
      text,
      false,
      event.agentSeq,
      event.timestamp,
      dependencies,
    );
    return hydrated ? (contentBeforeTool(turn, recoveredTool) ?? null) : null;
  }
  const tail = textOwnerForEvent(turn, event, backfill);
  if (!backfill && tail?.type !== 'content')
    completeRunningThinking(turn, event.agentSeq, event.timestamp);
  const replace = event.data.replace === true;
  if (
    tail?.type === 'content' &&
    (tail.status === 'streaming' || backfill || snapshotSegmentFirstSeq(event) !== null)
  ) {
    if (isDelta && !replace) {
      tail.text += text;
      tail.sourceMode = 'delta';
    } else {
      tail.text = updateSnapshot(
        tail.text,
        text,
        replace && !preservesRecoveredText(turn, tail, event, text),
      );
      tail.sourceMode = replace ? 'replaceable' : 'snapshot';
      if (tail.recoveredSnapshotText === text.trim()) delete tail.recoveredSnapshotText;
    }
    tail.lastSeq = event.agentSeq;
    tail.updatedAt = event.timestamp;
    return tail;
  }
  const item: ContentItem = {
    ...createBase(turn, event, dependencies, 'content'),
    type: 'content',
    status:
      backfill && turn.items.some(candidate => candidate.firstSeq > event.agentSeq)
        ? 'completed'
        : 'streaming',
    text,
    sourceMode: replace ? 'replaceable' : isDelta ? 'delta' : 'snapshot',
  };
  if (backfill || snapshotSegmentFirstSeq(event) !== null) {
    const followingItem = turn.items.find(candidate => candidate.firstSeq > event.agentSeq);
    if (followingItem?.type === 'tool') item.followingToolCallId = followingItem.toolCallId;
    insertAgentItemBySequence(turn, item);
  } else {
    appendAgentItem(turn, item);
  }
  return item;
}

function applyTerminalGuardObservationDecision(
  turn: AssistantTurn,
  observation: TerminalGuardObservation,
): void {
  if (observation.action === 'update') return;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type !== 'content' || item.terminalGuardObservationToken !== observation.token) {
      continue;
    }
    if (observation.action === 'rollback') turn.items.splice(index, 1);
    else delete item.terminalGuardObservationToken;
  }
}

function reduceTool(
  turn: AssistantTurn,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
  backfill = false,
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
    if (backfill && existing.agentSequencePending !== true && existing.lastSeq >= event.agentSeq) {
      // A result may arrive before its start payload on the session subscription.
      // Fill only the absent input; an older event cannot revise terminal output.
      if (fillsMissingToolInput(turn, event)) {
        existing.input = resolved.input;
        if (existing.name === 'tool') existing.name = resolved.name;
        return true;
      }
      return false;
    }
    const preserveExistingTerminal = backfill && existing.status !== 'running';
    confirmRecoveredToolSequence(turn, existing, event.agentSeq, event.timestamp);
    if (!preserveExistingTerminal || existing.name === 'tool') existing.name = resolved.name;
    if (
      resolvedInput !== undefined &&
      resolvedInput !== null &&
      (!preserveExistingTerminal || existing.input === undefined)
    ) {
      existing.input = resolvedInput;
    }
    if (
      resolved.output !== null &&
      !outputlessSessionsYieldResult &&
      (!preserveExistingTerminal || existing.output === undefined)
    ) {
      existing.output = resolved.output;
    }
    if (
      resolved.error !== null &&
      !outputlessSessionsYieldResult &&
      (!preserveExistingTerminal || existing.error === undefined)
    ) {
      existing.error = resolved.error;
    }
    if (!preserveExistingTerminal && (existing.status === 'running' || status !== 'running')) {
      existing.status = status;
    }
    existing.lastSeq = Math.max(existing.lastSeq, event.agentSeq);
    existing.updatedAt = Math.max(existing.updatedAt, event.timestamp);
    return true;
  }

  if (!backfill) {
    completeRunningThinking(turn, event.agentSeq, event.timestamp);
    const previous = activeAgentTail(turn);
    if (previous?.type === 'content' && previous.status === 'streaming') {
      previous.status = 'completed';
      previous.followingToolCallId = toolCallId;
      previous.lastSeq = event.agentSeq;
      previous.updatedAt = event.timestamp;
    }
  }
  const item: ToolItem = {
    ...createBase(turn, event, dependencies, 'tool'),
    type: 'tool',
    status,
    toolCallId,
    name: resolved.name,
    ...(resolvedInput !== undefined && resolvedInput !== null ? { input: resolvedInput } : {}),
    ...(normalized.output !== null && !outputlessSessionsYieldResult
      ? { output: normalized.output }
      : {}),
    ...(normalized.error !== null && !outputlessSessionsYieldResult
      ? { error: normalized.error }
      : {}),
  };
  if (backfill) insertAgentItemBySequence(turn, item);
  else appendAgentItem(turn, item);
  turn.toolById.set(toolCallId, item);
  return true;
}

function admitTurn(
  state: ChatTranscriptState,
  event: NormalizedAgentEvent,
  dependencies: TranscriptReducerDependencies,
  allowSequenceBackfill = false,
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
    (admission === 'ignored-sequence' && !allowSequenceBackfill) ||
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
  options: AgentEventReduceOptions = {},
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
  const lateStartTool =
    event.stream === 'tool' &&
    event.data.phase === 'start' &&
    event.deliveryEvent === 'agent' &&
    options.allowSequenceBackfill !== true &&
    options.replaySnapshot !== true &&
    previousTurn?.runId === event.runId &&
    admission !== 'ignored-run' &&
    admission !== 'ignored-terminal'
      ? previousTurn.toolById.get(itemToolCallId(event.data) ?? '')
      : undefined;
  if (
    lateStartTool &&
    lateStartTool.status !== 'running' &&
    lateStartTool.agentSequenceUnconfirmed !== true &&
    event.agentSeq < lateStartTool.firstSeq
  ) {
    // A result can win delivery while its original start is still queued. The
    // start supplies ordering only; the terminal owner fence still protects
    // status, output, and all later payload updates.
    confirmRecoveredToolSequence(previousTurn!, lateStartTool, event.agentSeq, event.timestamp);
    state.revision += 1;
    return 'applied';
  }
  const isSequenceBackfill = admission === 'ignored-sequence';
  if (
    isSequenceBackfill &&
    (!options.allowSequenceBackfill ||
      !previousTurn ||
      !acceptsBackfillSequence(previousTurn, event))
  ) {
    return 'ignored-sequence';
  }
  if (admission === 'ignored-run' || admission === 'ignored-terminal') return 'ignored-run';
  // Snapshot owners may be newer than the live transport. Their fences dedupe
  // that owner's delayed frames, without discarding other owners in between.
  if (previousTurn?.runId === event.runId && !acceptsBackfillSequence(previousTurn, event)) {
    if (!options.replaySnapshot) {
      previousTurn.lastAgentSeq = Math.max(previousTurn.lastAgentSeq, event.agentSeq);
    }
    return 'ignored-sequence';
  }
  const turn = admitTurn(state, event, dependencies, isSequenceBackfill);
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
  const insertBySequence =
    options.replaySnapshot === true ||
    isSequenceBackfill ||
    event.agentSeq <= (turn.lastSnapshotAgentSeq ?? -1);
  if (event.stream === 'thinking') {
    reduceThinking(turn, event, dependencies, insertBySequence);
  } else if (event.stream === 'assistant') {
    const observation = readTerminalGuardObservation(event.data);
    if (observation?.action === 'commit' || observation?.action === 'rollback') {
      applyTerminalGuardObservationDecision(turn, observation);
    } else {
      const content = reduceContent(turn, event, dependencies, insertBySequence);
      if (content && observation?.action === 'update') {
        content.terminalGuardObservationToken = observation.token;
      }
    }
  } else if (event.stream === 'tool') {
    reduceTool(turn, event, dependencies, insertBySequence);
  } else if (event.stream === 'item' && readPreambleText(event.data) !== null) {
    reducePreamble(turn, event, dependencies);
  } else if (
    event.stream === 'lifecycle' ||
    event.stream === 'item' ||
    event.stream === 'compaction'
  ) {
    // Ordering still advances for admitted non-display Agent events.
    if (event.stream === 'item') {
      const recoveredTool = turn.toolById.get(itemToolCallId(event.data) ?? '');
      if (recoveredTool?.agentSequencePending === true) {
        confirmRecoveredToolSequence(turn, recoveredTool, event.agentSeq, event.timestamp);
        recoveredTool.lastSeq = Math.max(recoveredTool.lastSeq, event.agentSeq);
      }
    }
  }

  // New Gateway releases can add non-display streams (for example plan and
  // run_status). They still advance the per-run high-water mark used to reject
  // stale or duplicate events. Agent sequences are ordered but not contiguous:
  // replaceable snapshots may be coalesced or dropped for a slow subscriber.
  recordActivitySequence(turn, event);
  if (options.replaySnapshot) {
    turn.lastSnapshotAgentSeq = Math.max(turn.lastSnapshotAgentSeq ?? -1, event.agentSeq);
  } else {
    turn.lastAgentSeq = Math.max(turn.lastAgentSeq, event.agentSeq);
  }
  if (insertBySequence || snapshotSegmentFirstSeq(event) !== null) {
    finishTextBeforeKnownBoundaries(turn);
  }
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
    const tail = activeAgentTail(turn);
    if (tail?.type === 'content' && currentSegmentText) {
      tail.text = updateSnapshot(tail.text, currentSegmentText, true);
      tail.updatedAt = now;
    } else if (currentSegmentText) {
      appendAgentItem(turn, {
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
