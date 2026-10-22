import {
  BrowserExtensionCompactionKind,
  type BrowserExtensionMessageDisplay,
} from '../../../shared/browser/browserExtensionDisplay';
import { isFailedRunMessage } from '../../../shared/openclaw/runFailureDisplay';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const PROCESS_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'reasoning',
  'redacted_thinking',
  'tool_use',
  'tool_call',
  'toolcall',
  'tool_result',
  'toolresult',
]);
const COMPACTION_KINDS = new Set<string>(Object.values(BrowserExtensionCompactionKind));

export function readBrowserExtensionHistoryDisplay(value: unknown): {
  display?: BrowserExtensionMessageDisplay;
  compactionMessage?: Record<string, unknown>;
} {
  const outer = record(value);
  const message = record(outer?.message) ?? outer;
  if (!message || outer?.display === false || message.display === false) return {};
  const marker = record(message.__openclaw) ?? record(outer?.__openclaw);
  const display: BrowserExtensionMessageDisplay = {};
  const sourceId = marker?.id ?? message.id ?? outer?.id;
  if (typeof sourceId === 'string' && sourceId.trim()) display.sourceId = sourceId;
  const fallback = record(message.openclawStreamFallback ?? outer?.openclawStreamFallback);
  if (
    fallback?.source === 'segment' &&
    typeof fallback.itemId === 'string' &&
    fallback.itemId.trim()
  )
    display.sourceSegmentId = fallback.itemId;
  if (isFailedRunMessage(value)) display.nativeFailure = true;
  const stopReason = message.stopReason ?? message.stop_reason;
  if (stopReason === 'error' || stopReason === 'aborted') display.stopReason = stopReason;
  if (
    Array.isArray(message.content) &&
    message.content.some(block => {
      const type = record(block)?.type;
      return typeof type !== 'string' || !PROCESS_BLOCK_TYPES.has(type.toLowerCase());
    })
  )
    display.keepVisible = true;

  if (marker?.kind === 'reset') {
    display.kind = 'phase-boundary';
    return {
      display,
      compactionMessage: {
        role: 'system',
        content: '',
        __openclaw: {
          kind: 'reset',
          ...(marker.planImplementation === true ? { planImplementation: true } : {}),
        },
      },
    };
  }

  if (typeof marker?.kind === 'string' && COMPACTION_KINDS.has(marker.kind)) {
    display.kind = marker.kind as BrowserExtensionMessageDisplay['kind'];
    if (typeof marker.phase === 'string') display.phase = marker.phase;
    const safeMarker: Record<string, unknown> = { kind: marker.kind };
    for (const name of ['id', 'phase', 'summary', 'reason']) {
      if (typeof marker[name] === 'string') safeMarker[name] = marker[name];
    }
    for (const name of ['tokensBefore', 'tokensAfter']) {
      if (typeof marker[name] === 'number' && Number.isFinite(marker[name]) && marker[name] >= 0)
        safeMarker[name] = marker[name];
    }
    const timestamp = message.timestamp ?? outer?.timestamp;
    return {
      display,
      compactionMessage: {
        role: 'system',
        content: '',
        ...(typeof timestamp === 'number' || typeof timestamp === 'string' ? { timestamp } : {}),
        __openclaw: safeMarker,
      },
    };
  }
  return Object.keys(display).length ? { display } : {};
}
