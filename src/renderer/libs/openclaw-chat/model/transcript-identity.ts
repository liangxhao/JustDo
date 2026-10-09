import { isPresentPlanToolName } from '@shared/cowork/interactions/planPreview';

import { FAILED_RUN_MESSAGE_ID } from '@/libs/openclaw-chat/model/failed-run-message';
import {
  asToolRecord,
  attachedToolMessages,
  readToolName,
  unwrapToolMessage,
} from '@/libs/openclaw-chat/model/tool-message-adapter';

export interface TranscriptIdentity {
  kind: 'openclaw-id' | 'openclaw-seq' | 'durable-id';
  value: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readScalar(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/**
 * Reads the stable identity attached by OpenClaw's transcript/history APIs.
 * Envelope metadata wins over provider-specific top-level identifiers.
 */
export function readTranscriptIdentity(message: unknown): TranscriptIdentity | null {
  const record = asRecord(message);
  if (!record) return null;
  const interruptedOverlayId = readScalar(record.__justdoInterruptedOverlayId);
  if (interruptedOverlayId) {
    return { kind: 'durable-id', value: `interrupted:${interruptedOverlayId}` };
  }
  const failedRunMessageId = readScalar(record[FAILED_RUN_MESSAGE_ID]);
  if (failedRunMessageId) {
    return { kind: 'durable-id', value: `failed-run:${failedRunMessageId}` };
  }
  const marker = asRecord(record.__openclaw);
  const openClawId = readScalar(marker?.id);
  if (openClawId) return { kind: 'openclaw-id', value: openClawId };
  const openClawSeq = readScalar(marker?.seq);
  if (openClawSeq) return { kind: 'openclaw-seq', value: openClawSeq };

  for (const key of ['entryId', 'messageId', 'id', 'seq']) {
    const value = readScalar(record[key]);
    if (value) return { kind: 'durable-id', value: `${key}:${value}` };
  }
  return null;
}

/**
 * Editing or withdrawing a message rewinds the active transcript branch. Once
 * Plan implementation has started, that rewind must stay on the implementation
 * side of the reset boundary; plugin and local workflow state do not rewind
 * with transcript entries.
 */
export function isEntryAfterLatestPlanImplementationReset(
  messages: readonly unknown[],
  entryId: string,
): boolean {
  const normalizedEntryId = entryId.trim();
  if (!normalizedEntryId) return false;
  let latestResetIndex = -1;
  let targetIndex = -1;
  let planPresentedSinceLastReset = false;
  messages.forEach((message, index) => {
    const record = asRecord(message);
    const marker = asRecord(record?.__openclaw);
    if (marker?.kind === 'reset') {
      if (marker.planImplementation === true || planPresentedSinceLastReset) {
        latestResetIndex = index;
      }
      planPresentedSinceLastReset = false;
    } else if (containsPresentPlanTool(message)) {
      planPresentedSinceLastReset = true;
    }
    if (readScalar(marker?.id) === normalizedEntryId) targetIndex = index;
  });
  return targetIndex >= 0 && (latestResetIndex < 0 || targetIndex > latestResetIndex);
}

function containsPresentPlanTool(value: unknown): boolean {
  const message = unwrapToolMessage(value);
  if (!message) return false;
  const candidates = [
    message,
    ...(Array.isArray(message.content)
      ? message.content.flatMap(block => {
          const record = asToolRecord(block);
          return record ? [record] : [];
        })
      : []),
    ...attachedToolMessages(message).flatMap(attached => {
      const record = unwrapToolMessage(attached);
      return record ? [record] : [];
    }),
  ];
  return candidates.some(candidate => isPresentPlanToolName(readToolName(candidate)));
}

/**
 * Identifies one displayed projection at a native history page seam.
 * OpenClaw may project sibling Thinking/Tool/Content rows from one transcript
 * event, so source id/seq alone is not unique. Keep the projection bytes in
 * the key and ignore only history-read timing metadata.
 */
export function readHistoryProjectionIdentity(message: unknown): string | null {
  const identity = readTranscriptIdentity(message);
  const record = asRecord(message);
  if (!identity || !record) return null;
  const metadata = asRecord(record.__openclaw);
  let projection: Record<string, unknown> = record;
  if (metadata) {
    const { recordTimestampMs: _recordTimestampMs, ...stableMetadata } = metadata;
    projection = { ...record, __openclaw: stableMetadata };
  }
  try {
    return `${identity.kind}:${identity.value}:${JSON.stringify(projection)}`;
  } catch {
    return `${identity.kind}:${identity.value}`;
  }
}
