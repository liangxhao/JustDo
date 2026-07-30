import type { PersistedTimelineItem } from './project-history-timeline';
import type { ActiveTurnTimelineItem, ProcessSummaryTimelineItem } from './project-turn-items';

type TimelineItem = PersistedTimelineItem | ActiveTurnTimelineItem;

export function createProcessSummarySessionIdentity(params: {
  sessionKey: string;
  sessionId: string | null;
  historyGeneration: number;
}): string {
  return JSON.stringify([params.sessionKey, params.sessionId, params.historyGeneration]);
}

interface SummaryIdentity {
  key: string;
  runId: string;
  itemIds: Set<string>;
  toolCallIds: Set<string>;
  thinkingTexts: string[];
}

function asSummary(item: TimelineItem): ProcessSummaryTimelineItem | null {
  return item.kind === 'process-summary' ? item : null;
}

function normalizeThinkingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function identityOf(summary: ProcessSummaryTimelineItem): SummaryIdentity {
  return {
    key: summary.key,
    runId: summary.runId,
    itemIds: new Set(summary.items.map(item => item.id).filter(Boolean)),
    toolCallIds: new Set(
      summary.items
        .filter(item => item.type === 'tool')
        .map(item => item.toolCallId)
        .filter(Boolean),
    ),
    thinkingTexts: summary.items
      .filter(item => item.type === 'thinking')
      .map(item => normalizeThinkingText(item.text))
      .filter(Boolean),
  };
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function correlationScore(previous: SummaryIdentity, candidate: SummaryIdentity): number {
  if (previous.key === candidate.key) return Number.MAX_SAFE_INTEGER;
  let score = previous.runId && previous.runId === candidate.runId ? 100 : 0;
  score += intersectionSize(previous.toolCallIds, candidate.toolCallIds) * 50;
  score += intersectionSize(previous.itemIds, candidate.itemIds) * 40;
  if (
    previous.thinkingTexts.length > 0 &&
    previous.thinkingTexts.length === candidate.thinkingTexts.length &&
    previous.thinkingTexts.every((text, index) => text === candidate.thinkingTexts[index])
  ) {
    score += 20;
  }
  return score;
}

/**
 * Carries one expanded process-summary identity across a live-to-history
 * takeover. Ambiguous correlations are intentionally rejected.
 */
export class ProcessSummaryTakeoverTracker {
  private openSummary: SummaryIdentity | null = null;

  resolve(openKey: string | null, items: readonly TimelineItem[]): string | null {
    if (!openKey) {
      this.openSummary = null;
      return null;
    }

    const summaries = items
      .map(asSummary)
      .filter((summary): summary is ProcessSummaryTimelineItem => summary !== null);
    const exact = summaries.find(summary => summary.key === openKey);
    if (exact) {
      this.openSummary = identityOf(exact);
      return exact.key;
    }
    if (!this.openSummary || this.openSummary.key !== openKey) return null;

    const ranked = summaries
      .map(summary => ({ summary, identity: identityOf(summary) }))
      .map(candidate => ({
        ...candidate,
        score: correlationScore(this.openSummary as SummaryIdentity, candidate.identity),
      }))
      .filter(candidate => candidate.score >= 20)
      .sort((left, right) => right.score - left.score);
    if (ranked.length === 0 || ranked[0].score === ranked[1]?.score) {
      this.openSummary = null;
      return null;
    }

    this.openSummary = ranked[0].identity;
    return ranked[0].summary.key;
  }

  clear(): void {
    this.openSummary = null;
  }
}

/**
 * Carries multiple process-summary disclosure keys across live-to-history
 * takeovers. Each key keeps an independent identity tracker.
 */
export class ProcessSummaryTakeoverSetTracker {
  private trackers = new Map<string, ProcessSummaryTakeoverTracker>();

  resolve(keys: ReadonlySet<string>, items: readonly TimelineItem[]): ReadonlySet<string> {
    const resolvedKeys = new Set<string>();
    const nextTrackers = new Map<string, ProcessSummaryTakeoverTracker>();

    for (const key of keys) {
      const tracker = this.trackers.get(key) ?? new ProcessSummaryTakeoverTracker();
      const resolvedKey = tracker.resolve(key, items);
      if (!resolvedKey || resolvedKeys.has(resolvedKey)) continue;
      resolvedKeys.add(resolvedKey);
      nextTrackers.set(resolvedKey, tracker);
    }

    this.trackers = nextTrackers;
    return resolvedKeys;
  }

  clear(): void {
    this.trackers.clear();
  }
}
