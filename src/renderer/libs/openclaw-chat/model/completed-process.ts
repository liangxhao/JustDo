import { getTranscriptMedia } from '../attachments';
import { extractTextCached } from '../pipeline/message-extract';
import { isFailedRunMessage } from './failed-run-message';
import type {
  SourceTimelineItem,
  VisibleTimelineItem,
  VisibleTimelineRow,
} from './timeline-avatar-state';
import { unwrapToolMessage } from './tool-message-adapter';

function assistantMessage(item: VisibleTimelineItem) {
  if (item.kind !== 'history-message') return null;
  const message = unwrapToolMessage(item.message);
  return message?.role === 'assistant' ? message : null;
}

function canFold(item: VisibleTimelineItem): item is SourceTimelineItem {
  if (item.kind === 'process-summary') {
    return item.items.every(process => process.status !== 'running');
  }
  if (item.kind === 'progress-receipt') return item.item.status !== 'running';
  const message = assistantMessage(item);
  if (item.kind !== 'history-message' || !message || isFailedRunMessage(item.message)) return false;
  if (item.runState && item.runState !== 'completed') return false;
  // Interactive and media deliveries remain directly accessible.
  if (getTranscriptMedia(message).length > 0) return false;
  if (
    Array.isArray(message.content) &&
    message.content.some(block => {
      return !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text';
    })
  )
    return false;
  return Boolean(extractTextCached(message)?.trim());
}

export interface ProcessFoldOptions {
  /** The controller still owns the live tail; do not collapse its persisted prefix. */
  protectTrailingTurn?: boolean;
}

/** Presentation only: user/phase boundaries group rows without claiming a run outcome. */
export function foldCompletedProcessRows(
  rows: readonly VisibleTimelineRow[],
  options: ProcessFoldOptions = {},
): VisibleTimelineRow[] {
  const result: VisibleTimelineRow[] = [];
  let turn: VisibleTimelineRow[] = [];
  const flushTurn = (protectedTurn = false) => {
    let finalIndex = -1;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      if (assistantMessage(turn[index].item)) {
        finalIndex = index;
        break;
      }
    }
    const final = turn[finalIndex]?.item;
    if (
      final?.kind !== 'history-message' ||
      protectedTurn ||
      (final.runState !== undefined && final.runState !== 'completed') ||
      isFailedRunMessage(final.message)
    ) {
      result.push(...turn);
      turn = [];
      return;
    }
    let prefix: VisibleTimelineRow[] = [];
    const flushPrefix = () => {
      if (prefix.length === 0) return;
      const items = prefix.map(row => row.item) as SourceTimelineItem[];
      result.push({
        item: {
          kind: 'completed-process',
          key: `completed-process:${items[0].key}`,
          items,
        },
        showAvatar: prefix[0].showAvatar,
        showFooter: false,
      });
      prefix = [];
    };
    turn.forEach((row, index) => {
      if (index < finalIndex && canFold(row.item)) {
        prefix.push(row);
      } else {
        flushPrefix();
        result.push(row);
      }
    });
    flushPrefix();
    turn = [];
  };
  for (const row of rows) {
    if (
      row.item.kind === 'phase-boundary' ||
      (row.item.kind === 'history-message' && !assistantMessage(row.item))
    ) {
      flushTurn();
      result.push(row);
    } else {
      turn.push(row);
    }
  }
  flushTurn(options.protectTrailingTurn);
  return result;
}

export function unfoldProcessItems(items: readonly VisibleTimelineItem[]): SourceTimelineItem[] {
  return items.flatMap(item => (item.kind === 'completed-process' ? [...item.items] : [item]));
}
