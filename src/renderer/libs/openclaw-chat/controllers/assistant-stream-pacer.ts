export interface AssistantStreamSnapshot {
  id: string;
  text: string;
  flush?: boolean;
}

type PacedStreamState = {
  displayedLength: number;
  observedText: string;
  pendingSnapshotEnds: number[];
  catchUpFramesRemaining: number;
};

const MAX_VISUAL_SEGMENT_GRAPHEMES = 6;
type GraphemeSegmenter = {
  segment: (text: string) => Iterable<{ segment: string }>;
};
type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;
const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
const graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;

function* codePointSegments(text: string): Iterable<{ segment: string }> {
  for (const segment of text) yield { segment };
}

function takeGraphemePrefix(
  text: string,
  limit: number,
): { codeUnitLength: number; graphemeCount: number } {
  if (!text || limit <= 0) return { codeUnitLength: 0, graphemeCount: 0 };
  let codeUnitLength = 0;
  let graphemeCount = 0;
  const graphemes = graphemeSegmenter ? graphemeSegmenter.segment(text) : codePointSegments(text);
  for (const grapheme of graphemes) {
    if (graphemeCount >= limit) break;
    codeUnitLength += grapheme.segment.length;
    graphemeCount += 1;
  }
  return { codeUnitLength, graphemeCount };
}

/**
 * Keeps canonical assistant text current while presenting provider snapshots at
 * a stable, frame-paced cadence. Provider transports can deliver many snapshots
 * in one browser task; replaying their suffixes avoids collapsing that burst
 * into one visible paragraph-sized jump.
 */
export class AssistantStreamPacer {
  static readonly MAX_CATCH_UP_FRAMES = 45;
  static readonly MAX_PENDING_SNAPSHOT_BOUNDARIES = 240;
  static readonly MAX_GRAPHEMES_PER_FRAME = 24;

  private readonly streams = new Map<string, PacedStreamState>();

  seed(snapshots: readonly AssistantStreamSnapshot[]): void {
    this.streams.clear();
    for (const snapshot of snapshots) {
      this.streams.set(snapshot.id, {
        displayedLength: snapshot.text.length,
        observedText: snapshot.text,
        pendingSnapshotEnds: [],
        catchUpFramesRemaining: AssistantStreamPacer.MAX_CATCH_UP_FRAMES,
      });
    }
  }

  observe(snapshots: readonly AssistantStreamSnapshot[]): void {
    const activeIds = new Set(snapshots.map(snapshot => snapshot.id));
    for (const id of this.streams.keys()) {
      if (!activeIds.has(id)) this.streams.delete(id);
    }

    for (const snapshot of snapshots) {
      const existing = this.streams.get(snapshot.id);
      if (!existing) {
        const stream: PacedStreamState = {
          displayedLength: snapshot.flush ? snapshot.text.length : 0,
          observedText: snapshot.text,
          pendingSnapshotEnds: [],
          catchUpFramesRemaining: AssistantStreamPacer.MAX_CATCH_UP_FRAMES,
        };
        this.streams.set(snapshot.id, stream);
        if (!snapshot.flush && snapshot.text) this.enqueueSnapshotBoundary(stream);
        continue;
      }

      if (snapshot.flush) {
        existing.displayedLength = snapshot.text.length;
        existing.observedText = snapshot.text;
        existing.pendingSnapshotEnds = [];
        existing.catchUpFramesRemaining = AssistantStreamPacer.MAX_CATCH_UP_FRAMES;
        continue;
      }
      if (snapshot.text === existing.observedText) continue;

      if (snapshot.text.startsWith(existing.observedText)) {
        existing.observedText = snapshot.text;
        this.enqueueSnapshotBoundary(existing);
        continue;
      }

      // A non-prefix snapshot is an authoritative revision (including managed
      // terminal rollback/retry replacements). Never animate text that the
      // canonical transcript has already withdrawn.
      existing.displayedLength = snapshot.text.length;
      existing.observedText = snapshot.text;
      existing.pendingSnapshotEnds = [];
      existing.catchUpFramesRemaining = AssistantStreamPacer.MAX_CATCH_UP_FRAMES;
    }
  }

  advance(): boolean {
    for (const stream of this.streams.values()) {
      this.discardPassedBoundaries(stream);
      if (stream.displayedLength >= stream.observedText.length) continue;
      if (stream.pendingSnapshotEnds.length === 0) {
        stream.pendingSnapshotEnds.push(stream.observedText.length);
      }

      const framesRemaining = Math.max(1, stream.catchUpFramesRemaining);
      let snapshotBudget = Math.max(
        1,
        Math.ceil(stream.pendingSnapshotEnds.length / framesRemaining),
      );
      let graphemeBudget = AssistantStreamPacer.MAX_GRAPHEMES_PER_FRAME;

      while (
        snapshotBudget > 0 &&
        graphemeBudget > 0 &&
        stream.displayedLength < stream.observedText.length
      ) {
        this.discardPassedBoundaries(stream);
        const boundaryEnd = stream.pendingSnapshotEnds[0] ?? stream.observedText.length;
        const remainingToBoundary = stream.observedText.slice(stream.displayedLength, boundaryEnd);
        if (!remainingToBoundary) {
          stream.pendingSnapshotEnds.shift();
          snapshotBudget -= 1;
          continue;
        }

        const adaptiveBudget = Math.max(
          MAX_VISUAL_SEGMENT_GRAPHEMES,
          Math.ceil(remainingToBoundary.length / framesRemaining),
        );
        const taken = takeGraphemePrefix(
          remainingToBoundary,
          Math.min(graphemeBudget, adaptiveBudget),
        );
        if (taken.codeUnitLength === 0) break;
        stream.displayedLength += taken.codeUnitLength;
        graphemeBudget -= taken.graphemeCount;

        if (stream.displayedLength >= boundaryEnd) {
          stream.pendingSnapshotEnds.shift();
          snapshotBudget -= 1;
          continue;
        }
        break;
      }

      this.discardPassedBoundaries(stream);
      if (stream.displayedLength >= stream.observedText.length) {
        stream.displayedLength = stream.observedText.length;
        stream.pendingSnapshotEnds = [];
        stream.catchUpFramesRemaining = AssistantStreamPacer.MAX_CATCH_UP_FRAMES;
      } else {
        stream.catchUpFramesRemaining = Math.max(0, framesRemaining - 1);
      }
    }
    return this.hasPending();
  }

  flushPending(): void {
    for (const stream of this.streams.values()) {
      stream.displayedLength = stream.observedText.length;
      stream.pendingSnapshotEnds = [];
      stream.catchUpFramesRemaining = AssistantStreamPacer.MAX_CATCH_UP_FRAMES;
    }
  }

  displayText(id: string, canonicalText: string): string {
    const stream = this.streams.get(id);
    return stream ? stream.observedText.slice(0, stream.displayedLength) : canonicalText;
  }

  hasPending(): boolean {
    for (const stream of this.streams.values()) {
      if (stream.displayedLength < stream.observedText.length) return true;
    }
    return false;
  }

  isPending(id: string): boolean {
    const stream = this.streams.get(id);
    return Boolean(stream && stream.displayedLength < stream.observedText.length);
  }

  reset(): void {
    this.streams.clear();
  }

  private enqueueSnapshotBoundary(stream: PacedStreamState): void {
    const boundary = stream.observedText.length;
    if (boundary <= stream.displayedLength) return;
    const boundaries = stream.pendingSnapshotEnds;
    if (boundaries[boundaries.length - 1] === boundary) return;
    if (boundaries.length === 0) {
      stream.catchUpFramesRemaining = AssistantStreamPacer.MAX_CATCH_UP_FRAMES;
    } else if (boundaries.length >= AssistantStreamPacer.MAX_PENDING_SNAPSHOT_BOUNDARIES) {
      // Keep the oldest pending boundary and the most recent provider
      // boundaries. Dropping one intermediate marker never drops text because
      // the canonical snapshot remains the source for cursor-based reveal.
      boundaries.splice(1, 1);
    }
    boundaries.push(boundary);
  }

  private discardPassedBoundaries(stream: PacedStreamState): void {
    while (
      stream.pendingSnapshotEnds.length > 0 &&
      stream.pendingSnapshotEnds[0] <= stream.displayedLength
    ) {
      stream.pendingSnapshotEnds.shift();
    }
  }
}
