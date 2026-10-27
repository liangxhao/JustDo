import { getTranscriptMedia } from '../../attachments';
import { extractTextCached } from '../../pipeline/message-extract';
import { normalizeMessage } from '../../pipeline/message-normalizer';
import { asToolRecord, unwrapToolMessage } from '../tools/tool-message-adapter';
import { isFailedRunMessage } from '../turn/failed-run-message';
import type {
  SourceTimelineItem,
  VisibleTimelineItem,
  VisibleTimelineRow,
} from './timeline-avatar-state';

const COMPACTION_MARKER_KINDS = new Set(['compaction', 'compaction-status', 'compaction-skipped']);
const SETTLED_COMPACTION_PHASES = new Set(['completed', 'failed', 'aborted', 'skipped']);

function compactionMarker(item: VisibleTimelineItem) {
  if (item.kind !== 'history-message') return null;
  const message = unwrapToolMessage(item.message);
  const marker = asToolRecord(message?.__openclaw) ?? asToolRecord(item.message.__openclaw);
  return marker && typeof marker.kind === 'string' && COMPACTION_MARKER_KINDS.has(marker.kind)
    ? marker
    : null;
}

function assistantMessage(item: VisibleTimelineItem) {
  if (item.kind !== 'history-message' || compactionMarker(item)) return null;
  const message = unwrapToolMessage(item.message);
  return message?.role === 'assistant' ? message : null;
}

function canFold(item: VisibleTimelineItem): item is SourceTimelineItem {
  if (item.kind === 'question-presentation') return true;
  if (item.kind === 'content') {
    return (
      item.item.status === 'completed' &&
      Boolean(item.item.text.trim()) &&
      getTranscriptMedia({ role: 'assistant', content: item.item.text }).length === 0 &&
      normalizeMessage({ role: 'assistant', content: item.item.text }).content.every(
        block => block.type === 'text',
      )
    );
  }
  if (item.kind === 'process-summary') {
    return item.items.every(process => process.status !== 'running');
  }
  if (item.kind === 'progress-receipt') return item.item.status !== 'running';
  const compaction = compactionMarker(item);
  if (compaction) {
    return (
      compaction.kind !== 'compaction-status' ||
      (typeof compaction.phase === 'string' && SETTLED_COMPACTION_PHASES.has(compaction.phase))
    );
  }
  const message = assistantMessage(item);
  if (item.kind !== 'history-message' || !message || isFailedRunMessage(item.message)) return false;
  // A settled run receipt can annotate ordinary commentary as well as its last reply.
  // Preserve explicit native failures below; do not treat the receipt as a content error.
  if (item.runState === 'running') return false;
  const stopReason = message.stopReason ?? message.stop_reason;
  if (stopReason === 'error' || stopReason === 'aborted') return false;
  // Interactive and media deliveries remain directly accessible.
  if (getTranscriptMedia(message).length > 0) return false;
  if (
    Array.isArray(message.content) &&
    message.content.some(block => {
      return !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text';
    })
  )
    return false;
  if (normalizeMessage(message).content.some(block => block.type !== 'text')) return false;
  return Boolean(extractTextCached(message)?.trim());
}

export interface ProcessFoldOptions {
  /** The controller still owns the live tail; do not collapse its persisted prefix. */
  protectTrailingTurn?: boolean;
  /** A host may retain unsupported rich content as a visible presentation boundary. */
  keepVisibleKeys?: ReadonlySet<string>;
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
      const item = turn[index].item;
      const message = item.kind === 'content'
        ? { role: 'assistant', content: item.item.text }
        : assistantMessage(item);
      // Media and delivery directives do not count as the last visible reply.
      if (message && normalizeMessage(message).content.some(block =>
        block.type === 'text' && Boolean(block.text?.trim()),
      )) {
        finalIndex = index;
        break;
      }
    }
    const final = turn[finalIndex]?.item;
    if (
      !final ||
      protectedTurn ||
      (final.kind === 'history-message'
        ? final.runState === 'running'
        : final.kind !== 'content' || final.item.status !== 'completed')
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
        showAvatar: prefix.some(row => row.showAvatar && !compactionMarker(row.item)),
        showFooter: false,
      });
      prefix = [];
    };
    turn.forEach((row, index) => {
      if (index < finalIndex && !options.keepVisibleKeys?.has(row.item.key) && canFold(row.item)) {
        prefix.push(row);
      } else {
        flushPrefix();
        result.push(row);
      }
    });
    flushPrefix();
    turn = [];
  };
  // A pending question may already have its own disclosure in the cached
  // persisted prefix. Rejoin it with adjacent settled process when a final
  // answer arrives, without opening other completed process groups.
  const sourceRows = rows.flatMap(row =>
    row.item.kind === 'completed-process' &&
    row.item.items.every(item => item.kind === 'question-presentation')
      ? row.item.items.map((item, index) => ({
          item,
          showAvatar: index === 0 && row.showAvatar,
          showFooter: false,
        }))
      : [row],
  );
  for (const row of sourceRows) {
    if (
      row.item.kind === 'phase-boundary' ||
      (row.item.kind === 'history-message' &&
        !assistantMessage(row.item) &&
        !compactionMarker(row.item))
    ) {
      flushTurn();
      result.push(row);
    } else {
      turn.push(row);
    }
  }
  flushTurn(options.protectTrailingTurn);
  // Question history uses the existing process disclosure even while the
  // active turn is protected or no final assistant text exists yet. Other
  // live tools and interactive deliveries retain their visibility rules.
  const folded: VisibleTimelineRow[] = [];
  let questions: VisibleTimelineRow[] = [];
  const flushQuestions = () => {
    if (!questions.length) return;
    folded.push({
      item: {
        kind: 'completed-process',
        key: `completed-process:${questions[0].item.key}`,
        items: questions.map(row => row.item as SourceTimelineItem),
      },
      showAvatar: questions.some(row => row.showAvatar),
      showFooter: false,
    });
    questions = [];
  };
  for (const row of result) {
    if (row.item.kind === 'question-presentation') questions.push(row);
    else {
      flushQuestions();
      folded.push(row);
    }
  }
  flushQuestions();
  return folded;
}

export function unfoldProcessItems(items: readonly VisibleTimelineItem[]): SourceTimelineItem[] {
  return items.flatMap(item => (item.kind === 'completed-process' ? [...item.items] : [item]));
}
