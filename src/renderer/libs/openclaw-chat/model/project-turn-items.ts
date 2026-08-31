import { parseExecutionPlanUpdate } from '@shared/openclaw/executionPlan';

import type {
  AssistantTurn,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
} from './chat-transcript-state';
import type { WaitingStatusProjection } from './run-activity';

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

export interface LiveProcessTimelineItem {
  kind: 'live-process';
  key: string;
  item: ThinkingItem | ToolItem;
}

export interface PlanUpdateTimelineItem {
  kind: 'plan-update';
  key: string;
  item: ToolItem;
}

export interface TerminalTimelineItem {
  kind: 'terminal';
  key: string;
  item: TerminalItem;
}

export interface WaitingTimelineItem {
  kind: 'waiting';
  key: string;
}

export interface WaitingStatusTimelineItem {
  kind: 'waiting-status';
  key: string;
  status: WaitingStatusProjection;
}

export type ActiveTurnTimelineItem =
  | ProcessSummaryTimelineItem
  | LiveProcessTimelineItem
  | PlanUpdateTimelineItem
  | ContentTimelineItem
  | TerminalTimelineItem
  | WaitingTimelineItem
  | WaitingStatusTimelineItem;

export function latestPlanUpdateKey(items: readonly ActiveTurnTimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === 'plan-update') return item.key;
  }
  return undefined;
}

function normalFailureText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function duplicatesFailedTool(terminal: TerminalItem, failedTools: readonly ToolItem[]): boolean {
  const message = normalFailureText(terminal.message);
  if (!message) return failedTools.length > 0;
  return failedTools.some(tool => {
    const error = normalFailureText(tool.error);
    const output = normalFailureText(tool.output);
    if (error === message || output === message) return true;
    if (!error) return false;
    const shorter = error.length < message.length ? error : message;
    const longer = error.length < message.length ? message : error;
    return (
      shorter.length >= 12 && shorter.length / longer.length >= 0.5 && longer.includes(shorter)
    );
  });
}

export function projectTurnItems(
  turn: AssistantTurn | null,
  isAwaitingTurn = false,
  waitingStatus: WaitingStatusProjection | null = null,
): ActiveTurnTimelineItem[] {
  if (!turn) {
    const pending = isAwaitingTurn
      ? [{ kind: 'waiting' as const, key: 'waiting:pending-turn' }]
      : [];
    return waitingStatus
      ? [
          ...pending,
          {
            kind: 'waiting-status',
            key: `waiting-status:pending:${waitingStatus.kind}`,
            status: waitingStatus,
          },
        ]
      : pending;
  }
  if (turn.status === 'running' && turn.items.length === 0) {
    const pending: ActiveTurnTimelineItem[] = [{ kind: 'waiting', key: `waiting:${turn.runId}` }];
    if (waitingStatus) {
      pending.push({
        kind: 'waiting-status',
        key: `waiting-status:${turn.runId}:${waitingStatus.kind}`,
        status: waitingStatus,
      });
    }
    return pending;
  }
  const projected: ActiveTurnTimelineItem[] = [];
  let archived: Array<ThinkingItem | ToolItem> = [];
  const failedTools: ToolItem[] = [];
  let summarySegment = 0;

  const isPlanUpdate = (item: ThinkingItem | ToolItem): item is ToolItem =>
    item.type === 'tool' &&
    item.name.toLowerCase() === 'update_plan' &&
    parseExecutionPlanUpdate(item.input) !== null;

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
    if (item.type === 'content' && !item.text.trim()) continue;
    if (item.type === 'thinking' || item.type === 'tool') {
      if (item.type === 'tool' && item.status === 'failed') failedTools.push(item);
      if (isPlanUpdate(item)) {
        flushSummary();
        projected.push({ kind: 'plan-update', key: `plan:${item.id}`, item });
        summarySegment += 1;
        continue;
      }
      if (item.status === 'running') {
        flushSummary();
        projected.push({ kind: 'live-process', key: item.id, item });
        summarySegment += 1;
      } else {
        archived.push(item);
      }
      continue;
    }

    flushSummary();
    if (item.type === 'content') {
      projected.push({ kind: 'content', key: item.id, item });
      summarySegment += 1;
    } else {
      // A failed Tool already has a red status indicator and expandable error
      // details. Suppress only the same failure; a later provider/run error is
      // a separate diagnostic and must remain visible.
      if (item.status === 'error' && duplicatesFailedTool(item, failedTools)) continue;
      projected.push({ kind: 'terminal', key: item.id, item });
      summarySegment += 1;
    }
  }
  flushSummary();
  if (waitingStatus) {
    projected.push({
      kind: 'waiting-status',
      key: `waiting-status:${turn.runId}:${waitingStatus.kind}`,
      status: waitingStatus,
    });
  }
  return projected;
}
