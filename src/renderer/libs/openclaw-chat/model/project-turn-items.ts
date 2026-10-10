import { isPresentPlanToolName } from '@shared/cowork/interactions/planPreview';

import {
  decodeNativeCanvasResult,
  type NativeCanvasPreview,
  stripNativeWidgetFallbacks,
} from '../pipeline/native-canvas';
import type {
  AssistantTurn,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
} from './chat-transcript-state';
import type { RunActivity, RunProgressStage, WaitingStatusProjection } from './run-activity';

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

export interface ProgressReceiptTimelineItem {
  kind: 'progress-receipt';
  key: string;
  item: ToolItem;
}

export interface PlanPresentationTimelineItem {
  kind: 'plan-presentation';
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
  startedAt?: number;
  stage?: RunProgressStage;
  notice?: WaitingStatusProjection;
}

export interface WaitingStatusTimelineItem {
  kind: 'waiting-status';
  key: string;
  status: WaitingStatusProjection;
}

export interface NativeWidgetTimelineItem {
  kind: 'native-widget';
  key: string;
  preview: NativeCanvasPreview;
}

export type ActiveTurnTimelineItem =
  | NativeWidgetTimelineItem
  | ProcessSummaryTimelineItem
  | LiveProcessTimelineItem
  | ProgressReceiptTimelineItem
  | PlanPresentationTimelineItem
  | ContentTimelineItem
  | TerminalTimelineItem
  | WaitingTimelineItem
  | WaitingStatusTimelineItem;

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
  activity: RunActivity | null = null,
): ActiveTurnTimelineItem[] {
  const working =
    activity && (!turn || activity.runId === turn.runId)
      ? {
          startedAt: activity.startedAt,
          stage: activity.stage,
          ...(waitingStatus ? { notice: waitingStatus } : {}),
        }
      : {};
  if (!turn) {
    const pending = isAwaitingTurn
      ? [{ kind: 'waiting' as const, key: 'waiting:pending-turn', ...working }]
      : [];
    return waitingStatus && !activity
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
    const pending: ActiveTurnTimelineItem[] = [
      { kind: 'waiting', key: `waiting:${turn.runId}`, ...working },
    ];
    if (waitingStatus && !activity) {
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
  const widgets = new Map<ToolItem, NativeCanvasPreview>();
  const nativeDocIds = new Set<string>();
  for (const item of turn.items) {
    if (item.type !== 'tool' || item.status !== 'completed') continue;
    const preview = decodeNativeCanvasResult(item.output, item.name, item.toolCallId);
    if (preview && !nativeDocIds.has(preview.docId)) {
      widgets.set(item, preview);
      nativeDocIds.add(preview.docId);
    }
  }

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
    const content =
      item.type === 'content'
        ? { ...item, text: stripNativeWidgetFallbacks(item.text, nativeDocIds) }
        : null;
    if (content && !content.text.trim()) continue;
    if (item.type === 'thinking' || item.type === 'tool') {
      if (item.type === 'tool') {
        if (item.status === 'failed') failedTools.push(item);
        const normalizedName = item.name.trim().toLowerCase();
        const widget = widgets.get(item);
        if (widget) {
          archived.push(item);
          flushSummary();
          projected.push({ kind: 'native-widget', key: `widget:${item.id}`, preview: widget });
          summarySegment += 1;
          continue;
        }
        if (isPresentPlanToolName(item.name)) {
          flushSummary();
          projected.push({ kind: 'plan-presentation', key: `plan:${item.id}`, item });
          summarySegment += 1;
          continue;
        }
        if (normalizedName === 'progress_card') {
          flushSummary();
          projected.push({ kind: 'progress-receipt', key: `progress:${item.id}`, item });
          summarySegment += 1;
          continue;
        }
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
      projected.push({ kind: 'content', key: item.id, item: content! });
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
  if (turn.status === 'running' && activity?.runId === turn.runId) {
    projected.push({ kind: 'waiting', key: `waiting:${turn.runId}`, ...working });
  }
  if (waitingStatus && turn.status === 'running' && !activity) {
    projected.push({
      kind: 'waiting-status',
      key: `waiting-status:${turn.runId}:${waitingStatus.kind}`,
      status: waitingStatus,
    });
  }
  return projected;
}
