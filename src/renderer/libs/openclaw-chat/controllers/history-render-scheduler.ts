const INITIAL_BATCH_SIZE = 8;
const COMMIT_BUDGET_MS = 10;
const MIN_BATCH_SIZE = 2;

/** Schedules presentation rows only. Native history and the live lane stay authoritative. */
export class HistoryRenderScheduler<T extends { item: { key: string } }> {
  private scope: string | null = null;
  private target: readonly T[] = [];
  private visible: readonly T[] = [];
  private ready = new Set<string>();
  private pending: string[] = [];
  private cursor = 0;
  private batchSize = INITIAL_BATCH_SIZE;
  private committedBatch = false;
  private progressiveCommit = false;
  private advanceAllowed = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly scheduleFrame: () => void) {}

  get rows(): readonly T[] {
    return this.visible;
  }

  get isPending(): boolean {
    return this.cursor < this.pending.length;
  }

  get complete(): Promise<void> {
    return this.isPending || this.committedBatch
      ? new Promise(resolve => this.waiters.push(resolve))
      : Promise.resolve();
  }

  select(target: readonly T[], scope: string, immediate = false): readonly T[] {
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
    }
    if (this.target !== target) {
      const previousKeys = new Set(this.visible.map(row => row.item.key));
      this.target = target;
      this.ready = new Set(
        target.filter(row => previousKeys.has(row.item.key)).map(row => row.item.key),
      );
      // Work outwards from the retained overlap: older pages appear directly
      // above the reading anchor, newer pages directly below it.
      const firstRetained = target.findIndex(row => this.ready.has(row.item.key));
      this.pending = [];
      for (let index = firstRetained - 1; index >= 0; index -= 1)
        this.pending.push(target[index].item.key);
      for (let index = Math.max(0, firstRetained); index < target.length; index += 1)
        if (!this.ready.has(target[index].item.key)) this.pending.push(target[index].item.key);
      this.cursor = 0;
      if (firstRetained < 0 || this.pending.length <= this.batchSize || immediate) {
        this.flush();
      } else {
        this.advance();
      }
    } else if (immediate) {
      this.flush();
    } else if (this.isPending && this.advanceAllowed) {
      this.advance();
    }
    return this.visible;
  }

  /** Called after the host's normal commit, anchor restoration and enhancements. */
  afterCommit(durationMs: number): void {
    if (this.progressiveCommit) {
      if (durationMs > COMMIT_BUDGET_MS && this.batchSize > MIN_BATCH_SIZE)
        this.batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(this.batchSize / 2));
      else if (durationMs < COMMIT_BUDGET_MS / 2)
        this.batchSize = Math.min(INITIAL_BATCH_SIZE, this.batchSize + 1);
    }
    this.committedBatch = false;
    this.progressiveCommit = false;
    if (!this.isPending) {
      for (const resolve of this.waiters.splice(0)) resolve();
      return;
    }
    this.scheduleFrame();
  }

  /** The host calls this from its shared stream/history animation frame. */
  beginFrame(): void {
    this.advanceAllowed = true;
  }

  flush(): boolean {
    const changed = this.visible !== this.target;
    this.cursor = this.pending.length;
    this.ready = new Set(this.target.map(row => row.item.key));
    this.visible = this.target;
    this.committedBatch ||= changed;
    return changed;
  }

  clear(): void {
    this.scope = null;
    this.target = [];
    this.visible = [];
    this.ready.clear();
    this.pending = [];
    this.cursor = 0;
    this.batchSize = INITIAL_BATCH_SIZE;
    this.committedBatch = false;
    this.progressiveCommit = false;
    this.advanceAllowed = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private advance(): void {
    this.advanceAllowed = false;
    const end = Math.min(this.pending.length, this.cursor + this.batchSize);
    for (; this.cursor < end; this.cursor += 1) this.ready.add(this.pending[this.cursor]);
    this.visible = this.isPending
      ? this.target.filter(row => this.ready.has(row.item.key))
      : this.target;
    this.committedBatch = true;
    this.progressiveCommit = true;
  }
}
