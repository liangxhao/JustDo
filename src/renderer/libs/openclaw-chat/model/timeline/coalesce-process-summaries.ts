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

  for (let index = 0; index < items.length;) {
    const first = items[index++];
    if (!isProcessSummary(first)) {
      result.push(first);
      continue;
    }
    let end = index;
    while (end < items.length && isProcessSummary(items[end])) end += 1;
    if (end === index) {
      result.push(first);
      continue;
    }
    const processes: ProcessSummaryTimelineItem['items'] = [];
    let thinkingCount = first.thinkingCount;
    let toolCount = first.toolCount;
    let errorCount = first.errorCount;
    let interruptedCount = first.interruptedCount;
    for (const process of first.items) processes.push(process);
    for (; index < end; index += 1) {
      const summary = items[index] as T & ProcessSummaryTimelineItem;
      for (const process of summary.items) processes.push(process);
      thinkingCount += summary.thinkingCount;
      toolCount += summary.toolCount;
      errorCount += summary.errorCount;
      interruptedCount += summary.interruptedCount;
    }
    result.push({
      ...first,
      items: processes,
      thinkingCount,
      toolCount,
      errorCount,
      interruptedCount,
    } as T);
  }

  return result;
}
