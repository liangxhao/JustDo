export type ChatScrollMode = 'follow' | 'paused';

export class ChatScrollController {
  private static readonly LOAD_OLDER_THRESHOLD_PX = 160;
  private host: HTMLElement | null = null;
  private mode: ChatScrollMode = 'follow';
  private programmatic = false;
  private previousScrollTop = 0;
  private previousRevision = -1;
  private unseenRevisions = 0;
  private resizeObserver: ResizeObserver | null = null;
  private observedContent: Element | null = null;
  private pausedAnchors: Array<{ element: HTMLElement; offset: number }> = [];
  private interactionAnchor: { element: HTMLElement; offset: number } | null = null;

  constructor(
    private readonly onStateChange: () => void,
    private readonly onNearTop?: () => void,
    private readonly onNearBottom?: () => boolean,
  ) {}

  get state(): { mode: ChatScrollMode; unseenRevisions: number } {
    return { mode: this.mode, unseenRevisions: this.unseenRevisions };
  }

  connect(host: HTMLElement): void {
    if (this.host === host) return;
    this.disconnect();
    this.host = host;
    this.mode = 'follow';
    host.addEventListener('scroll', this.handleScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(host);
    }
  }

  beforeRender(): void {
    if (!this.host) return;
    this.previousScrollTop = this.host.scrollTop;
    if (!this.interactionAnchor) {
      this.pausedAnchors = this.mode === 'paused' ? this.captureVisibleAnchors(this.host) : [];
    }
  }

  afterRender(revision: number): void {
    const host = this.host;
    if (!host) return;
    const changed = revision !== this.previousRevision;
    this.previousRevision = revision;
    if (this.mode === 'follow') {
      this.scrollToBottom();
      this.observeContent();
      return;
    }
    const survivingAnchor =
      this.interactionAnchor?.element.isConnected === true
        ? this.interactionAnchor
        : this.pausedAnchors.find(anchor => anchor.element.isConnected);
    if (survivingAnchor) {
      const nextOffset = survivingAnchor.element.getBoundingClientRect().top;
      this.setScrollTop(
        Math.max(0, this.previousScrollTop + (nextOffset - survivingAnchor.offset)),
      );
    }
    this.interactionAnchor = null;
    if (changed) {
      this.unseenRevisions += 1;
      this.onStateChange();
    }
    this.pausedAnchors = this.captureVisibleAnchors(host);
    this.observeContent();
  }

  jumpToLatest(): void {
    this.mode = 'follow';
    this.unseenRevisions = 0;
    this.interactionAnchor = null;
    this.scrollToBottom();
    this.onStateChange();
  }

  preserveAnchorForInteraction(element: HTMLElement): void {
    if (!this.host || !element.isConnected) return;
    const modeChanged = this.mode !== 'paused';
    this.mode = 'paused';
    this.interactionAnchor = {
      element,
      offset: element.getBoundingClientRect().top,
    };
    this.pausedAnchors = this.captureVisibleAnchors(this.host);
    if (modeChanged) this.onStateChange();
  }

  reset(): void {
    this.mode = 'follow';
    this.unseenRevisions = 0;
    this.previousRevision = -1;
    this.interactionAnchor = null;
    this.onStateChange();
  }

  disconnect(): void {
    this.host?.removeEventListener('scroll', this.handleScroll);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedContent = null;
    this.host = null;
    this.interactionAnchor = null;
  }

  private readonly handleScroll = (): void => {
    const host = this.host;
    if (!host || this.programmatic) return;
    const distance = host.scrollHeight - host.scrollTop - host.clientHeight;
    if (distance <= ChatScrollController.LOAD_OLDER_THRESHOLD_PX && this.onNearBottom?.()) {
      this.mode = 'paused';
      this.pausedAnchors = this.captureVisibleAnchors(host);
      return;
    }
    const nextMode: ChatScrollMode = distance <= 0.5 ? 'follow' : 'paused';
    if (nextMode !== this.mode) {
      this.mode = nextMode;
      if (nextMode === 'follow') this.unseenRevisions = 0;
      this.onStateChange();
    }
    if (this.mode === 'paused') this.pausedAnchors = this.captureVisibleAnchors(host);
    if (host.scrollTop <= ChatScrollController.LOAD_OLDER_THRESHOLD_PX) {
      this.onNearTop?.();
    }
  };

  private handleResize(): void {
    const host = this.host;
    if (!host) return;
    if (this.mode === 'follow') {
      this.scrollToBottom();
      return;
    }
    const survivingAnchor = this.pausedAnchors.find(anchor => anchor.element.isConnected);
    if (survivingAnchor) {
      const delta = survivingAnchor.element.getBoundingClientRect().top - survivingAnchor.offset;
      if (Math.abs(delta) > 0.5) this.setScrollTop(Math.max(0, host.scrollTop + delta));
    }
    this.pausedAnchors = this.captureVisibleAnchors(host);
  }

  private observeContent(): void {
    const content = this.host?.shadowRoot?.querySelector('.chat-container') ?? null;
    if (!this.resizeObserver || content === this.observedContent) return;
    if (this.observedContent) this.resizeObserver.unobserve(this.observedContent);
    if (content) this.resizeObserver.observe(content);
    this.observedContent = content;
  }

  private scrollToBottom(): void {
    const host = this.host;
    if (!host) return;
    this.setScrollTop(host.scrollHeight);
  }

  private setScrollTop(value: number): void {
    const host = this.host;
    if (!host) return;
    this.programmatic = true;
    host.scrollTop = value;
    queueMicrotask(() => {
      this.programmatic = false;
    });
  }

  private captureVisibleAnchors(host: HTMLElement): Array<{
    element: HTMLElement;
    offset: number;
  }> {
    const root = host.shadowRoot;
    if (!root) return [];
    const viewportTop = host.getBoundingClientRect().top;
    return [
      ...root.querySelectorAll<HTMLElement>(
        '.chat-container [data-history-key], .chat-container [data-process-id], .chat-container .timeline-content, .chat-container .chat-group, .chat-container > *',
      ),
    ]
      .filter(element => element.getBoundingClientRect().bottom > viewportTop)
      .sort(
        (left, right) =>
          Math.abs(left.getBoundingClientRect().top - viewportTop) -
          Math.abs(right.getBoundingClientRect().top - viewportTop),
      )
      .slice(0, 3)
      .map(element => ({ element, offset: element.getBoundingClientRect().top }));
  }
}
