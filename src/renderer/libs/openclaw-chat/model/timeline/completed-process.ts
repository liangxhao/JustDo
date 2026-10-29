import { isGatewayInjectedModelRef } from '@shared/providers/modelRef';

import { getTranscriptMedia } from '../../attachments';
import { extractTextCached } from '../../pipeline/message-extract';
import { normalizeMessage } from '../../pipeline/message-normalizer';
import { asToolRecord, unwrapToolMessage } from '../tools/tool-message-adapter';
import { toolOutcome } from '../tools/tool-presentation';
import { isFailedRunMessage } from '../turn/failed-run-message';
import { coalesceAdjacentProcessSummaries } from './coalesce-process-summaries';
import type { ProcessSummaryTimelineItem } from './project-turn-items';
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

function ordinaryAssistantText(item: VisibleTimelineItem): boolean {
  if (item.kind === 'content')
    return item.item.status === 'completed' && Boolean(item.item.text.trim());
  const message = assistantMessage(item);
  if (!message || item.kind !== 'history-message' || item.runState === 'running') return false;
  const records = [asToolRecord(item.message), message].flatMap(source =>
    source ? [source, asToolRecord(source.metadata), asToolRecord(source.__openclaw)] : [],
  );
  if (records.some(source => source && (
    [source.runId, source.run_id].some(value =>
      typeof value === 'string' && value.startsWith('announce:v1:'),
    ) ||
    [source.model, source.modelName].some(value =>
      isGatewayInjectedModelRef(value) ||
      (typeof value === 'string' && /(?:^|\/)delivery-mirror$/i.test(value.trim())),
    ) ||
    source.openclawDeliveryMirror !== undefined
  ))) return false;
  return normalizeMessage(message).content.some(block =>
    block.type === 'text' && Boolean(block.text?.trim()),
  );
}

function hasUnresolvedTool(item: SourceTimelineItem): boolean {
  return item.kind === 'process-summary' && item.items.some(process =>
    process.type === 'tool' && process.status === 'running' && toolOutcome(process) !== 'running',
  );
}

function unresolvedToolSummary(item: VisibleTimelineItem): ProcessSummaryTimelineItem | null {
  if (item.kind !== 'live-process' || item.origin !== 'persisted' || item.item.type !== 'tool')
    return null;
  const tool = item.item;
  if (tool.status !== 'running') return null;
  const outcome = toolOutcome(tool);
  return {
    kind: 'process-summary',
    key: item.key,
    runId: tool.runId,
    items: [outcome === 'running'
      ? { ...tool, presentation: { ...tool.presentation, outcome: 'unknown' } }
      : tool],
    thinkingCount: 0,
    toolCount: 1,
    errorCount: outcome === 'failed' ? 1 : 0,
    interruptedCount: outcome === 'cancelled' || outcome === 'interrupted' ? 1 : 0,
  };
}

function canFold(item: VisibleTimelineItem, foldUnresolvedTools = false): item is SourceTimelineItem {
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
    return item.items.every(process => process.status !== 'running' ||
      (foldUnresolvedTools && process.type === 'tool' && toolOutcome(process) !== 'running'),
    );
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
  /** A host may fold unresolved persisted tools without settling a Tool or run. */
  foldUnresolvedTools?: boolean;
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
    let lastOrdinaryTextIndex = -1;
    if (options.foldUnresolvedTools) {
      for (let index = turn.length - 1; index >= 0; index -= 1) {
        if (ordinaryAssistantText(turn[index].item)) {
          lastOrdinaryTextIndex = index;
          break;
        }
      }
    }
    const flushPrefix = () => {
      if (prefix.length === 0) return;
      const sourceItems = prefix.map(row => row.item) as SourceTimelineItem[];
      const items = options.foldUnresolvedTools
        ? coalesceAdjacentProcessSummaries(sourceItems).map(item => {
            if (item.kind !== 'process-summary') return item;
            const tail = item.items[item.items.length - 1];
            // Missing-result tools become summaries after history identity reconciliation.
            // Retain their native tail through prepends and later result arrival.
            return tail?.id
              ? { ...item, key: `history-folded-process:${tail.type}:${tail.id}` }
              : item;
          })
        : sourceItems;
      result.push({
        item: {
          kind: 'completed-process',
          // Older pages can reveal an earlier prefix of this same process.
          // Its retained tail, rather than the page's first item, owns the shell.
          key: `completed-process:${items[items.length - 1].key}`,
          items,
        },
        showAvatar: prefix.some(row => row.showAvatar && !compactionMarker(row.item)),
        showFooter: false,
      });
      prefix = [];
    };
    turn.forEach((row, index) => {
      if (
        options.foldUnresolvedTools &&
        index < lastOrdinaryTextIndex &&
        !protectedProcessKeys.has(row.item.key) &&
        !options.keepVisibleKeys?.has(row.item.key)
      ) {
        const summary = unresolvedToolSummary(row.item);
        if (summary) row = { ...row, item: summary };
      }
      if (index < finalIndex && !options.keepVisibleKeys?.has(row.item.key) &&
        canFold(row.item, options.foldUnresolvedTools)) {
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
    (row.item.items.every(item => item.kind === 'question-presentation') ||
      (options.foldUnresolvedTools && row.item.items.some(hasUnresolvedTool)))
      ? row.item.items.map((item, index) => ({
          item,
          showAvatar: index === 0 && row.showAvatar,
          showFooter: false,
        }))
      : [row],
  );
  const protectedProcessKeys = new Set<string>();
  if (options.foldUnresolvedTools && options.protectTrailingTurn) {
    let start = 0;
    sourceRows.forEach((row, index) => {
      if (row.item.kind === 'phase-boundary' ||
        (row.item.kind === 'history-message' &&
          unwrapToolMessage(row.item.message)?.role === 'user')) start = index;
    });
    // System/error delivery can flush a rendering segment without ending the
    // active human turn. Only user/phase boundaries release that protection.
    for (const row of sourceRows.slice(start)) protectedProcessKeys.add(row.item.key);
  }
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
        key: `completed-process:${questions[questions.length - 1].item.key}`,
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
