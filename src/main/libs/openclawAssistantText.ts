const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const collectTextChunks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => collectTextChunks(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const chunks: string[] = [];
  if (typeof value.text === 'string') {
    const text = value.text.trim();
    if (text) {
      chunks.push(text);
    }
  }
  if (typeof value.output_text === 'string') {
    const text = value.output_text.trim();
    if (text) {
      chunks.push(text);
    }
  }

  if (value.content !== undefined) {
    chunks.push(...collectTextChunks(value.content));
  }
  if (value.parts !== undefined) {
    chunks.push(...collectTextChunks(value.parts));
  }
  if (value.candidates !== undefined) {
    chunks.push(...collectTextChunks(value.candidates));
  }
  if (value.response !== undefined) {
    chunks.push(...collectTextChunks(value.response));
  }

  return chunks;
};

/**
 * OpenClaw special marker indicating no assistant text reply (only tool calls).
 * This marker should be filtered out from display.
 */
const NO_REPLY_MARKER = 'NO_REPLY';

/**
 * Filter out OpenClaw special markers from text content.
 * Conservative approach: only filter EXACT matches, not prefixes.
 * This avoids accidentally filtering user text like "NO" (negative response).
 *
 * During streaming, "NO" may briefly appear before "NO_REPLY" completes,
 * but the final sync will clear it. This is acceptable UX tradeoff.
 */
const filterSpecialMarkers = (text: string): string => {
  // Only filter if text exactly matches the marker (no other content)
  // This is conservative - we don't filter prefixes to avoid false positives
  if (text === NO_REPLY_MARKER) {
    return '';
  }
  return text;
};

export function extractOpenClawAssistantStreamText(payload: unknown): string {
  const chunks = collectTextChunks(payload);
  const rawText = chunks.join('\n').trim();
  return filterSpecialMarkers(rawText);
}
