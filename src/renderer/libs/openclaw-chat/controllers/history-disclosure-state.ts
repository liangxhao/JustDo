/** Retains presentation choices across history windows, scoped to native identity. */
export class HistoryDisclosureState {
  private scope: string | null = null;
  private states = new Map<string, boolean>();
  private summaryKeys = new Set<string>();
  private completedSources = new Map<string, readonly string[]>();
  private sourceStates = new Map<string, { open: boolean; revision: number }>();
  private sourceRevision = 0;

  reset(scope: string | null): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.clear();
  }

  clear(): void {
    this.states.clear();
    this.summaryKeys.clear();
    this.completedSources.clear();
    this.sourceStates.clear();
    this.sourceRevision = 0;
  }

  capture(root: ParentNode): void {
    root.querySelectorAll<HTMLDetailsElement>('details').forEach(details => {
      const key =
        details.dataset.completedProcessKey ??
        (details.firstElementChild as HTMLElement | null)?.dataset.processSummaryKey;
      if (key) {
        const sources = this.completedSources.get(key) ?? [];
        const latest = this.latestSourceChoice(sources);
        const changed =
          this.states.get(key) !== details.open ||
          (latest !== undefined && latest.open !== details.open);
        this.states.set(key, details.open);
        if (changed) {
          const choice = { open: details.open, revision: ++this.sourceRevision };
          for (const source of sources) this.sourceStates.set(source, choice);
        }
      }
    });
  }

  expanded(key: string, fallback: boolean, sources?: readonly string[]): boolean {
    if (sources) this.completedSources.set(key, sources);
    // A page boundary can reveal the beginning of the same process group.
    // The latest choice must also win when returning to a previously seen shape.
    return this.latestSourceChoice(sources ?? [])?.open ?? this.states.get(key) ?? fallback;
  }

  private latestSourceChoice(sources: readonly string[]) {
    let latest: { open: boolean; revision: number } | undefined;
    for (const source of sources) {
      const choice = this.sourceStates.get(source);
      if (choice && (!latest || choice.revision > latest.revision)) latest = choice;
    }
    return latest;
  }

  returningSummaries(keys: readonly string[]): { open: string | null; collapsed: string[] } {
    const returning = keys.filter(key => !this.summaryKeys.has(key));
    this.summaryKeys = new Set(keys);
    return {
      open: returning.find(key => this.states.get(key) === true) ?? null,
      collapsed: returning.filter(key => this.states.get(key) === false),
    };
  }
}
