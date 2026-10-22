import {
  HISTORY_FAILURE_PARTIAL_MAX_BLOCKS,
  HISTORY_FAILURE_PARTIAL_MAX_CHARS,
  HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX,
  type HistoryFailureContentBlock,
  type HistoryFailurePartial,
} from './contracts/history-failure';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const CONTROL_REPLY_TOKENS = ['NO_REPLY', 'ANNOUNCE_SKIP', 'REPLY_SKIP', 'HEARTBEAT_OK'];
const CONTROL_REPLY_SEQUENCE_PREFIX = new RegExp(
  `^(?:(?:${CONTROL_REPLY_TOKENS.join('|')})\\s+)+([A-Z_]+)$`,
  'i',
);
const CONTROL_REPLY_PATTERNS = CONTROL_REPLY_TOKENS.map(token => ({
  token,
  exact: new RegExp(`^\\s*${token}(?:\\s+${token})*\\s*$`, 'i'),
  trailing: new RegExp(`(?:^|\\s+|\\*+)${token}(?:\\s+${token})*\\s*$`, 'i'),
}));
// Locked native stream-message-shared fallback, not an assistant partial reply.
const STREAM_ERROR_FALLBACK_TEXT = '[assistant turn failed before producing content]';

function withoutStreamErrorPrefix(value: string): string {
  return value.startsWith(STREAM_ERROR_FALLBACK_TEXT)
    ? value.slice(STREAM_ERROR_FALLBACK_TEXT.length)
    : value;
}

// The native display-only control-token stripper is not exported by the SDK.
// Keep its token-only/repeated-fragment/trailing semantics on this recovery path.
function stripControlReplies(value: string): string {
  const normalized = value.trim();
  const withoutPunctuation = normalized.replace(/^\p{P}+|\p{P}+$/gu, '');
  const fragment = CONTROL_REPLY_SEQUENCE_PREFIX.exec(normalized)?.[1]?.toUpperCase();
  if (
    CONTROL_REPLY_PATTERNS.some(
      ({ token, exact }) =>
        exact.test(normalized) ||
        exact.test(withoutPunctuation) ||
        (fragment !== undefined && token.startsWith(fragment)),
    )
  )
    return '';
  let stripped = value;
  for (;;) {
    const previous = stripped;
    for (const { trailing } of CONTROL_REPLY_PATTERNS) {
      if (trailing.test(stripped)) stripped = stripped.replace(trailing, '').trim();
    }
    if (stripped === previous) return stripped;
  }
}

export function isEmptyFailureSourceContent(message: RecordValue): boolean {
  const isEmpty = (content: unknown): boolean => {
    if (content == null) return true;
    if (typeof content === 'string')
      return !stripControlReplies(withoutStreamErrorPrefix(content)).trim();
    if (!Array.isArray(content)) return false;
    if (
      !content.every(
        block => isRecord(block) && block.type === 'text' && typeof block.text === 'string',
      )
    )
      return false;
    const values = content.map((block, index) =>
      index === 0 ? withoutStreamErrorPrefix(block.text) : block.text,
    );
    return !stripControlReplies(values.join('\n')).trim();
  };
  return (
    isEmpty(message.content) &&
    isEmpty(message.openclawDisplayContent) &&
    isEmpty(typeof message.text === 'string' ? message.text : undefined)
  );
}

function markTruncatedContent(
  content: HistoryFailureContentBlock[],
  maxChars: number,
): HistoryFailureContentBlock[] {
  let remaining = maxChars - HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX.length;
  if (remaining <= 0) return [];
  const bounded: HistoryFailureContentBlock[] = [];
  for (const block of content) {
    if (remaining <= 0) break;
    const value = block.type === 'text' ? block.text : block.thinking;
    let text = value.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    remaining -= text.length;
    bounded.push(
      block.type === 'text' ? { type: 'text', text } : { type: 'thinking', thinking: text },
    );
  }
  const last = bounded.at(-1);
  if (last?.type === 'text') last.text += HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX;
  else if (last?.type === 'thinking') last.thinking += HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX;
  return bounded;
}

/** Project failed text/reasoning only; never return signatures, tools or diagnostics. */
export function projectFailurePartialContent(
  message: RecordValue,
  redact: (value: string) => string,
  maxChars = HISTORY_FAILURE_PARTIAL_MAX_CHARS,
): HistoryFailurePartial | undefined {
  const runId = isRecord(message.__openclaw) ? message.__openclaw.runId : undefined;
  if (
    message.role !== 'assistant' ||
    message.stopReason !== 'error' ||
    message.display === false ||
    message.openclawDisplayContent !== undefined ||
    typeof runId !== 'string' ||
    !runId.trim() ||
    maxChars <= 0
  )
    return;
  const source =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  // Do not replace mixed Tool/media projections with a text-only reconstruction.
  if (
    !Array.isArray(source) ||
    !source.every(
      block =>
        isRecord(block) &&
        ((block.type === 'text' && typeof block.text === 'string') ||
          (block.type === 'thinking' && typeof block.thinking === 'string')),
    )
  )
    return;
  let firstText = true;
  const sourceText = source.flatMap(block => {
    if (block.type !== 'text') return [];
    const value = firstText ? withoutStreamErrorPrefix(block.text) : block.text;
    firstText = false;
    return [value];
  });
  const hideAllText = !stripControlReplies(sourceText.join('\n')).trim();
  const content: HistoryFailureContentBlock[] = [];
  const limit = Math.min(maxChars, HISTORY_FAILURE_PARTIAL_MAX_CHARS);
  let remaining = limit;
  let truncated = false;
  firstText = true;
  for (const block of source) {
    let value = block.thinking;
    if (block.type === 'text') {
      const raw = firstText ? withoutStreamErrorPrefix(block.text) : block.text;
      firstText = false;
      value = hideAllText ? '' : stripControlReplies(raw);
    }
    if (!value.trim()) continue;
    if (remaining <= 0 || content.length >= HISTORY_FAILURE_PARTIAL_MAX_BLOCKS) {
      truncated = true;
      break;
    }
    const safe = redact(value);
    let bounded = safe.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
    truncated ||= bounded.length < safe.length;
    remaining -= bounded.length;
    content.push(
      block.type === 'text'
        ? { type: 'text', text: bounded }
        : { type: 'thinking', thinking: bounded },
    );
  }
  const projected = truncated ? markTruncatedContent(content, limit) : content;
  if (projected.some(block => (block.type === 'text' ? block.text : block.thinking).trim())) {
    return { runId, content: projected, truncated };
  }
}
