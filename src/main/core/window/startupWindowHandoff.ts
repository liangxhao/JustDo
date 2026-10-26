import type { BrowserWindow } from 'electron';

export const STARTUP_WINDOW_FADE_MS = 240;

/** Keeps an opaque startup surface underneath the successor until its native fade finishes. */
export class StartupWindowHandoff {
  private source?: BrowserWindow;
  private pending?: BrowserWindow;
  private transition?: { source: BrowserWindow; target: BrowserWindow; finish: () => void };
  private timer?: ReturnType<typeof setTimeout>;
  private readonly managed = new Map<BrowserWindow, { final: boolean; closed: () => void }>();
  private readonly retired = new WeakSet<BrowserWindow>();
  private stopped = false;
  private visualStartedAt?: number;

  constructor(private readonly options: {
    canShow: () => boolean;
    isQuitting: () => boolean;
    onCancelled: () => void;
    platform?: string;
  }) {}

  /** The first route document starts motion; process and backend elapsed clocks remain independent. */
  getEntryStartedAt = (): number => this.visualStartedAt ??= Date.now();

  private opacity(window: BrowserWindow, value: number): void {
    if (!window.isDestroyed()) window.setOpacity(value);
  }

  private watch(window: BrowserWindow, final: boolean): void {
    const closed = () => {
      const relevant = this.source === window || this.pending === window ||
        this.transition?.source === window || this.transition?.target === window;
      this.managed.delete(window);
      if (!this.stopped && !this.retired.has(window) && relevant) {
        this.stop();
        this.options.onCancelled();
      }
    };
    this.managed.set(window, { final, closed });
    window.once('closed', closed);
  }

  setBootstrap(window: BrowserWindow): void {
    if (this.stopped || this.options.isQuitting()) return;
    this.source = window;
    this.watch(window, false);
  }

  showBootstrap(window: BrowserWindow): void {
    if (this.source === window && !this.stopped && !this.retired.has(window) &&
        !window.isDestroyed() && !this.options.isQuitting() && this.options.canShow()) window.show();
  }

  prepare(window: BrowserWindow, final = true): void {
    if (this.stopped || this.options.isQuitting()) return;
    if (this.pending && this.pending !== window) this.retire(this.pending);
    this.pending = window;
    this.watch(window, final);
    if (this.source && !this.source.isDestroyed()) window.setBounds(this.source.getNormalBounds());
    const platform = this.options.platform ?? process.platform;
    if (platform === 'win32' || platform === 'darwin') this.opacity(window, 0);
  }

  showCurrent(): void {
    const window = this.pending ?? this.source;
    if (window && window !== this.pending && !this.stopped && !window.isDestroyed() &&
        !this.options.isQuitting()) window.show();
  }

  present(window: BrowserWindow): void {
    if (this.stopped || this.options.isQuitting() || window.isDestroyed() || this.retired.has(window)) return;
    if (window !== this.pending) return;
    this.transition?.finish();
    const previous = this.source;
    this.pending = undefined;
    this.source = window;
    const finish = () => {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.transition = undefined;
      this.opacity(window, 1);
      if (previous && previous !== window) this.retire(previous);
      const record = this.managed.get(window);
      if (record?.final) {
        window.removeListener('closed', record.closed);
        this.managed.delete(window);
        if (this.source === window) this.source = undefined;
      }
    };
    const targetWasVisible = window.isVisible();
    const explicitlyOpened = targetWasVisible ||
      Boolean(previous && !previous.isDestroyed() && previous.isVisible());
    if (!targetWasVisible && previous && !previous.isDestroyed() && previous.isMinimized()) {
      window.setBounds(previous.getNormalBounds());
      window.minimize();
      finish();
      return;
    }
    if (!this.options.canShow() && !explicitlyOpened) { finish(); return; }
    if (!targetWasVisible && previous && !previous.isDestroyed()) {
      window.setBounds(previous.getNormalBounds());
      if (previous.isMaximized()) window.maximize();
    }
    const platform = this.options.platform ?? process.platform;
    const fading = previous && !previous.isDestroyed() && previous.isVisible() &&
      !previous.isMinimized() && (platform === 'win32' || platform === 'darwin');
    if (!fading) {
      this.opacity(window, 1);
      window.show();
      finish();
      return;
    }
    this.opacity(window, 0);
    window.show();
    const started = performance.now();
    this.transition = { source: previous, target: window, finish };
    const advance = () => {
      if (this.stopped || this.options.isQuitting() || window.isDestroyed() || previous.isDestroyed()) {
        this.stop();
        return;
      }
      const progress = Math.min(1, (performance.now() - started) / STARTUP_WINDOW_FADE_MS);
      this.opacity(window, 1 - (1 - progress) ** 3);
      if (progress === 1) finish();
      else this.timer = setTimeout(advance, 16);
    };
    advance();
  }

  private retire(window: BrowserWindow): void {
    this.retired.add(window);
    const record = this.managed.get(window);
    if (record) window.removeListener('closed', record.closed);
    this.managed.delete(window);
    if (!window.isDestroyed()) window.close();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.transition = undefined;
    for (const [window, record] of this.managed) window.removeListener('closed', record.closed);
    this.managed.clear();
  }
}
