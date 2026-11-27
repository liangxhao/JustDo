import type { McpAppContentReference } from '@shared/plugins/mcpAppReferences';
import type { McpAppPreview } from '@shared/plugins/mcpApps';

import { isPresentPlanToolName } from '@/libs/openclaw-chat/model/turn/plan-preview';

import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseQuestions,
} from '../../../../../../plugins/extensions/ask-user-question/contracts/result';
import { normalizeMessage } from '../../pipeline/message-normalizer';
import { decodeNativeAppReference } from '../../pipeline/native-app-reference';
import {
  decodeNativeBoardResult,
  nativeBoardReferenceOrder,
  type NativeWidgetReference,
} from '../../pipeline/native-board';
import { decodeNativeCanvasResult, stripNativeWidgetFallbacks } from '../../pipeline/native-canvas';
import {
  decodeNativeMcpAppResult,
  stripNativeMcpAppFallbacks,
} from '../../pipeline/native-mcp-app';
import { stripOpenClawLogHintText } from '../../pipeline/system-message-display';
import type {
  AssistantTurn,
  CompactionItem,
  ContentItem,
  TerminalItem,
  ThinkingItem,
  ToolItem,
} from '../chat-transcript-state';
import type { RunActivity, RunProgressStage, WaitingStatusProjection } from '../turn/run-activity';
import { projectProcessVisibility } from './process-visibility';

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
  /** An admitted native owner; presentation adapters may use synthetic item run IDs. */
  nativeRunId?: string;
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
  /** Present for every member of a displayed Tool family, including its root at depth zero. */
  toolDepth?: number;
  /** Display provenance, independent of the Tool's native execution status. */
  origin?: 'persisted';
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

interface FailedToolPosition {
  item: ToolItem;
  index: number;
}

function findMatchingFailedTool(
  terminal: TerminalItem,
  failedTools: readonly FailedToolPosition[],
  foldBoundary: number,
  terminalIndex: number,
): FailedToolPosition | undefined {
  const message = normalFailureText(terminal.message);
  for (let index = failedTools.length - 1; index >= 0; index -= 1) {
    const failed = failedTools[index];
    if (failed.index < foldBoundary) break;
    const tool = failed.item;
    if (
      failed.index >= terminalIndex ||
      tool.runId !== terminal.runId ||
      isQuestionPresentationTool(tool) ||
      isPresentPlanToolName(tool.name) ||
      tool.name.trim().toLowerCase() === 'progress_card'
    ) continue;
    if (!message) return failed;
    const error = normalFailureText(tool.error);
    const displayed = normalFailureText(tool.output ?? tool.error);
    if (displayed === message) return failed;
    if (!error || displayed !== error) continue;
    const shorter = error.length < message.length ? error : message;
    const longer = error.length < message.length ? message : error;
    if (shorter.length >= 12 && shorter.length / longer.length >= 0.5 && longer.includes(shorter))
      return failed;
  }
  return undefined;
}

export function projectTurnItems(
  turn: AssistantTurn | null,
  isAwaitingTurn = false,
  waitingStatus: WaitingStatusProjection | null = null,
  activity: RunActivity | null = null,
): ActiveTurnTimelineItem[] {
  const yieldedWaiting = activity?.stage === 'waiting-continuation' && activity.yielded === true;
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
    const pending = isAwaitingTurn || yieldedWaiting
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
  const pending: Array<ThinkingItem | ToolItem> = [];
  const visibleProcesses = new Set<ThinkingItem | ToolItem>();
  let archived: Array<ThinkingItem | ToolItem> = [];
  const failedTools: FailedToolPosition[] = [];
  const terminalErrors: Array<{ item: TerminalItem; index: number }> = [];
  let foldBoundary = -1;
  let summarySegment = 0;
  const widgets = new Map<ToolItem, NativeWidgetReference>();
  const boardNames = new Map<string, ToolItem>();
  const apps = new Map<ToolItem, McpAppPreview>();
  const references = new Map<ToolItem, McpAppContentReference>();
  const appViews = new Set<string>();
  const nativeDocIds = new Set<string>();
  for (const [index, item] of turn.items.entries()) {
    if (item.type === 'terminal' && item.status === 'error') {
      terminalErrors.push({ item, index });
      continue;
    }
    if (item.type !== 'tool') continue;
    if (item.status === 'failed') failedTools.push({ item, index });
    if (item.status !== 'completed') continue;
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

  // Determine which Tool rows visible text would already collapse.
  const visibleContent = new Map<number, ContentItem>();
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type !== 'content' || item.assistantTextScopeSuppressed || item.assistantTextSourcePending)
      continue;
    const text = stripNativeMcpAppFallbacks(
      stripNativeWidgetFallbacks(item.text, nativeDocIds, appViews),
      appViews,
      nativeDocIds,
    );
    if (!text.trim()) continue;
    visibleContent.set(index, { ...item, text });
    if (index > foldBoundary && item.runId === turn.runId) {
      const displayText = stripOpenClawLogHintText(text, item.status === 'streaming');
      if (normalizeMessage({ role: 'assistant', content: displayText }).content.some(
        block => block.type === 'text' && Boolean(block.text?.trim()),
      )) foldBoundary = index;
    }
  }

  const duplicateErrors = new Set<TerminalItem>();
  for (const { item, index } of terminalErrors) {
    // Suppress the banner only when the matching diagnostic remains available
    // from a Tool row outside the folded process.
    const failed = findMatchingFailedTool(item, failedTools, foldBoundary, index);
    if (failed) duplicateErrors.add(item);
    if (item.runId === turn.runId) foldBoundary = Math.max(foldBoundary, failed?.index ?? index);
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

  const queueProcess = (item: ThinkingItem | ToolItem, index: number) => {
    pending.push(item);
    if (item.status === 'running' || index >= foldBoundary) visibleProcesses.add(item);
  };

  const flushProcesses = (previewTool?: ToolItem) => {
    for (const { item, visible, toolDepth } of projectProcessVisibility(
      pending, process => visibleProcesses.has(process),
    )) {
      if (visible && (item !== previewTool || toolDepth !== undefined)) {
        flushSummary();
        projected.push({
          kind: 'live-process', key: item.id, item,
          ...(toolDepth === undefined ? {} : { toolDepth }),
        });
        summarySegment += 1;
      } else {
        archived.push(item);
      }
    }
    pending.length = 0;
    visibleProcesses.clear();
  };

  const flushBeforePreview = (tool: ToolItem, index: number) => {
    queueProcess(tool, index);
    flushProcesses(tool);
    flushSummary();
  };

  for (const [index, item] of turn.items.entries()) {
    if (item.type === 'content') {
      const content = visibleContent.get(index);
      if (!content) continue;
      flushProcesses();
      flushSummary();
      projected.push({
        kind: 'content', key: item.id, item: content,
        ...(item.runId === turn.runId ? { nativeRunId: turn.runId } : {}),
      });
      summarySegment += 1;
      continue;
    }
    if (item.type === 'thinking' || item.type === 'tool') {
      if (item.type === 'tool') {
        if (isQuestionPresentationTool(item)) {
          flushProcesses();
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
          flushBeforePreview(item, index);
          projected.push({
            kind: 'app-reference',
            key: `app-reference:${item.id}`,
            reference,
          });
          summarySegment += 1;
          continue;
        }
        if (app) {
          flushBeforePreview(item, index);
          projected.push({ kind: 'mcp-app', key: `mcp-app:${item.id}`, preview: app });
          summarySegment += 1;
          continue;
        }
        if (widget) {
          flushBeforePreview(item, index);
          projected.push({ kind: 'native-widget', key: `widget:${item.id}`, preview: widget });
          summarySegment += 1;
          continue;
        }
        if (isPresentPlanToolName(item.name)) {
          flushProcesses();
          flushSummary();
          projected.push({ kind: 'plan-presentation', key: `plan:${item.id}`, item });
          summarySegment += 1;
          continue;
        }
        if (normalizedName === 'progress_card') {
          flushProcesses();
          flushSummary();
          projected.push({ kind: 'progress-receipt', key: `progress:${item.id}`, item });
          summarySegment += 1;
          continue;
        }
      }
      queueProcess(item, index);
      continue;
    }

    flushProcesses();
    flushSummary();
    if (item.type === 'compaction') {
      if (item.message) projected.push({ kind: 'compaction', key: item.id, item });
      summarySegment += 1;
    } else {
      if (duplicateErrors.has(item)) continue;
      projected.push({ kind: 'terminal', key: item.id, item });
      summarySegment += 1;
    }
  }
  flushProcesses();
  flushSummary();
  if ((turn.status === 'running' || yieldedWaiting) && activity?.runId === turn.runId) {
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
