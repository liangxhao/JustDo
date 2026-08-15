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
