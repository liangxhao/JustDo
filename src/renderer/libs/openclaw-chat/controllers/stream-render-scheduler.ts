export class StreamRenderScheduler {
  static readonly TOOL_PARTIAL_INTERVAL_MS = 80;

  private frameId: number | null = null;
  private toolPartialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastToolPartialPublishAt = Number.NEGATIVE_INFINITY;
  private frameWindow: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> | null = null;

  constructor(
    private readonly publish: () => void,
    private readonly now: () => number = () => Date.now(),
    private readonly animationWindow: () => Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> | undefined = () => globalThis,
  ) {}

  schedule(): void {
    if (this.frameId !== null) return;
    const host = this.animationWindow();
    if (typeof host?.requestAnimationFrame === 'function') {
      this.frameWindow = host;
      this.frameId = host.requestAnimationFrame(() => {
        this.frameId = null;
        this.frameWindow = null;
        this.publish();
      });
      return;
    }
    this.frameId = -1;
    queueMicrotask(() => {
      if (this.frameId === null) return;
      this.frameId = null;
      this.publish();
    });
  }

  scheduleToolPartial(): void {
    if (this.toolPartialTimer !== null) return;
    const remaining = Math.max(
      0,
      StreamRenderScheduler.TOOL_PARTIAL_INTERVAL_MS -
        (this.now() - this.lastToolPartialPublishAt),
    );
    if (remaining === 0) {
      this.lastToolPartialPublishAt = this.now();
      this.schedule();
      return;
    }
    this.toolPartialTimer = setTimeout(() => {
      this.toolPartialTimer = null;
      this.lastToolPartialPublishAt = this.now();
      this.schedule();
    }, remaining);
  }

  flush(): void {
    if (this.toolPartialTimer !== null) {
      clearTimeout(this.toolPartialTimer);
      this.toolPartialTimer = null;
    }
    this.lastToolPartialPublishAt = this.now();
    if (this.frameId === null) {
      this.publish();
      return;
    }
    if (this.frameId >= 0) {
      this.frameWindow?.cancelAnimationFrame(this.frameId);
    }
    this.frameId = null;
    this.frameWindow = null;
    this.publish();
  }

  dispose(): void {
    if (this.toolPartialTimer !== null) clearTimeout(this.toolPartialTimer);
    this.toolPartialTimer = null;
    if (this.frameId !== null && this.frameId >= 0) {
      this.frameWindow?.cancelAnimationFrame(this.frameId);
    }
    this.frameId = null;
    this.frameWindow = null;
  }
}
