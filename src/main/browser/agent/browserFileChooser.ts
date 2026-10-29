import { ARMED_INTERACTION_TIMEOUT_MS, type RegisteredTab } from './browserAgentProtocol';

export type BrowserFileChooserOwner = {
  tab: RegisteredTab;
  guest: Electron.WebContents;
  runId?: string;
  signal?: AbortSignal;
  assertCurrent(): void;
};

type PendingChooser = {
  owner: BrowserFileChooserOwner;
  backendNodeId: number;
  mode: 'selectSingle' | 'selectMultiple';
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  removeAbort(): void;
  retainedLease: boolean;
};

const sameTab = (left: RegisteredTab, right: RegisteredTab): boolean =>
  left.webContentsId === right.webContentsId &&
  left.targetId === right.targetId &&
  left.sessionId === right.sessionId &&
  left.profile === right.profile &&
  left.ownerId === right.ownerId;
const FILE_CHOOSER_EVENT_SETTLE_MS = 50;
const FILE_CHOOSER_BARRIER_TIMEOUT_MS = 500;
const FILE_CHOOSER_INTERCEPTION_TIMEOUT_MS = 1_000;

/** Native chooser requests opened by an admitted Agent action, never by manual browsing. */
export class BrowserFileChooser {
  private readonly active = new Map<number, BrowserFileChooserOwner>();
  private readonly pending = new Map<number, PendingChooser>();
  private readonly revisions = new Map<number, number>();
  private nextRevision = 0;

  constructor(
    private readonly keepIntercepting: (webContentsId: number) => boolean,
    private readonly releaseLease: (webContentsId: number) => void,
    private readonly onRestoreFailure: (webContentsId: number) => void,
    private readonly ownsDebugger: (webContentsId: number) => boolean,
  ) {}

  async begin(owner: BrowserFileChooserOwner): Promise<() => Promise<void>> {
    owner.assertCurrent();
    const id = owner.tab.webContentsId;
    this.active.set(id, owner);
    this.bump(id);
    const abort = () => {
      if (this.active.get(id) !== owner) return;
      this.active.delete(id);
      this.bump(id);
      if (this.pending.get(id)?.owner === owner) this.clear(id);
      void this.restore(owner.guest).catch((): void => undefined);
    };
    owner.signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.sync(owner.guest);
      owner.assertCurrent();
      if (this.active.get(id) !== owner) throw new Error('The file chooser action was retired.');
    } catch (error) {
      owner.signal?.removeEventListener('abort', abort);
      if (this.active.get(id) === owner) {
        this.active.delete(id);
        this.bump(id);
        await this.restore(owner.guest);
      }
      throw error;
    }
    let finished = false;
    return async () => {
      if (finished) return;
      finished = true;
      owner.signal?.removeEventListener('abort', abort);
      if (this.active.get(id) !== owner) return;
      this.active.delete(id);
      this.bump(id);
      await this.restore(owner.guest);
    };
  }

  capture(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    params: Record<string, unknown>,
  ): boolean {
    const owner = this.active.get(tab.webContentsId);
    if (!owner || !sameTab(owner.tab, tab) || owner.guest !== guest) return false;
    try {
      owner.assertCurrent();
    } catch {
      return false;
    }
    if (
      !Number.isSafeInteger(params.backendNodeId) ||
      Number(params.backendNodeId) <= 0 ||
      (params.mode !== 'selectSingle' && params.mode !== 'selectMultiple')
    )
      return false;
    this.clear(tab.webContentsId);
    const abort = () => this.clear(tab.webContentsId);
    const timer = setTimeout(abort, ARMED_INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    const pending: PendingChooser = {
      owner,
      backendNodeId: Number(params.backendNodeId),
      mode: params.mode,
      expiresAt: Date.now() + ARMED_INTERACTION_TIMEOUT_MS,
      timer,
      removeAbort: () => owner.signal?.removeEventListener('abort', abort),
      retainedLease: false,
    };
    this.pending.set(tab.webContentsId, pending);
    this.bump(tab.webContentsId);
    owner.signal?.addEventListener('abort', abort, { once: true });
    if (owner.signal?.aborted) this.clear(tab.webContentsId);
    return true;
  }

  read(
    webContentsId: number,
  ): { pending: true; mode: 'selectSingle' | 'selectMultiple'; timeoutMs: number } | null {
    const entry = this.pending.get(webContentsId);
    if (!entry) return null;
    try {
      entry.owner.assertCurrent();
      if (Date.now() >= entry.expiresAt) throw new Error('Expired file chooser.');
    } catch {
      this.clear(webContentsId);
      return null;
    }
    return {
      pending: true,
      mode: entry.mode,
      timeoutMs: Math.max(0, entry.expiresAt - Date.now()),
    };
  }

  retainLease(webContentsId: number): boolean {
    if (!this.read(webContentsId)) return false;
    const entry = this.pending.get(webContentsId)!;
    if (entry.retainedLease) return false;
    entry.retainedLease = true;
    return true;
  }

  isActive(webContentsId: number): boolean {
    const owner = this.active.get(webContentsId);
    if (!owner) return false;
    try {
      owner.assertCurrent();
      return true;
    } catch {
      this.retire(webContentsId);
      return false;
    }
  }

  async consume(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    files: string[],
    assertCurrent: () => void,
  ): Promise<boolean> {
    const entry = this.pending.get(tab.webContentsId);
    if (!entry) return false;
    const current = this.active.get(tab.webContentsId);
    const assertBoth = () => {
      assertCurrent();
      entry.owner.assertCurrent();
      if (
        !current ||
        !sameTab(current.tab, tab) ||
        current.guest !== guest ||
        current.runId !== entry.owner.runId ||
        !sameTab(entry.owner.tab, tab) ||
        entry.owner.guest !== guest ||
        this.pending.get(tab.webContentsId) !== entry ||
        Date.now() >= entry.expiresAt
      )
        throw new Error('The pending file chooser is no longer available.');
    };
    try {
      assertBoth();
      if (entry.mode === 'selectSingle' && files.length !== 1)
        throw new Error('The pending file chooser accepts one file.');
      await guest.debugger.sendCommand('DOM.setFileInputFiles', {
        files,
        backendNodeId: entry.backendNodeId,
      });
      assertBoth();
      return true;
    } finally {
      if (this.pending.get(tab.webContentsId) === entry) this.clear(tab.webContentsId);
    }
  }

  clear(webContentsId: number): void {
    const entry = this.pending.get(webContentsId);
    if (!entry) return;
    this.pending.delete(webContentsId);
    this.bump(webContentsId);
    clearTimeout(entry.timer);
    entry.removeAbort();
    // Dropping a request must not clear a file input's previously selected files.
    const restoring = this.restore(entry.owner.guest);
    if (entry.retainedLease) {
      if (this.active.has(webContentsId)) this.releaseLease(webContentsId);
      else
        void restoring.finally(() => this.releaseLease(webContentsId)).catch((): void => undefined);
    }
    void restoring.catch((): void => undefined);
  }

  clearAll(): void {
    for (const id of new Set([...this.active.keys(), ...this.pending.keys()])) this.retire(id);
  }

  retire(webContentsId: number): void {
    const guest =
      this.active.get(webContentsId)?.guest ?? this.pending.get(webContentsId)?.owner.guest;
    this.active.delete(webContentsId);
    this.bump(webContentsId);
    this.clear(webContentsId);
    if (guest) void this.restore(guest).catch((): void => undefined);
    else this.revisions.delete(webContentsId);
  }

  async settle(guest: Electron.WebContents, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || guest.isDestroyed() || this.pending.has(guest.id)) return;
    // Foreground Electron mouse input is fire-and-forget. Keep interception and
    // the interaction lease until its renderer work and immediate events drain.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const barrier = guest.debugger
      .sendCommand('Runtime.evaluate', {
        expression: 'void 0',
        returnByValue: true,
        timeout: FILE_CHOOSER_BARRIER_TIMEOUT_MS,
      })
      .catch((): void => undefined);
    try {
      await Promise.race([
        barrier,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, FILE_CHOOSER_BARRIER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // A delayed response to this pure observation owns no chooser state.
    await new Promise<void>(resolve => setTimeout(resolve, FILE_CHOOSER_EVENT_SETTLE_MS));
  }

  async sync(guest: Electron.WebContents): Promise<void> {
    if (guest.isDestroyed() || !guest.debugger.isAttached() || !this.ownsDebugger(guest.id)) return;
    const changing = guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
      enabled:
        this.active.has(guest.id) || this.pending.has(guest.id) || this.keepIntercepting(guest.id),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        changing,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('File chooser interception timed out.')),
            FILE_CHOOSER_INTERCEPTION_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async restore(guest: Electron.WebContents): Promise<void> {
    const revision = this.revisions.get(guest.id);
    try {
      await this.sync(guest);
    } catch {
      if (this.revisions.get(guest.id) !== revision || !this.ownsDebugger(guest.id)) return;
      // Preserve already-applied upload outcomes. Detaching the owned debugger
      // retires its interception before the user can regain the page lease.
      this.onRestoreFailure(guest.id);
      if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
      this.retire(guest.id);
    } finally {
      if (
        this.revisions.get(guest.id) === revision &&
        !this.active.has(guest.id) &&
        !this.pending.has(guest.id)
      )
        this.revisions.delete(guest.id);
    }
  }

  private bump(webContentsId: number): void {
    this.revisions.set(webContentsId, ++this.nextRevision);
  }
}
