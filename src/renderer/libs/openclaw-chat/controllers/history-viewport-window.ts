export interface HistoryViewportRange {
  start: number;
  end: number;
  before: number;
  after: number;
  totalHeight: number;
}

export interface HistoryViewportMeasurement {
  key: string;
  height: number;
}

export interface HistoryViewportOptions {
  estimatedRowHeight?: number;
  overscanViewports?: number;
  maxRows?: number;
}

const DEFAULT_ESTIMATED_ROW_HEIGHT = 128;
const DEFAULT_MAX_ROWS = 250;

/** Indexes presentation rows only; native history and grouping remain with their owners. */
export class HistoryViewportWindow {
  private scope: string | null = null;
  private keys: readonly string[] = [];
  private readonly measuredHeights = new Map<string, number>();
  private indices = new Map<string, number>();
  private heights: number[] = [];
  private sums = new Float64Array(1);
  private height = 0;
  private readonly estimatedRowHeight: number;
  private readonly overscanViewports: number;
  private readonly maxRows: number;

  constructor(options: HistoryViewportOptions = {}) {
    this.estimatedRowHeight =
      Number.isFinite(options.estimatedRowHeight) && (options.estimatedRowHeight ?? 0) > 0
        ? options.estimatedRowHeight!
        : DEFAULT_ESTIMATED_ROW_HEIGHT;
    this.overscanViewports =
      Number.isFinite(options.overscanViewports) && (options.overscanViewports ?? -1) >= 0
        ? options.overscanViewports!
        : 1;
    this.maxRows =
      Number.isFinite(options.maxRows) && (options.maxRows ?? 0) >= 1
        ? Math.floor(options.maxRows!)
        : DEFAULT_MAX_ROWS;
  }

  get length(): number {
    return this.keys.length;
  }

  get totalHeight(): number {
    return this.height;
  }

  /** Keys must be unique and the input array immutable, like the projected rows. */
  setRows(keys: readonly string[], scope: string): boolean {
    const scopeChanged = this.scope !== scope;
    if (!scopeChanged && this.keys === keys) return false;
    if (
      !scopeChanged &&
      this.keys.length === keys.length &&
      this.keys.every((key, index) => key === keys[index])
    ) {
      this.keys = keys;
      return false;
    }
    if (scopeChanged) this.measuredHeights.clear();
    this.scope = scope;
    this.keys = keys;
    this.indices = new Map(keys.map((key, index) => [key, index]));
    this.heights = keys.map(key => this.measuredHeights.get(key) ?? this.estimatedRowHeight);
    this.sums = new Float64Array(keys.length + 1);
    this.height = 0;
    for (let index = 1; index <= keys.length; index += 1) {
      const height = this.heights[index - 1];
      this.height += height;
      this.sums[index] += height;
      const parent = index + (index & -index);
      if (parent <= keys.length) this.sums[parent] += this.sums[index];
    }
    return true;
  }

  /** Ignore unlaid-out rows; their zero dimensions do not establish a height. */
  measure(rows: readonly HistoryViewportMeasurement[]): boolean {
    let changed = false;
    for (const { key, height } of rows) {
      const index = this.indices.get(key);
      if (index === undefined || !Number.isFinite(height) || height <= 0) continue;
      this.measuredHeights.set(key, height);
      const delta = height - this.heights[index];
      if (delta === 0) continue;
      this.heights[index] = height;
      this.height += delta;
      for (let cursor = index + 1; cursor < this.sums.length; cursor += cursor & -cursor)
        this.sums[cursor] += delta;
      changed = true;
    }
    return changed;
  }

  /** Pixel offset before an index, including the end index for the total height. */
  offsetAt(index: number): number {
    let cursor = Math.max(0, Math.min(this.length, Math.floor(index) || 0));
    let sum = 0;
    for (; cursor > 0; cursor -= cursor & -cursor) sum += this.sums[cursor];
    return sum;
  }

  /** A null position starts at the newest rows without walking earlier history. */
  select(scrollTop: number | null, viewportHeight: number): HistoryViewportRange {
    if (this.length === 0) return this.range(0, 0);
    const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
    const maxTop = Math.max(0, this.height - viewport);
    const top = scrollTop === null ? maxTop : Math.max(0, Math.min(maxTop, scrollTop || 0));
    const bottom = Math.min(this.height, top + viewport);
    const visibleStart = Math.min(this.length - 1, this.countBefore(top, true));
    const visibleEnd = Math.max(
      visibleStart + 1,
      Math.min(this.length, this.countBefore(bottom, false) + 1),
    );
    const overscan = viewport * this.overscanViewports;
    let start = Math.min(visibleStart, this.countBefore(Math.max(0, top - overscan), true));
    let end = Math.max(
      visibleEnd,
      Math.min(this.length, this.countBefore(Math.min(this.height, bottom + overscan), false) + 1),
    );
    const budget = Math.max(this.maxRows, visibleEnd - visibleStart);
    if (end - start > budget) {
      const extra = budget - (visibleEnd - visibleStart);
      let before = Math.min(visibleStart - start, Math.floor(extra / 2));
      const after = Math.min(end - visibleEnd, extra - before);
      before = Math.min(visibleStart - start, extra - after);
      start = visibleStart - before;
      end = visibleEnd + after;
    }
    return this.range(start, end);
  }

  /** Materialize a known row before the owner's normal search/reveal navigation. */
  ensureIndex(index: number, viewportHeight: number): HistoryViewportRange {
    if (this.length === 0) return this.range(0, 0);
    const target = Math.max(0, Math.min(this.length - 1, Math.floor(index) || 0));
    const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
    return this.select(
      this.offsetAt(target) - Math.max(0, (viewport - this.heights[target]) / 2),
      viewport,
    );
  }

  clear(): void {
    this.scope = null;
    this.keys = [];
    this.measuredHeights.clear();
    this.indices.clear();
    this.heights = [];
    this.sums = new Float64Array(1);
    this.height = 0;
  }

  private range(start: number, end: number): HistoryViewportRange {
    return {
      start,
      end,
      before: this.offsetAt(start),
      after: Math.max(0, this.height - this.offsetAt(end)),
      totalHeight: this.height,
    };
  }

  /** Find the number of row bottoms below the pixel, optionally including equality. */
  private countBefore(pixel: number, includeEqual: boolean): number {
    let index = 0;
    let sum = 0;
    let step = 1;
    while (step * 2 <= this.length) step *= 2;
    for (; step > 0; step = Math.floor(step / 2)) {
      const candidate = index + step;
      if (candidate > this.length) continue;
      const next = sum + this.sums[candidate];
      if (next < pixel || (includeEqual && next === pixel)) {
        index = candidate;
        sum = next;
      }
    }
    return index;
  }
}
