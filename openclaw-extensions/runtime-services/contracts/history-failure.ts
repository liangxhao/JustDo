export const HISTORY_FAILURE_PARTIAL_MAX_CHARS = 200_000;
export const HISTORY_FAILURE_PARTIAL_MAX_BLOCKS = 128;
export const HISTORY_FAILURE_PARTIAL_BATCH_MAX_CHARS = 1_000_000;
export const HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX = '\n...(truncated)...';

export type HistoryFailureContentBlock =
  { type: 'text'; text: string } | { type: 'thinking'; thinking: string };

export type HistoryFailurePartial = {
  runId: string;
  content: HistoryFailureContentBlock[];
  truncated: boolean;
};

/** Accept only the bounded display contract and the source's exact native run. */
export function readHistoryFailurePartial(
  value: unknown,
  expectedRunId: unknown,
): HistoryFailurePartial | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof expectedRunId !== 'string' ||
    !expectedRunId.trim() ||
    record.runId !== expectedRunId ||
    typeof record.truncated !== 'boolean' ||
    !Array.isArray(record.content) ||
    record.content.length === 0 ||
    record.content.length > HISTORY_FAILURE_PARTIAL_MAX_BLOCKS
  )
    return null;
  const content: HistoryFailureContentBlock[] = [];
  let chars = 0;
  for (const value of record.content) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
      chars += block.text.length;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      content.push({ type: 'thinking', thinking: block.thinking });
      chars += block.thinking.length;
    } else return null;
    if (chars > HISTORY_FAILURE_PARTIAL_MAX_CHARS) return null;
  }
  return chars > 0 ? { runId: expectedRunId, content, truncated: record.truncated } : null;
}
