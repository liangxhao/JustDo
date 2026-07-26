import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatScrollController } from './chat-scroll-controller';

function host() {
  const listeners = new Map<string, EventListener>();
  return {
    scrollHeight: 1000,
    scrollTop: 700,
    clientHeight: 300,
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener),
    ),
    removeEventListener: vi.fn(),
    emitScroll() {
      listeners.get('scroll')?.(new Event('scroll'));
    },
  };
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
