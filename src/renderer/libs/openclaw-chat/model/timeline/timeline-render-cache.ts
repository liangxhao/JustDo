import {
  type ChatMinimapEntry,
  projectChatMinimapEntries,
  projectChatMinimapTailEntry,
} from './chat-minimap';
import { coalesceAdjacentProcessSummaries } from './coalesce-process-summaries';
import { foldCompletedProcessRows, type ProcessFoldOptions } from './completed-process';
import type { PersistedTimelineItem } from './project-history-timeline';
import type { ActiveTurnTimelineItem } from './project-turn-items';
import {
  prepareVisibleTimelineRows,
  type VisibleTimelineItem,
  type VisibleTimelineRow,
} from './timeline-avatar-state';

export interface PersistedTimelineView {
  timeline: readonly PersistedTimelineItem[];
  rows: readonly VisibleTimelineRow[];
  rowsWithSuppressedFooter: readonly VisibleTimelineRow[];
  rowsWithoutLast: readonly VisibleTimelineRow[];
  rowsWithSuppressedFooterWithoutLast: readonly VisibleTimelineRow[];
  minimapPrefix: readonly ChatMinimapEntry[];
  minimapTail: ChatMinimapEntry | null;
  minimapKeySignature: string;
  assistantTurnOpen: boolean;
  assistantTurnOpenBeforeLast: boolean;
}

export interface IncrementalTimelineView {
  persistedRows: readonly VisibleTimelineRow[];
  seamRow: VisibleTimelineRow | null;
  activeRows: readonly VisibleTimelineRow[];
  minimapPrefix: readonly ChatMinimapEntry[];
  minimapTail: ChatMinimapEntry | null;
  minimapKeySignature: string;
}

function historyMessageRole(
  item: Extract<PersistedTimelineItem, { kind: 'history-message' }>,
): string {
  const outer = item.message as Record<string, unknown>;
  const nested =
    outer.message && typeof outer.message === 'object' && !Array.isArray(outer.message)
      ? (outer.message as Record<string, unknown>)
      : outer;
  return String(nested.role ?? outer.role ?? '').toLowerCase();
}

function endsWithOpenAssistantTurn(items: readonly PersistedTimelineItem[]): boolean {
  let assistantTurnOpen = false;
  for (const item of items) {
    if (item.kind === 'phase-boundary') {
      assistantTurnOpen = false;
      continue;
    }
    if (item.kind !== 'history-message') {
      assistantTurnOpen = true;
      continue;
    }
    const role = historyMessageRole(item);
    if (role === 'user') assistantTurnOpen = false;
    else if (role === 'assistant') assistantTurnOpen = true;
  }
  return assistantTurnOpen;
}

function mergeProcessSummaries(
  persisted: PersistedTimelineItem,
  active: ActiveTurnTimelineItem,
): VisibleTimelineItem | null {
  if (persisted.kind !== 'process-summary' || active.kind !== 'process-summary') return null;
  return coalesceAdjacentProcessSummaries<VisibleTimelineItem>([persisted, active])[0] ?? null;
}

/**
 * Caches every history-sized derivation. Active stream revisions only inspect
 * the active tail plus the final persisted row/minimap entry.
 */
export class PersistedTimelineRenderCache {
  private source: readonly PersistedTimelineItem[] | null = null;
  private protectTrailingTurn = false;
  private foldUnresolvedTools = false;
  private cached: PersistedTimelineView | null = null;
  private buildRevision = 0;

  get revision(): number {
    return this.buildRevision;
  }

  get(
    timeline: readonly PersistedTimelineItem[],
    options: ProcessFoldOptions = {},
  ): PersistedTimelineView {
    const protectTrailingTurn = options.protectTrailingTurn ?? false;
    const foldUnresolvedTools = options.foldUnresolvedTools ?? false;
    if (this.source === timeline && this.protectTrailingTurn === protectTrailingTurn &&
      this.foldUnresolvedTools === foldUnresolvedTools && this.cached)
      return this.cached;

    const coalesced = coalesceAdjacentProcessSummaries(timeline);
    const rows = foldCompletedProcessRows(prepareVisibleTimelineRows(coalesced), options);
    const suppressedRows = foldCompletedProcessRows(
      prepareVisibleTimelineRows(coalesced, {
        suppressTrailingAssistantFooter: true,
      }),
      options,
    );
    const minimapEntries = projectChatMinimapEntries(coalesced);
    const minimapTail = minimapEntries[minimapEntries.length - 1] ?? null;
    this.source = timeline;
    this.protectTrailingTurn = protectTrailingTurn;
    this.foldUnresolvedTools = foldUnresolvedTools;
    this.cached = {
      timeline: coalesced,
      rows,
      rowsWithSuppressedFooter: suppressedRows,
      rowsWithoutLast: rows.slice(0, -1),
      rowsWithSuppressedFooterWithoutLast: suppressedRows.slice(0, -1),
      minimapPrefix: minimapEntries.slice(0, -1),
      minimapTail,
      minimapKeySignature: minimapEntries.map(entry => entry.key).join('|'),
      assistantTurnOpen: endsWithOpenAssistantTurn(coalesced),
      assistantTurnOpenBeforeLast: endsWithOpenAssistantTurn(coalesced.slice(0, -1)),
    };
    this.buildRevision += 1;
    return this.cached;
  }

  clear(): void {
    this.source = null;
    this.protectTrailingTurn = false;
    this.foldUnresolvedTools = false;
    this.cached = null;
    this.buildRevision += 1;
  }
}

export function projectIncrementalTimelineView(params: {
  persisted: PersistedTimelineView;
  activeTimeline: readonly ActiveTurnTimelineItem[];
  suppressTrailingAssistantFooter: boolean;
  foldSettledTurn?: boolean;
  foldUnresolvedTools?: boolean;
}): IncrementalTimelineView {
  const { persisted, suppressTrailingAssistantFooter } = params;
  const activeTimeline = coalesceAdjacentProcessSummaries(params.activeTimeline);
  const persistedRows = suppressTrailingAssistantFooter
    ? persisted.rowsWithSuppressedFooter
    : persisted.rows;
  const lastPersisted = persisted.timeline[persisted.timeline.length - 1];
  const firstActive = activeTimeline[0];
  const mergedSeam =
    lastPersisted && firstActive ? mergeProcessSummaries(lastPersisted, firstActive) : null;
  const seamRow = mergedSeam
    ? (prepareVisibleTimelineRows([mergedSeam], {
        initialAssistantTurnOpen: persisted.assistantTurnOpenBeforeLast,
      })[0] ?? null)
    : null;
  const activeTail = mergedSeam ? activeTimeline.slice(1) : activeTimeline;
  const activeRows = prepareVisibleTimelineRows(activeTail, {
    initialAssistantTurnOpen: mergedSeam ? true : persisted.assistantTurnOpen,
  });
  const minimapTail = projectChatMinimapTailEntry(persisted.minimapTail, activeTimeline);

  // Keep live ownership until native history takes over, but give a finished
  // display turn the same process disclosure across the persisted/live seam.
  if (params.foldSettledTurn) {
    const prefix = mergedSeam
      ? suppressTrailingAssistantFooter
        ? persisted.rowsWithSuppressedFooterWithoutLast
        : persisted.rowsWithoutLast
      : persistedRows;
    const folded = foldCompletedProcessRows([
      ...prefix,
      ...(seamRow ? [seamRow] : []),
      ...activeRows,
    ], { foldUnresolvedTools: params.foldUnresolvedTools });
    // Unfolded live rows must stay in their existing keyed render lane (for
    // example, an expanded compaction divider awaiting native history).
    const prefixRows = new Set(prefix);
    const firstChanged = folded.findIndex(row => !prefixRows.has(row));
    const split = firstChanged < 0 ? folded.length : firstChanged;
    return {
      persistedRows: folded.slice(0, split),
      seamRow: null,
      activeRows: folded.slice(split),
      minimapPrefix: persisted.minimapPrefix,
      minimapTail,
      minimapKeySignature: persisted.minimapKeySignature,
    };
  }

  return {
    persistedRows: mergedSeam
      ? suppressTrailingAssistantFooter
        ? persisted.rowsWithSuppressedFooterWithoutLast
        : persisted.rowsWithoutLast
      : persistedRows,
    seamRow,
    activeRows: foldCompletedProcessRows(activeRows, { protectTrailingTurn: true }),
    minimapPrefix: persisted.minimapPrefix,
    minimapTail,
    minimapKeySignature: persisted.minimapKeySignature,
  };
}
