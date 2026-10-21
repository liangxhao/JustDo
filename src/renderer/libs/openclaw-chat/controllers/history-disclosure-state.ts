/** Retains presentation choices across history windows, scoped to native identity. */
export class HistoryDisclosureState {
  private scope: string | null = null;
  private states = new Map<string, boolean>();
  private summaryKeys = new Set<string>();
  private completedSources = new Map<string, readonly string[]>();
  private sourceStates = new Map<string, boolean>();

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
  }

  capture(root: ParentNode): void {
    root.querySelectorAll<HTMLDetailsElement>('details').forEach(details => {
      const key =
        details.dataset.completedProcessKey ??
        (details.firstElementChild as HTMLElement | null)?.dataset.processSummaryKey;
      if (key) {
        this.states.set(key, details.open);
        for (const source of this.completedSources.get(key) ?? [])
          this.sourceStates.set(source, details.open);
      }
    });
  }

  expanded(key: string, fallback: boolean, sources?: readonly string[]): boolean {
    if (sources) this.completedSources.set(key, sources);
    const exact = this.states.get(key);
    if (exact !== undefined) return exact;
    const choices = sources?.map(source => this.sourceStates.get(source));
    // A page boundary can reveal the beginning of the same process group.
    // Carry the choice only through shared source identities, never text/name.
    if (choices?.includes(true)) return true;
    if (choices?.includes(false)) return false;
    return fallback;
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
