import type { PersistedTimelineItem } from './project-history-timeline';
import type { ProcessSummaryTimelineItem } from './project-turn-items';

function processIdentity(process: ProcessSummaryTimelineItem['items'][number]): string | null {
  return process.id ? `${process.type}:${process.id}` : null;
}

/** Keeps presentation shells stable when a page reveals earlier native process items. */
export class HistoryProcessIdentity {
  private scope: string | null = null;
  private input: PersistedTimelineItem[] | null = null;
  private output: PersistedTimelineItem[] = [];
  private previousSources = new Map<string, string>();

  reconcile(items: PersistedTimelineItem[], scope: string): PersistedTimelineItem[] {
    if (this.scope !== scope) {
      this.clear();
      this.scope = scope;
    }
    if (this.input === items) return this.output;
    const usedKeys = new Set(
      items.filter(item => item.kind !== 'process-summary').map(item => item.key),
    );
    const keys = new Map<number, string>();
    // The descendant containing the retained tail owns a split shell. A merge
    // likewise prefers the latest retained shell, closest to the reading tail.
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind !== 'process-summary') continue;
      let key: string | undefined;
      for (let child = item.items.length - 1; child >= 0; child -= 1) {
        const identity = processIdentity(item.items[child]);
        const previous = identity ? this.previousSources.get(identity) : undefined;
        if (previous !== undefined && !usedKeys.has(previous)) {
          key = previous;
          break;
        }
      }
      key ??= item.key;
      if (usedKeys.has(key)) {
        const last = item.items[item.items.length - 1];
        const base = `history-process-view:${last ? processIdentity(last) : `empty:${index}`}`;
        key = base;
        for (let suffix = 1; usedKeys.has(key); suffix += 1) key = `${base}:${suffix}`;
      }
      keys.set(index, key);
      usedKeys.add(key);
    }
    let changed = false;
    const nextSources = new Map<string, string>();
    const result = items.map((item, index) => {
      if (item.kind !== 'process-summary') return item;
      const key = keys.get(index)!;
      for (const process of item.items) {
        const identity = processIdentity(process);
        if (identity) nextSources.set(identity, key);
      }
      if (key === item.key) return item;
      changed = true;
      return { ...item, key };
    });
    this.previousSources = nextSources;
    this.input = items;
    this.output = changed ? result : items;
    return this.output;
  }

  clear(): void {
    this.scope = null;
    this.input = null;
    this.output = [];
    this.previousSources.clear();
  }
}
