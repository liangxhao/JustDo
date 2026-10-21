import type { GatewayMessage } from '../../types';
import type { AssistantTurn, CompactionItem } from '../chat-transcript-state';
import { asToolRecord } from '../tools/tool-message-adapter';

export function setCompactionMessage(item: CompactionItem, message: GatewayMessage): void {
  item.message = message;
  const phase = message.__openclaw?.phase;
  item.status =
    phase === 'in-progress'
      ? 'running'
      : phase === 'failed'
        ? 'failed'
        : phase === 'aborted'
          ? 'cancelled'
          : 'completed';
}

export function compactionEventId(data: Record<string, unknown>): string | undefined {
  if (typeof data.operationId === 'string') return `operation:${data.operationId}`;
  if (typeof data.itemId === 'string') return `item:${data.itemId}`;
  return undefined;
}

export function findTurnCompaction(turn: AssistantTurn | null, eventId?: string) {
  return turn?.items
    .slice()
    .reverse()
    .find(
      (item): item is CompactionItem =>
        item.type === 'compaction' &&
        item.eventId === eventId &&
        (eventId !== undefined ||
          !item.message ||
          item.message.__openclaw?.phase === 'in-progress'),
    );
}

/** Match only producer identities, never summary text, entry order, or a run-id suffix. */
export function matchesCompactionHistory(item: CompactionItem, message: unknown): boolean {
  const record = asToolRecord(message);
  const marker = asToolRecord(record?.__openclaw);
  if (marker?.kind !== 'compaction' || typeof marker.id !== 'string') return false;
  if (item.historyEntryId && item.historyEntryId !== marker.id) return false;
  for (const runId of [marker.runId, marker.run_id, record?.runId, record?.run_id]) {
    if (typeof runId === 'string' && runId !== item.runId) return false;
  }
  return (
    item.historyEntryId === marker.id ||
    (item.eventId !== undefined && compactionEventId(marker) === item.eventId)
  );
}

export function isTurnCompactionMessage(turn: AssistantTurn, message: unknown): boolean {
  const marker = asToolRecord(asToolRecord(message)?.__openclaw);
  return turn.items.some(
    item =>
      item.type === 'compaction' &&
      (matchesCompactionHistory(item, message) ||
        (marker?.kind === 'compaction-status' &&
          typeof marker.id === 'string' &&
          item.message?.__openclaw?.id === marker.id)),
  );
}
