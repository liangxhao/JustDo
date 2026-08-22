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
