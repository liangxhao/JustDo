import type {
  AssistantTurn,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
} from './chat-transcript-state';

export interface ProcessSummaryTimelineItem {
  kind: 'process-summary';
  key: string;
  runId: string;
  items: Array<ThinkingItem | ToolItem>;
  thinkingCount: number;
  toolCount: number;
  errorCount: number;
  interruptedCount: number;
}

export interface ContentTimelineItem {
  kind: 'content';
  key: string;
  item: ContentItem;
}

export interface TerminalTimelineItem {
  kind: 'terminal';
  key: string;
  item: TerminalItem;
}

export type ActiveTurnTimelineItem =
  ProcessSummaryTimelineItem | ContentTimelineItem | TerminalTimelineItem;

export function projectTurnItems(turn: AssistantTurn | null): ActiveTurnTimelineItem[] {
  if (!turn) return [];
  const projected: ActiveTurnTimelineItem[] = [];
  let archived: Array<ThinkingItem | ToolItem> = [];
  let summarySegment = 0;

  const flushSummary = () => {
    if (archived.length === 0) return;
    const first = archived[0];
    projected.push({
      kind: 'process-summary',
      key: `process:${turn.runId}:${summarySegment}:${first.id}`,
      runId: turn.runId,
      items: archived,
      thinkingCount: archived.filter(item => item.type === 'thinking').length,
      toolCount: archived.filter(item => item.type === 'tool').length,
      errorCount: archived.filter(item => item.status === 'failed').length,
      interruptedCount: archived.filter(
        item => item.status === 'cancelled' || item.status === 'interrupted',
      ).length,
    });
    archived = [];
    summarySegment += 1;
  };

  for (const item of turn.items) {
    if (item.type === 'thinking' || item.type === 'tool') {
      archived.push(item);
      continue;
    }

    flushSummary();
    if (item.type === 'content') {
      projected.push({ kind: 'content', key: item.id, item });
      summarySegment += 1;
    } else {
      projected.push({ kind: 'terminal', key: item.id, item });
      summarySegment += 1;
    }
  }
  flushSummary();
  return projected;
}
