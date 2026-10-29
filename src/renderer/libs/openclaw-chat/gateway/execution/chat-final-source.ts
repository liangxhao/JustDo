import type { NormalizedChatEvent } from '@shared/openclaw/agentEvent';

import type { AssistantTurn, ContentItem } from '../../model/chat-transcript-state';
import { isLocallyOptimisticHistoryTail } from '../../model/history/optimistic-history-tail';
import { readTranscriptIdentity } from '../../model/history/transcript-identity';
import { shouldHideMessage } from '../../pipeline/history-display-normalizer';
import { isTruncatedHistoryMessage } from '../history/chat-history-protocol';

const FINAL_STOP_REASONS = new Set(['stop', 'length', 'end_turn']);
const TOOL_CONTENT_TYPES = new Set(['toolcall', 'tooluse', 'functioncall']);
const MEDIA_CONTENT_TYPES = new Set(['image', 'audio', 'video', 'attachment']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function inputKey(message: unknown): string | null {
  const record = asRecord(message);
  return readString(asRecord(record?.__openclaw)?.idempotencyKey) ??
    readString(record?.idempotencyKey);
}

function nativeIdentity(message: unknown) {
  const identity = readTranscriptIdentity(message);
  return identity?.kind.startsWith('openclaw-') ? identity : null;
}

/** Select only the durable row belonging to this terminal's actual message. */
export function findPersistedChatFinal(
  event: NormalizedChatEvent,
  messages: readonly unknown[],
  turn: AssistantTurn | null,
): unknown | null {
  if (event.state !== 'final' || !event.runId) return null;
  const eventIdentity = nativeIdentity(event.message);
  const eventInputKey = inputKey(event.message);
  const latestBody = turn?.runId === event.runId
    ? [...turn.items].reverse().find((item): item is ContentItem =>
        item.type === 'content' && item.preambleItemId === undefined &&
        !item.assistantTextScopeSuppressed && !item.assistantTextSourcePending &&
        Boolean(item.text.trim()),
      )
    : undefined;
  const liveScope = latestBody && turn && !turn.items.slice(turn.items.indexOf(latestBody) + 1)
    .some(item => item.type === 'tool' || item.type === 'compaction')
    ? latestBody.assistantTextScopeId
    : undefined;
  let latestNativeRunRow = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const record = asRecord(message);
    const metadata = asRecord(record?.__openclaw);
    const identity = nativeIdentity(message);
    const sameRun = (metadata?.runId ?? record?.runId) === event.runId;
    if (latestNativeRunRow < 0 && identity && sameRun && !isLocallyOptimisticHistoryTail(message)) {
      latestNativeRunRow = index;
    }
    if (
      record?.role !== 'assistant' || !identity ||
      !sameRun ||
      isLocallyOptimisticHistoryTail(message) || isTruncatedHistoryMessage(message) ||
      shouldHideMessage(message) ||
      record.phase === 'commentary' || record.channel === 'commentary' ||
      asRecord(record.openclawStreamFallback)?.source === 'segment' ||
      !FINAL_STOP_REASONS.has(String(record.stopReason ?? record.stop_reason).toLowerCase())
    ) continue;
    if (Array.isArray(record.content) && record.content.some(block =>
      TOOL_CONTENT_TYPES.has(String(asRecord(block)?.type ?? '').toLowerCase().replace(/_/g, '')),
    )) continue;
    const hasVisibleContent = typeof record.content === 'string' ? record.content.trim()
      : typeof record.text === 'string' ? record.text.trim()
        : Array.isArray(record.content) && record.content.some(block => {
          const value = asRecord(block);
          return (typeof value?.text === 'string' && value.text.trim()) ||
            MEDIA_CONTENT_TYPES.has(String(value?.type));
        });
    if (!hasVisibleContent) continue;

    // Explicit message identity takes precedence over a run or text resemblance.
    if (eventIdentity) {
      if (eventIdentity.kind !== identity.kind || eventIdentity.value !== identity.value) continue;
      if (eventInputKey && inputKey(message) && eventInputKey !== inputKey(message)) continue;
    } else if (eventInputKey) {
      if (eventInputKey !== inputKey(message)) continue;
    } else if (
      index !== latestNativeRunRow || !liveScope ||
      asRecord(record.openclawDelivery)?.messageScopeId !== liveScope
    ) continue;
    return message;
  }
  return null;
}
