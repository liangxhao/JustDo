import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatScrollController } from './chat-scroll-controller';

function host(options: { asyncSmooth?: boolean } = {}) {
  const listeners = new Map<string, EventListener>();
  const target = {
    scrollHeight: 1000,
    scrollTop: 700,
    clientHeight: 300,
    scrollTo: vi.fn(({ top, behavior }: ScrollToOptions) => {
      if (typeof top === 'number' && !(options.asyncSmooth && behavior === 'smooth')) {
        target.scrollTop = top;
      }
    }),
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener),
    ),
    removeEventListener: vi.fn(),
    emitScroll() {
      listeners.get('scroll')?.(new Event('scroll'));
    },
    emitScrollEnd() {
      listeners.get('scrollend')?.(new Event('scrollend'));
    },
  };
  return target;
}

describe('ChatScrollController', () => {
  test('a deliberate scroll up pauses follow even near the bottom', () => {
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 698;
    target.emitScroll();

    expect(controller.state.mode).toBe('paused');
  });

  test('jump to latest restores follow mode', () => {
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.scrollTop = 500;
    target.emitScroll();

    controller.jumpToLatest();

    expect(controller.state).toEqual({ mode: 'follow', unseenRevisions: 0 });
    expect(target.scrollTop).toBe(1000);
  });

  test('does not restore stale anchors while smooth minimap navigation is in flight', async () => {
    const target = host({ asyncSmooth: true }) as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      getBoundingClientRect: () => { top: number };
    };
    let anchorTop = 100;
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 40 }),
    };
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
    target.getBoundingClientRect = () => ({ top: 0 });
    const onStateChange = vi.fn();
    const controller = new ChatScrollController(onStateChange);
    controller.connect(target as unknown as HTMLElement);
    controller.afterRender(1);
    await Promise.resolve();
    target.scrollTop = 700;

    controller.navigateTo(240, 'smooth');
    controller.beforeRender();
    anchorTop = 80;
    controller.afterRender(1);

    expect(controller.state.mode).toBe('paused');
    expect(target.scrollTo).toHaveBeenCalledWith({ top: 240, behavior: 'smooth' });
    expect(target.scrollTop).toBe(700);
    expect(onStateChange).toHaveBeenCalledOnce();

    target.scrollTop = 240;
    target.emitScroll();
    controller.beforeRender();
    anchorTop = 100;
    controller.afterRender(1);

    expect(target.scrollTop).toBe(260);
  });

  test('ends smooth minimap navigation when scrolling is interrupted', () => {
    const target = host({ asyncSmooth: true });
    const loadOlder = vi.fn();
    const controller = new ChatScrollController(vi.fn(), loadOlder);
    controller.connect(target as unknown as HTMLElement);

    controller.navigateTo(240, 'smooth');
    target.scrollTop = 400;
    target.emitScrollEnd();

    expect(loadOlder).not.toHaveBeenCalled();

    target.scrollTop = 120;
    target.emitScroll();

    expect(controller.state.mode).toBe('paused');
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  test('keeps a clicked disclosure fixed instead of following the expanded content', () => {
    const target = host();
    let anchorTop = 240;
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 32 }),
    };
    const onStateChange = vi.fn();
    const controller = new ChatScrollController(onStateChange);
    controller.connect(target as unknown as HTMLElement);
    controller.afterRender(1);
    target.scrollTop = 700;

    controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);
    controller.beforeRender();
    anchorTop = 180;
    controller.afterRender(1);

    expect(controller.state).toEqual({ mode: 'paused', unseenRevisions: 0 });
    expect(target.scrollTop).toBe(640);
    expect(onStateChange).toHaveBeenCalled();
  });

  test('falls back to a nearby anchor when the clicked disclosure is replaced', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      getBoundingClientRect: () => { top: number };
    };
    let fallbackTop = 300;
    const fallback = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: fallbackTop, bottom: fallbackTop + 40 }),
    };
    const clicked = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: 240, bottom: 272 }),
    };
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [fallback] };
    target.getBoundingClientRect = () => ({ top: 0 });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.afterRender(1);
    target.scrollTop = 700;

    controller.preserveAnchorForInteraction(clicked as unknown as HTMLElement);
    controller.beforeRender();
    clicked.isConnected = false;
    fallbackTop = 260;
    controller.afterRender(1);

    expect(target.scrollTop).toBe(660);
  });

  test('preserves unseen revisions when opening a disclosure while paused', async () => {
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.afterRender(1);
    await Promise.resolve();
    target.scrollTop = 500;
    target.emitScroll();
    controller.beforeRender();
    controller.afterRender(2);
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: 240, bottom: 272 }),
    };

    controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);

    expect(controller.state).toEqual({ mode: 'paused', unseenRevisions: 1 });
  });

  test('requests an older page when the user scrolls near the top', () => {
    const target = host();
    const loadOlder = vi.fn();
    const controller = new ChatScrollController(vi.fn(), loadOlder);
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 120;
    target.emitScroll();

    expect(loadOlder).toHaveBeenCalledOnce();
  });

  test('prefetches history before the edge and only in the active scroll direction', () => {
    const target = host();
    const loadOlder = vi.fn();
    const showNewer = vi.fn().mockReturnValue(true);
    const controller = new ChatScrollController(vi.fn(), loadOlder, showNewer);
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 500;
    target.emitScroll();

    expect(loadOlder).toHaveBeenCalledOnce();
    expect(showNewer).not.toHaveBeenCalled();

    target.scrollTop = 540;
    target.emitScroll();

    expect(showNewer).toHaveBeenCalledOnce();
  });

  test.each([true, false])(
    'rearms older history after an asynchronous request settles with %s',
    async result => {
      const target = host();
      const loadOlder = vi.fn().mockResolvedValue(result);
      const controller = new ChatScrollController(vi.fn(), loadOlder);
      controller.connect(target as unknown as HTMLElement);

      target.scrollTop = 500;
      target.emitScroll();
      target.scrollTop = 450;
      target.emitScroll();

      expect(loadOlder).toHaveBeenCalledOnce();

      await Promise.resolve();
      target.scrollTop = 400;
      target.emitScroll();

      expect(loadOlder).toHaveBeenCalledTimes(2);
    },
  );

  test('rearms older history after a rejected request', async () => {
    const target = host();
    const loadOlder = vi.fn().mockRejectedValue(new Error('temporary history failure'));
    const controller = new ChatScrollController(vi.fn(), loadOlder);
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 500;
    target.emitScroll();
    await Promise.resolve();
    target.scrollTop = 450;
    target.emitScroll();

    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  test('rearms a short newer history shift after the render microtask', async () => {
    const target = host();
    target.scrollTop = 300;
    const showNewer = vi.fn().mockReturnValue(true);
    const controller = new ChatScrollController(vi.fn(), undefined, showNewer);
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 350;
    target.emitScroll();
    target.scrollTop = 400;
    target.emitScroll();

    expect(showNewer).toHaveBeenCalledOnce();

    await Promise.resolve();
    target.scrollTop = 450;
    target.emitScroll();

    expect(showNewer).toHaveBeenCalledTimes(2);
  });

  test('does not treat completed auto navigation as user history traversal', () => {
    const target = host();
    const loadOlder = vi.fn();
    const showNewer = vi.fn().mockReturnValue(true);
    const controller = new ChatScrollController(vi.fn(), loadOlder, showNewer);
    controller.connect(target as unknown as HTMLElement);

    controller.navigateTo(120, 'auto');
    target.emitScroll();

    expect(loadOlder).not.toHaveBeenCalled();
    expect(showNewer).not.toHaveBeenCalled();

    target.scrollTop = 100;
    target.emitScroll();

    expect(loadOlder).toHaveBeenCalledOnce();
  });

  test('coalesces anchor refreshes and measures only nearby ordered rows', () => {
    let scheduledCapture: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      scheduledCapture = callback;
      return 1;
    });
    const rect = vi.fn((index: number) => ({
      top: (index - 1_000) * 20,
      bottom: (index - 1_000) * 20 + 20,
    }));
    const anchors = Array.from({ length: 2_048 }, (_, index) => ({
      isConnected: true,
      getBoundingClientRect: () => rect(index),
    }));
    const target = host() as ReturnType<typeof host> & {
      ownerDocument: {
        defaultView: {
          requestAnimationFrame: typeof requestAnimationFrame;
          cancelAnimationFrame: ReturnType<typeof vi.fn>;
        };
      };
      shadowRoot: { querySelectorAll: ReturnType<typeof vi.fn> };
      getBoundingClientRect: () => { top: number };
    };
    target.ownerDocument = {
      defaultView: { requestAnimationFrame, cancelAnimationFrame: vi.fn() },
    };
    target.shadowRoot = { querySelectorAll: vi.fn(() => anchors) };
    target.getBoundingClientRect = () => ({ top: 0 });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 500;
    target.emitScroll();
    target.scrollTop = 450;
    target.emitScroll();

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    const runScheduledCapture = scheduledCapture as FrameRequestCallback | null;
    runScheduledCapture?.(0);
    expect(target.shadowRoot.querySelectorAll).toHaveBeenCalledOnce();
    expect(rect.mock.calls.length).toBeLessThan(20);
  });

  test('keeps paused mode while a logical newer window replaces the rendered bottom', () => {
    const target = host();
    const showNewer = vi.fn().mockReturnValue(true);
    const controller = new ChatScrollController(vi.fn(), undefined, showNewer);
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 500;
    target.emitScroll();
    target.scrollTop = 700;
    target.emitScroll();

    expect(showNewer).toHaveBeenCalled();
    expect(controller.state.mode).toBe('paused');
  });

  test('preserves a paused anchor across asynchronous content height changes', () => {
    let resize: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let anchorTop = 10;
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: anchorTop, bottom: anchorTop + 40 }),
    };
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: {
        querySelector: () => object;
        querySelectorAll: () => object[];
      };
      getBoundingClientRect: () => { top: number };
    };
    target.shadowRoot = {
      querySelector: () => ({}),
      querySelectorAll: () => [anchor],
    };
    target.getBoundingClientRect = () => ({ top: 0 });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.scrollTop = 500;
    target.emitScroll();
    controller.beforeRender();
    controller.afterRender(1);

    anchorTop = 40;
    const triggerResize = resize as (() => void) | null;
    triggerResize?.();

    expect(target.scrollTop).toBe(530);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
