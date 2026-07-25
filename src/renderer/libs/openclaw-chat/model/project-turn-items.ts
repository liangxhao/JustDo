import type {
  AssistantTurn,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
  TurnItem,
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

export interface ThinkingTimelineItem {
  kind: 'thinking';
  key: string;
  item: ThinkingItem;
}

export interface ToolTimelineItem {
  kind: 'tool';
  key: string;
  item: ToolItem;
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
  | ProcessSummaryTimelineItem
  | ThinkingTimelineItem
  | ToolTimelineItem
  | ContentTimelineItem
  | TerminalTimelineItem;

export interface TimelinePresentationState {
  visibleSince: ReadonlyMap<string, number>;
  dismissedDiagnosticIds?: ReadonlySet<string>;
  now: number;
  minimumToolVisibleMs?: number;
}

export function recordToolVisibility(
  turn: AssistantTurn | null,
  visibleSince: Map<string, number>,
  now: number,
): void {
  if (!turn) return;
  for (const item of turn.items) {
    if (item.type === 'tool' && !visibleSince.has(item.id)) {
      visibleSince.set(item.id, now);
    }
  }
}

function isSuccessfulProcess(item: TurnItem): item is ThinkingItem | ToolItem {
  return (item.type === 'thinking' || item.type === 'tool') && item.status === 'completed';
}

function canArchive(
  item: ThinkingItem | ToolItem,
  presentation: TimelinePresentationState,
): boolean {
  if (item.type !== 'tool') return true;
  const visibleSince = presentation.visibleSince.get(item.id);
  if (visibleSince === undefined) return true;
  return presentation.now - visibleSince >= (presentation.minimumToolVisibleMs ?? 500);
}

export function projectTurnItems(
  turn: AssistantTurn | null,
  presentation: TimelinePresentationState,
): ActiveTurnTimelineItem[] {
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
    const dismissed = presentation.dismissedDiagnosticIds?.has(item.id) === true;
    const diagnostic =
      (item.type === 'thinking' || item.type === 'tool') &&
      (item.status === 'failed' || item.status === 'cancelled' || item.status === 'interrupted');
    if (diagnostic) {
      archived.push(item);
      flushSummary();
      if (!dismissed) {
        projected.push(
          item.type === 'thinking'
            ? { kind: 'thinking', key: item.id, item }
            : { kind: 'tool', key: item.id, item },
        );
      }
      continue;
    }
    if (isSuccessfulProcess(item) && canArchive(item, presentation)) {
      if (item.type === 'thinking' || item.type === 'tool') archived.push(item);
      continue;
    }

    flushSummary();
    if (item.type === 'thinking') {
      projected.push({ kind: 'thinking', key: item.id, item });
    } else if (item.type === 'tool') {
      projected.push({ kind: 'tool', key: item.id, item });
    } else if (item.type === 'content') {
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
