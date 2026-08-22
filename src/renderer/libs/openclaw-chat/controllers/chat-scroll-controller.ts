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
  private navigationTargetTop: number | null = null;

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
    host.addEventListener('scrollend', this.handleScrollEnd, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(host);
    }
  }

  beforeRender(): void {
    if (!this.host) return;
    this.previousScrollTop = this.host.scrollTop;
    if (this.navigationTargetTop !== null) {
      this.pausedAnchors = [];
    } else if (!this.interactionAnchor) {
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
    const navigating = this.navigationTargetTop !== null;
    if (!navigating) {
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
    }
    this.interactionAnchor = null;
    if (changed) {
      this.unseenRevisions += 1;
      this.onStateChange();
    }
    this.pausedAnchors = navigating ? [] : this.captureVisibleAnchors(host);
    this.observeContent();
  }

  jumpToLatest(): void {
    this.mode = 'follow';
    this.unseenRevisions = 0;
    this.interactionAnchor = null;
    this.finishNavigation();
    this.scrollToBottom();
    this.onStateChange();
  }

  navigateTo(top: number, behavior: ScrollBehavior): void {
    const host = this.host;
    if (!host) return;
    const modeChanged = this.mode !== 'paused';
    this.mode = 'paused';
    this.interactionAnchor = null;
    this.pausedAnchors = [];
    this.navigationTargetTop = Math.max(0, top);
    host.scrollTo({ top: this.navigationTargetTop, behavior });
    if (this.isNavigationAtTarget(host)) this.finishNavigation();
    if (modeChanged) this.onStateChange();
  }

  preserveAnchorForInteraction(element: HTMLElement): void {
    if (!this.host || !element.isConnected) return;
    this.finishNavigation();
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
    this.finishNavigation();
    this.onStateChange();
  }

  disconnect(): void {
    this.host?.removeEventListener('scroll', this.handleScroll);
    this.host?.removeEventListener('scrollend', this.handleScrollEnd);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedContent = null;
    this.host = null;
    this.interactionAnchor = null;
    this.navigationTargetTop = null;
  }

  private readonly handleScroll = (): void => {
    const host = this.host;
    if (!host || this.programmatic) return;
    if (this.navigationTargetTop !== null) {
      if (!this.isNavigationAtTarget(host)) return;
      this.finishNavigation();
    }
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

  private readonly handleScrollEnd = (): void => {
    if (this.navigationTargetTop === null) return;
    this.finishNavigation();
    this.handleScroll();
  };

  private handleResize(): void {
    const host = this.host;
    if (!host) return;
    if (this.navigationTargetTop !== null) return;
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

  private finishNavigation(): void {
    if (this.navigationTargetTop === null) return;
    this.navigationTargetTop = null;
    this.pausedAnchors = this.host ? this.captureVisibleAnchors(this.host) : [];
  }

  private isNavigationAtTarget(host: HTMLElement): boolean {
    if (this.navigationTargetTop === null) return false;
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    return Math.abs(host.scrollTop - Math.min(this.navigationTargetTop, maxScrollTop)) <= 0.5;
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
