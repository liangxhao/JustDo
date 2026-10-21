import type { ProcessSummaryTimelineItem } from './project-turn-items';

interface KeyedTimelineItem {
  kind: string;
  key: string;
}

function isProcessSummary(
  item: KeyedTimelineItem,
): item is KeyedTimelineItem & ProcessSummaryTimelineItem {
  return item.kind === 'process-summary';
}

/**
 * Coalesces summaries only after the complete visible timeline is composed.
 * Keeping the first summary key preserves the existing disclosure DOM node.
 */
export function coalesceAdjacentProcessSummaries<T extends KeyedTimelineItem>(
  items: readonly T[],
): T[] {
  const result: T[] = [];

  for (const item of items) {
    const previous = result[result.length - 1];
    if (!previous || !isProcessSummary(previous) || !isProcessSummary(item)) {
      result.push(item);
      continue;
    }

    result[result.length - 1] = {
      ...previous,
      items: [...previous.items, ...item.items],
      thinkingCount: previous.thinkingCount + item.thinkingCount,
      toolCount: previous.toolCount + item.toolCount,
      errorCount: previous.errorCount + item.errorCount,
      interruptedCount: previous.interruptedCount + item.interruptedCount,
    } as T;
  }

  return result;
}
