import { isLocallyOptimisticHistoryTail } from './optimistic-history-tail';

type SessionMessageEnvelope = Record<string, unknown>;

interface SessionMessageIdentity {
  role: string;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
  runId: string | null;
  isImported: boolean;
  externalSource: string | null;
}

export type SessionMessageApplyResult =
  | {
      kind: 'applied';
      messages: unknown[];
      message: Record<string, unknown>;
      role: string;
      sequence: number | null;
    }
  | {
      kind: 'fallback';
      messages: unknown[];
      reason:
        'invalid' | 'missing-identity' | 'unowned-message' | 'unowned-assistant' | 'partial-import';
      sequence: number | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeRunId(value: unknown): string | null {
  const runId = readString(value);
  return runId?.endsWith(':user') ? runId.slice(0, -':user'.length) || null : runId;
}

function readIdentity(
  message: unknown,
  envelope: SessionMessageEnvelope,
): SessionMessageIdentity | null {
  const record = asRecord(message);
  const role = readString(record?.role)?.toLowerCase();
  if (!record || !role) return null;

  const metadata = asRecord(record.__openclaw);
  const importedFrom = readString(metadata?.importedFrom);
  const cliSessionId = readString(metadata?.cliSessionId);
  const externalId = readString(metadata?.externalId);
  const idempotencyKey =
    readString(metadata?.idempotencyKey) ??
    readString(record.idempotencyKey) ??
    readString(envelope.idempotencyKey) ??
    readString(envelope.clientRunId);
  const persistedRunId = normalizeRunId(idempotencyKey);
  const envelopeRunId = normalizeRunId(envelope.runId);
  const metadataRunId = normalizeRunId(metadata?.runId ?? metadata?.run_id);
  const mirroredMessage = readString(metadata?.mirrorOrigin) !== null;
  const isCliAssistant = role === 'assistant' && readString(record.api)?.toLowerCase() === 'cli';
  const canonicalPersistedRunId =
    isCliAssistant && persistedRunId?.startsWith('cli-assistant:')
      ? readString(persistedRunId.slice('cli-assistant:'.length))
      : persistedRunId;
  const optimisticRunId =
    metadata && Object.keys(metadata).every(key => key === 'idempotencyKey')
      ? canonicalPersistedRunId
      : null;

  return {
    role,
    id: readString(metadata?.id) ?? readString(envelope.messageId),
    sequence:
      readPositiveSafeInteger(metadata?.seq) ?? readPositiveSafeInteger(envelope.messageSeq),
    idempotencyKey,
    runId:
      role === 'assistant'
        ? (metadataRunId ??
          envelopeRunId ??
          (isCliAssistant || !mirroredMessage ? canonicalPersistedRunId : null) ??
          optimisticRunId)
        : (metadataRunId ?? canonicalPersistedRunId ?? envelopeRunId),
    isImported: Boolean(importedFrom || cliSessionId || externalId),
    externalSource:
      importedFrom && cliSessionId && externalId
        ? JSON.stringify([importedFrom, cliSessionId, externalId])
        : null,
  };
}

function sameIdentity(left: SessionMessageIdentity | null, right: SessionMessageIdentity): boolean {
  if (!left || left.role !== right.role) return false;
  if (left.isImported || right.isImported) {
    if (!left.isImported || !right.isImported) return false;
    if (left.externalSource || right.externalSource) {
      return Boolean(left.externalSource && left.externalSource === right.externalSource);
    }
    return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
  }
  if (left.id || right.id) return Boolean(left.id && right.id && left.id === right.id);
  if (left.sequence !== null || right.sequence !== null) {
    return left.sequence !== null && right.sequence !== null && left.sequence === right.sequence;
  }
  return Boolean(
    left.idempotencyKey && right.idempotencyKey && left.idempotencyKey === right.idempotencyKey,
  );
}

function mergeMessage(
  messages: readonly unknown[],
  incoming: Record<string, unknown>,
  identity: SessionMessageIdentity,
): unknown[] {
  const existingIndex = messages.findIndex(message => {
    const existingIdentity = readIdentity(message, {});
    if (sameIdentity(existingIdentity, identity)) return true;
    return Boolean(
      isLocallyOptimisticHistoryTail(message) &&
      existingIdentity?.role === identity.role &&
      ((existingIdentity.idempotencyKey &&
        existingIdentity.idempotencyKey === identity.idempotencyKey) ||
        (existingIdentity.runId && existingIdentity.runId === identity.runId)),
    );
  });
  if (existingIndex >= 0) {
    const existing = asRecord(messages[existingIndex]);
    const replacement =
      identity.role === 'user' &&
      isLocallyOptimisticHistoryTail(existing) &&
      Array.isArray(existing?.content)
        ? { ...incoming, content: existing.content }
        : incoming;
    return messages.map((message, index) => (index === existingIndex ? replacement : message));
  }

  if (identity.sequence !== null) {
    const insertionIndex = messages.findIndex(message => {
      const sequence = readIdentity(message, {})?.sequence;
      return sequence !== null && sequence !== undefined && sequence > identity.sequence!;
    });
    if (insertionIndex >= 0) {
      return [...messages.slice(0, insertionIndex), incoming, ...messages.slice(insertionIndex)];
    }
  }
  return [...messages, incoming];
}

/**
 * Applies a durable session.message row immediately when its identity and run
 * ownership are strong enough. Callers keep history reload as the fallback
 * for legacy rows and ambiguous assistant ownership.
 */
export function applySessionMessagePayload(
  messages: readonly unknown[],
  payload: unknown,
  options: {
    activeRunId: string | null;
    runActive: boolean | undefined;
    isRecentTerminalRun: (runId: string) => boolean;
  },
): SessionMessageApplyResult {
  const event = asRecord(payload);
  const sourceMessage = event?.message;
  if (!event || !asRecord(sourceMessage)) {
    return { kind: 'fallback', messages: [...messages], reason: 'invalid', sequence: null };
  }
  const identity = readIdentity(sourceMessage, event);
  if (!identity) {
    return { kind: 'fallback', messages: [...messages], reason: 'invalid', sequence: null };
  }
  if (!identity.id && !identity.idempotencyKey && identity.sequence === null) {
    return {
      kind: 'fallback',
      messages: [...messages],
      reason: 'missing-identity',
      sequence: null,
    };
  }
  if (identity.isImported && !identity.externalSource) {
    const persistedSequence = readPositiveSafeInteger(
      asRecord(asRecord(sourceMessage)?.__openclaw)?.seq,
    );
    if (persistedSequence === null) {
      return {
        kind: 'fallback',
        messages: [...messages],
        reason: 'partial-import',
        sequence: identity.sequence,
      };
    }
  }

  const matchesOptimisticMessage = messages.some(message => {
    if (!isLocallyOptimisticHistoryTail(message)) return false;
    const existingIdentity = readIdentity(message, {});
    return Boolean(
      existingIdentity?.role === identity.role &&
      ((existingIdentity.idempotencyKey &&
        existingIdentity.idempotencyKey === identity.idempotencyKey) ||
        (existingIdentity.runId && existingIdentity.runId === identity.runId)),
    );
  });
  if (identity.role === 'user') {
    if (
      options.activeRunId &&
      identity.runId !== options.activeRunId &&
      !matchesOptimisticMessage &&
      options.runActive !== false
    ) {
      return {
        kind: 'fallback',
        messages: [...messages],
        reason: 'unowned-message',
        sequence: identity.sequence,
      };
    }
  } else {
    const eventRunId = normalizeRunId(event.runId);
    const previousRunAssistant = Boolean(
      identity.role === 'assistant' &&
      identity.sequence !== null &&
      identity.runId &&
      options.activeRunId &&
      identity.runId !== options.activeRunId,
    );
    const producerRunId = identity.runId && identity.runId === eventRunId ? identity.runId : null;
    const currentRunAssistant = Boolean(
      identity.role === 'assistant' &&
      identity.id &&
      !identity.isImported &&
      producerRunId &&
      (options.activeRunId === producerRunId ||
        (!options.activeRunId && options.isRecentTerminalRun(producerRunId))),
    );
    if (!previousRunAssistant && !currentRunAssistant) {
      return {
        kind: 'fallback',
        messages: [...messages],
        reason: 'unowned-assistant',
        sequence: identity.sequence,
      };
    }
  }

  const sourceRecord = asRecord(sourceMessage)!;
  const sourceMetadata = asRecord(sourceRecord.__openclaw);
  const message = {
    ...sourceRecord,
    __openclaw: {
      ...sourceMetadata,
      ...(identity.id ? { id: identity.id } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      ...(identity.sequence !== null ? { seq: identity.sequence } : {}),
      ...(identity.runId ? { runId: identity.runId } : {}),
    },
  };
  return {
    kind: 'applied',
    messages: mergeMessage(messages, message, identity),
    message,
    role: identity.role,
    sequence: identity.sequence,
  };
}
