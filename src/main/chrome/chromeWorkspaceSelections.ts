import { randomUUID } from 'node:crypto';

const SELECTION_LIFETIME_MS = 5 * 60_000;

export interface ChromeWorkspaceScope {
  key: string;
  subscription?: symbol;
}

/** A directory choice belongs to one live viewer and one draft or thread. */
export class ChromeWorkspaceSelections {
  private epoch = 0;
  private choosing = false;
  private selection?: ChromeWorkspaceScope & { token: string; cwd: string; expiresAt: number };

  async select(
    scope: ChromeWorkspaceScope,
    choose: () => Promise<string | null>,
    assertCurrent: () => void,
  ) {
    if (this.choosing) throw new Error('A folder selection is already open.');
    assertCurrent();
    this.choosing = true;
    const epoch = this.epoch;
    try {
      const cwd = await choose();
      assertCurrent();
      if (epoch !== this.epoch) throw new Error('The folder selection is no longer current.');
      if (!cwd) return { cancelled: true } as const;
      const token = randomUUID();
      this.selection = { ...scope, token, cwd, expiresAt: Date.now() + SELECTION_LIFETIME_MS };
      return { cwd, selectionToken: token };
    } finally {
      this.choosing = false;
    }
  }

  consume(token: string, scope: ChromeWorkspaceScope): string {
    const selected = this.selection;
    if (
      !selected ||
      selected.token !== token ||
      selected.key !== scope.key ||
      selected.subscription !== scope.subscription ||
      selected.expiresAt <= Date.now()
    )
      throw new Error('The folder selection expired or belongs to another conversation.');
    this.selection = undefined;
    return selected.cwd;
  }

  clear(): void {
    this.epoch++;
    this.selection = undefined;
  }
}
