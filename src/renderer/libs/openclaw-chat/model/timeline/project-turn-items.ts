import { isPresentPlanToolName } from '@shared/cowork/interactions/planPreview';
import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';
import type { McpAppPreview } from '@shared/plugins/mcpApps';

import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseQuestions,
} from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import { decodeNativeAppReference } from '../../pipeline/native-app-reference';
import {
  decodeNativeBoardResult,
  nativeBoardReferenceOrder,
  type NativeWidgetReference,
} from '../../pipeline/native-board';
import { decodeNativeCanvasResult, stripNativeWidgetFallbacks } from '../../pipeline/native-canvas';
import { decodeNativeMcpAppResult } from '../../pipeline/native-mcp-app';
import type {
  AssistantTurn,
  CompactionItem,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
} from '../chat-transcript-state';
import type { RunActivity, RunProgressStage, WaitingStatusProjection } from '../turn/run-activity';

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

export interface CompactionTimelineItem {
  kind: 'compaction';
  key: string;
  item: CompactionItem;
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

export interface QuestionPresentationTimelineItem {
  kind: 'question-presentation';
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
  activity?: Readonly<RunActivity>;
}

export interface WaitingStatusTimelineItem {
  kind: 'waiting-status';
  key: string;
  status: WaitingStatusProjection;
}

export interface NativeWidgetTimelineItem {
  kind: 'native-widget';
  key: string;
  preview: NativeWidgetReference;
}

export interface NativeMcpAppTimelineItem {
  kind: 'mcp-app';
  key: string;
  preview: McpAppPreview;
}

export interface AppReferenceTimelineItem {
  kind: 'app-reference';
  key: string;
  reference: McpAppContentReference;
}

export type ActiveTurnTimelineItem =
  | AppReferenceTimelineItem
  | NativeWidgetTimelineItem
  | NativeMcpAppTimelineItem
  | ProcessSummaryTimelineItem
  | LiveProcessTimelineItem
  | ProgressReceiptTimelineItem
  | PlanPresentationTimelineItem
  | QuestionPresentationTimelineItem
  | ContentTimelineItem
  | CompactionTimelineItem
  | TerminalTimelineItem
  | WaitingTimelineItem
  | WaitingStatusTimelineItem;

/** Only a valid native question call or structured result gets the question view. */
export function isQuestionPresentationTool(tool: ToolItem): boolean {
  if (tool.name !== ASK_USER_QUESTION_TOOL_NAME) return false;
  if (tool.status === 'completed' && tool.presentation?.questionResult) return true;
  if (!['running', 'cancelled', 'interrupted', 'failed'].includes(tool.status)) return false;
  const input = tool.input;
  return Boolean(
    input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      parseQuestions((input as Record<string, unknown>).questions),
  );
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
  activity: RunActivity | null = null,
): ActiveTurnTimelineItem[] {
  const working =
    activity && (!turn || activity.runId === turn.runId)
      ? {
          startedAt: activity.startedAt,
          stage: activity.stage,
          activity,
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
  const widgets = new Map<ToolItem, NativeWidgetReference>();
  const boardNames = new Map<string, ToolItem>();
  const apps = new Map<ToolItem, McpAppPreview>();
  const references = new Map<ToolItem, McpAppContentReference>();
  const appViews = new Set<string>();
  const nativeDocIds = new Set<string>();
  for (const item of turn.items) {
    if (item.type !== 'tool' || item.status !== 'completed') continue;
    const board = decodeNativeBoardResult(item.output, item.name, item.toolCallId, item);
    const preview = decodeNativeCanvasResult(item.output, item.name, item.toolCallId);
    const app = decodeNativeMcpAppResult(item.output, item.name, item.toolCallId);
    const reference = decodeNativeAppReference(item.output, item.name, item.toolCallId, item.runId);
    if (reference) references.set(item, reference);
    if (app && !appViews.has(app.viewId)) {
      apps.set(item, app);
      appViews.add(app.viewId);
    }
    if (board) {
      if (board.suppressedInlineDocId) nativeDocIds.add(board.suppressedInlineDocId);
      const previous = boardNames.get(board.name);
      const previousReference = previous && widgets.get(previous);
      if (
        !previousReference ||
        (previousReference.kind === 'native-board' &&
          nativeBoardReferenceOrder(board) > nativeBoardReferenceOrder(previousReference))
      ) {
        if (previous) widgets.delete(previous);
        widgets.set(item, board);
        boardNames.set(board.name, item);
      }
    } else if (preview && !nativeDocIds.has(preview.docId)) {
      widgets.set(item, preview);
      nativeDocIds.add(preview.docId);
    }
  }

  const fallbackIds = new Set([...nativeDocIds, ...appViews]);
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
    if (
      item.type === 'content' &&
      (item.assistantTextScopeSuppressed || item.assistantTextSourcePending)
    )
      continue;
    const content =
      item.type === 'content'
        ? { ...item, text: stripNativeWidgetFallbacks(item.text, fallbackIds) }
        : null;
    if (content && !content.text.trim()) continue;
    if (item.type === 'thinking' || item.type === 'tool') {
      if (item.type === 'tool') {
        if (item.status === 'failed') failedTools.push(item);
        if (isQuestionPresentationTool(item)) {
          flushSummary();
          projected.push({ kind: 'question-presentation', key: `question:${item.id}`, item });
          summarySegment += 1;
          continue;
        }
        const normalizedName = item.name.trim().toLowerCase();
        const widget = widgets.get(item);
        const app = apps.get(item);
        const reference = references.get(item);
        if (reference) {
          archived.push(item);
          flushSummary();
          projected.push({
            kind: 'app-reference',
            key: `app-reference:${item.id}`,
            reference,
          });
          summarySegment += 1;
          continue;
        }
        if (app) {
          archived.push(item);
          flushSummary();
          projected.push({ kind: 'mcp-app', key: `mcp-app:${item.id}`, preview: app });
          summarySegment += 1;
          continue;
        }
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
    if (item.type === 'compaction') {
      if (item.message) projected.push({ kind: 'compaction', key: item.id, item });
      summarySegment += 1;
    } else if (item.type === 'content') {
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
