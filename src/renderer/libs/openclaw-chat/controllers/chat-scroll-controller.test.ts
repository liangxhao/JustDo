// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatScrollController } from './chat-scroll-controller';

function host(options: { asyncSmooth?: boolean } = {}) {
  const listeners = new Map<string, EventListener>();
  const target = {
    ownerDocument: document,
    scrollHeight: 1000,
    scrollTop: 700,
    clientHeight: 300,
    clientTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: vi.fn(({ top, behavior }: ScrollToOptions) => {
      if (typeof top === 'number' && !(options.asyncSmooth && behavior === 'smooth')) {
        target.scrollTop = top;
      }
    }),
    addEventListener: vi.fn((name: string, listener: EventListener) =>
      listeners.set(name, listener),
    ),
    removeEventListener: vi.fn(),
    emit(name: string, event: Event) {
      listeners.get(name)?.(event);
    },
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
  function scrollbarHost(
    onNearTop?: () => boolean | void,
    onNearBottom?: () => boolean,
    scrollTop = 700,
  ) {
    const target = document.createElement('div');
    Object.defineProperties(target, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 300 },
      clientWidth: { value: 490 },
      offsetWidth: { value: 500 },
    });
    target.getBoundingClientRect = () =>
      ({ left: 20, right: 520, top: 30, bottom: 330 }) as DOMRect;
    target.scrollTop = scrollTop;
    target.scrollTo = vi.fn();
    const controller = new ChatScrollController(vi.fn(), onNearTop, onNearBottom);
    controller.connect(target);
    const press = (options: PointerEventInit = {}) =>
      target.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 518,
          clientY: 315,
          button: 0,
          pointerId: 1,
          bubbles: true,
          ...options,
        }),
      );
    return { target, controller, press };
  }

  test('pressing the native scrollbar pauses output before the first scroll event', () => {
    const { target, controller, press } = scrollbarHost();
    press();
    Object.defineProperty(target, 'scrollHeight', { value: 1200 });
    controller.beforeRender();
    controller.afterRender(1);

    expect(controller.state.mode).toBe('paused');
    expect(target.scrollTop).toBe(700);
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
  });

  test('keeps scrollbar dragging paused until the matching pointer is released at the bottom', () => {
    const { target, controller, press } = scrollbarHost();
    press();
    target.scrollTop = 500;
    target.dispatchEvent(new Event('scroll'));
    target.scrollTop = 700;
    target.dispatchEvent(new Event('scroll'));
    expect(controller.state.mode).toBe('paused');

    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    expect(controller.state.mode).toBe('paused');
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(controller.state.mode).toBe('follow');
    controller.disconnect();
  });

  test('scrollbar input interrupts smooth navigation before streaming can restore it', () => {
    const { target, controller, press } = scrollbarHost();
    controller.navigateTo(100, 'smooth');
    press();
    expect(target.scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'instant' });
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
  });

  test.each(['older', 'newer'] as const)(
    'waits for thumb release before shifting %s history',
    direction => {
      const older = vi.fn(() => false);
      const newer = vi.fn(() => true);
      const { target, controller, press } = scrollbarHost(older, newer, 300);
      press();
      target.scrollTop = direction === 'older' ? 100 : 500;
      target.dispatchEvent(new Event('scroll'));
      expect(older).not.toHaveBeenCalled();
      expect(newer).not.toHaveBeenCalled();

      document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));

      expect(direction === 'older' ? older : newer).toHaveBeenCalledOnce();
      expect(direction === 'older' ? newer : older).not.toHaveBeenCalled();
      controller.disconnect();
    },
  );

  test.each([{ clientX: 250 }, { button: 2 }])(
    'does not pause follow for a content click or secondary scrollbar click: %o',
    options => {
      const { controller, press } = scrollbarHost();
      press(options);
      expect(controller.state.mode).toBe('follow');
      controller.disconnect();
    },
  );

  test('a nested scrollbar does not take over the transcript scroll mode', () => {
    const { target, controller } = scrollbarHost();
    const child = document.createElement('div');
    target.attachShadow({ mode: 'open' }).append(child);
    child.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: 518,
        clientY: 315,
        button: 0,
        pointerId: 1,
        bubbles: true,
        composed: true,
      }),
    );
    expect(controller.state.mode).toBe('follow');
    controller.disconnect();
  });

  function nestedHost() {
    const target = document.createElement('div');
    const root = target.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.style.overflowY = 'auto';
    root.append(inner);
    Object.defineProperties(target, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    });
    Object.defineProperties(inner, {
      scrollHeight: { value: 600 },
      clientHeight: { value: 200 },
    });
    target.scrollTop = 700;
    inner.scrollTop = 100;
    target.scrollTo = vi.fn();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target);
    return { target, inner, controller };
  }

  test('keeps following when an inner output consumes upward scrolling', () => {
    const { inner, controller } = nestedHost();
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    expect(controller.state.mode).toBe('follow');
    inner.scrollTop = 0;
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
  });

  test('recognizes nested scrolling in a detached workspace document', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const owner = frame.contentDocument!;
    const target = owner.createElement('div');
    const inner = owner.createElement('div');
    inner.style.overflowY = 'auto';
    target.attachShadow({ mode: 'open' }).append(inner);
    Object.defineProperties(target, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    });
    Object.defineProperties(inner, {
      scrollHeight: { value: 600 },
      clientHeight: { value: 200 },
    });
    target.scrollTop = 700;
    inner.scrollTop = 100;
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target);

    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));

    expect(controller.state.mode).toBe('follow');
    inner.scrollTop = 0;
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
    frame.remove();
  });

  test.each(['contain', 'none'])('respects inner %s scroll containment at its boundary', policy => {
    const { inner, controller } = nestedHost();
    inner.scrollTop = 0;
    inner.style.overscrollBehaviorY = policy;
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    expect(controller.state.mode).toBe('follow');
    controller.disconnect();
  });

  test('only interrupts smooth navigation when downward input can reach the transcript', () => {
    const { target, inner, controller } = nestedHost();
    controller.navigateTo(100, 'smooth');
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, composed: true }));
    expect(target.scrollTo).toHaveBeenCalledTimes(1);
    inner.scrollTop = 400;
    inner.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, composed: true }));
    expect(target.scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'instant' });
    controller.disconnect();
  });

  test('keeps nested keyboard scrolling and shadow-root editing separate from transcript intent', () => {
    const { inner, controller } = nestedHost();
    inner.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, composed: true }),
    );
    expect(controller.state.mode).toBe('follow');
    inner.scrollTop = 0;
    const input = document.createElement('textarea');
    inner.append(input);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true, composed: true }),
    );
    expect(controller.state.mode).toBe('follow');
    inner.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, composed: true }),
    );
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
  });
  test('pauses on upward intent before native scrolling even without history pagination', () => {
    class TestWheelEvent extends Event {
      constructor(
        public deltaY: number,
        public ctrlKey = false,
      ) {
        super('wheel');
      }
    }
    vi.stubGlobal('WheelEvent', TestWheelEvent);
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.emit('wheel', new TestWheelEvent(-40));
    target.scrollHeight = 1200;
    controller.beforeRender();
    controller.afterRender(1);
    expect(controller.state.mode).toBe('paused');
    expect(target.scrollTop).toBe(700);
  });

  test('does not pause follow for a zoom gesture', () => {
    class TestWheelEvent extends Event {
      deltaY = -40;
      ctrlKey = true;
      constructor() {
        super('wheel');
      }
    }
    vi.stubGlobal('WheelEvent', TestWheelEvent);
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.emit('wheel', new TestWheelEvent());
    expect(controller.state.mode).toBe('follow');
  });

  test('hands smooth navigation back to the user on wheel input', () => {
    class TestWheelEvent extends Event {
      deltaY = -40;
      constructor() {
        super('wheel');
      }
    }
    vi.stubGlobal('WheelEvent', TestWheelEvent);
    const target = host({ asyncSmooth: true });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.navigateTo(100, 'smooth');
    target.emit('wheel', new TestWheelEvent());
    expect(target.scrollTo).toHaveBeenLastCalledWith({ top: 700, behavior: 'instant' });
    target.scrollTop = 650;
    target.emitScroll();
    expect(controller.state.mode).toBe('paused');
  });
  test('a deliberate scroll up pauses follow even near the bottom', () => {
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    target.scrollTop = 698;
    target.emitScroll();

    expect(controller.state.mode).toBe('paused');
  });

  test('a delayed programmatic scroll event cannot resume follow after upward intent', async () => {
    const target = host();
    Object.defineProperty(target, 'scrollTop', {
      get: () => 700,
      set: () => {},
    });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.afterRender(1);
    await Promise.resolve();

    target.emit('wheel', new WheelEvent('wheel', { deltaY: -40 }));
    target.emitScroll();
    target.scrollHeight = 1200;
    controller.beforeRender();
    controller.afterRender(2);

    expect(controller.state.mode).toBe('paused');
    expect(target.scrollTop).toBe(700);
    controller.disconnect();
  });

  test('clamping a shrinking transcript does not resume follow', () => {
    const target = host();
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.scrollTop = 500;
    target.emitScroll();

    target.scrollHeight = 700;
    target.scrollTop = 400;
    target.emitScroll();

    expect(controller.state.mode).toBe('paused');
    target.scrollHeight = 1200;
    controller.beforeRender();
    controller.afterRender(1);
    expect(target.scrollTop).toBe(400);
    controller.disconnect();
  });

  test.each([200, 300, 301])('hides the jump button when content fits (%s px)', height => {
    const target = host();
    target.scrollTop = 0;
    target.scrollHeight = height;
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    controller.preserveAnchorForInteraction({
      isConnected: true,
      getBoundingClientRect: () => ({ top: 0 }),
    } as HTMLElement);
    controller.afterRender(1);

    expect(controller.state.mode).toBe('paused');
    expect(controller.canScrollDown).toBe(false);
  });

  test('updates jump availability when paused content or the viewport resizes', () => {
    let resize = () => {};
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
    const target = host();
    const onStateChange = vi.fn();
    const controller = new ChatScrollController(onStateChange);
    controller.connect(target as unknown as HTMLElement);
    target.scrollTop = 500;
    target.emitScroll();
    expect(controller.canScrollDown).toBe(true);

    target.scrollHeight = 800;
    onStateChange.mockClear();
    resize();
    expect(controller.canScrollDown).toBe(false);
    expect(onStateChange).toHaveBeenCalled();

    target.scrollHeight = 1000;
    resize();
    expect(controller.canScrollDown).toBe(true);

    target.clientHeight = 500;
    resize();
    expect(controller.canScrollDown).toBe(false);
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

  test('element navigation owns smooth scrolling while output continues', () => {
    const target = host();
    const element = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: 100, height: 40 }),
      scrollIntoView: vi.fn(),
    };
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    controller.navigateToElement(element as unknown as HTMLElement, 'smooth');
    controller.beforeRender();
    target.scrollHeight = 1200;
    controller.afterRender(1);

    expect(element.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    expect(controller.state.mode).toBe('paused');
    expect(target.scrollTop).toBe(700);
    controller.disconnect();
  });

  test('finishes inner-only element navigation so later layout changes preserve the reader', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
    };
    target.scrollTop = 450;
    let contentTop = 500;
    const inner = document.createElement('div');
    inner.style.overflowY = 'auto';
    Object.defineProperties(inner, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 200 },
    });
    inner.getBoundingClientRect = () =>
      ({
        top: contentTop - target.scrollTop,
        bottom: contentTop - target.scrollTop + 200,
      }) as DOMRect;
    const element = document.createElement('span');
    inner.append(element);
    document.body.append(inner);
    element.getBoundingClientRect = () =>
      ({ top: contentTop + 400 - inner.scrollTop - target.scrollTop, height: 20 }) as DOMRect;
    element.scrollIntoView = vi.fn(() => {
      inner.scrollTop = 310;
    });
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [inner] };
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);

    controller.navigateToElement(element, 'smooth');
    controller.beforeRender();
    contentTop += 60;
    controller.afterRender(1);

    expect(element.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'instant',
      block: 'center',
      inline: 'nearest',
    });
    expect(target.scrollTop).toBe(510);
    expect(inner.getBoundingClientRect().top).toBe(50);
    expect(controller.state.mode).toBe('paused');
    controller.disconnect();
    inner.remove();
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

  test('output below a paused reader does not cancel native dragging with redundant scroll writes', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
    };
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({ top: 20, bottom: 60 }),
    };
    const write = vi.fn();
    Object.defineProperty(target, 'scrollTop', { get: () => 500, set: write });
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);

    controller.beforeRender();
    target.scrollHeight = 1200;
    controller.afterRender(1);

    expect(write).not.toHaveBeenCalled();
    controller.disconnect();
  });

  test('does not accumulate fractional scroll rounding across progressive history commits', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      getBoundingClientRect: () => { top: number };
    };
    target.scrollHeight = 10_000;
    let scrollTop = 100;
    let contentTop = 140;
    Object.defineProperty(target, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.round(value);
      },
    });
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: contentTop - scrollTop,
        bottom: contentTop - scrollTop + 40,
      }),
    };
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
    target.getBoundingClientRect = () => ({ top: 0 });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);
    for (let batch = 0; batch < 40; batch += 1) {
      controller.beforeRender();
      contentTop += 100.25;
      controller.afterRender(batch);
      expect(Math.abs(anchor.getBoundingClientRect().top - 40)).toBeLessThanOrEqual(0.5);
    }
    controller.disconnect();
  });

  test('restores the reading row after the browser clamps a shrinking history window', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      getBoundingClientRect: () => { top: number };
    };
    target.clientHeight = 600;
    target.scrollHeight = 250 * 30;
    let scrollTop = 230 * 30;
    let contentTop = scrollTop;
    Object.defineProperty(target, 'scrollTop', {
      get: () => Math.min(scrollTop, target.scrollHeight - target.clientHeight),
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, target.scrollHeight - target.clientHeight));
      },
    });
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: contentTop - target.scrollTop,
        bottom: contentTop - target.scrollTop + 30,
      }),
    };
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
    target.getBoundingClientRect = () => ({ top: 0 });
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);
    controller.beforeRender();
    // A newer window removes 64 rows before adding the first eight rows.
    contentTop -= 64 * 30;
    target.scrollHeight = (250 - 64 + 8) * 30;
    expect(anchor.getBoundingClientRect().top).toBe(-240);
    controller.afterRender(1);
    expect(anchor.getBoundingClientRect().top).toBe(0);
    expect(target.scrollTop).toBe(4_980);
    controller.disconnect();
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

  test('loads and retries from upward wheel intent when scrollTop cannot move', async () => {
    class TestWheelEvent extends Event {
      constructor(public readonly deltaY: number) {
        super('wheel');
      }
    }
    vi.stubGlobal('WheelEvent', TestWheelEvent);
    const target = host();
    target.scrollTop = 0;
    target.scrollHeight = target.clientHeight;
    const loadOlder = vi.fn().mockResolvedValue(false);
    const controller = new ChatScrollController(vi.fn(), loadOlder);
    controller.connect(target as unknown as HTMLElement);

    target.emit('wheel', new TestWheelEvent(-40));
    expect(loadOlder).toHaveBeenCalledOnce();

    await Promise.resolve();
    target.emit('wheel', new TestWheelEvent(-40));
    expect(loadOlder).toHaveBeenCalledTimes(2);
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

  test('waits for all progressive commits before accepting another newer shift', async () => {
    const target = host();
    target.scrollTop = 300;
    let finish!: (shifted: boolean) => void;
    const showNewer = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finish = resolve;
        }),
    );
    const controller = new ChatScrollController(vi.fn(), undefined, showNewer);
    controller.connect(target as unknown as HTMLElement);
    for (let frame = 0; frame < 8; frame += 1) {
      target.scrollTop += 20;
      target.emitScroll();
      await Promise.resolve();
    }
    expect(showNewer).toHaveBeenCalledOnce();
    target.scrollTop = target.scrollHeight - target.clientHeight;
    target.emitScroll();
    expect(controller.state.mode).toBe('paused');
    finish(true);
    await Promise.resolve();
    target.scrollTop += 20;
    target.emitScroll();
    expect(showNewer).toHaveBeenCalledTimes(2);
    controller.disconnect();
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
      shadowRoot: { querySelectorAll: ReturnType<typeof vi.fn> };
      getBoundingClientRect: () => { top: number };
    };
    Object.defineProperty(target, 'ownerDocument', {
      value: { defaultView: { requestAnimationFrame, cancelAnimationFrame: vi.fn() } },
    });
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

  test.each([-80, 80])(
    'keeps %i px of manual scrolling when content resizes before the anchor refresh',
    async scrollDelta => {
      let resize = () => {};
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
      const target = host() as ReturnType<typeof host> & {
        shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      };
      let contentTop = 520;
      const anchor = {
        isConnected: true,
        getBoundingClientRect: () => ({
          top: contentTop - target.scrollTop,
          bottom: contentTop - target.scrollTop + 200,
        }),
      };
      target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
      const controller = new ChatScrollController(vi.fn());
      controller.connect(target as unknown as HTMLElement);
      target.scrollTop = 500;
      target.emitScroll();
      controller.beforeRender();
      controller.afterRender(1);
      await Promise.resolve();

      target.scrollTop += scrollDelta;
      target.emitScroll();
      contentTop += 30;
      resize();

      expect(target.scrollTop).toBe(530 + scrollDelta);
      controller.disconnect();
    },
  );

  test('moving the transcript viewport does not move the paused reading position', () => {
    const target = host() as ReturnType<typeof host> & {
      shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
    };
    let viewportTop = 0;
    target.getBoundingClientRect = () => ({ top: viewportTop });
    const anchor = {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: viewportTop + 520 - target.scrollTop,
        bottom: viewportTop + 560 - target.scrollTop,
      }),
    };
    target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
    const controller = new ChatScrollController(vi.fn());
    controller.connect(target as unknown as HTMLElement);
    target.scrollTop = 500;
    target.emitScroll();
    controller.beforeRender();
    viewportTop += 60;
    controller.afterRender(1);

    expect(target.scrollTop).toBe(500);
    controller.disconnect();
  });

  test.each([0, -50])(
    'separates a native clamp before resize from %i px of coalesced user scrolling',
    async userScroll => {
      let resize = () => {};
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
      const target = host() as ReturnType<typeof host> & {
        shadowRoot: { querySelector: () => object; querySelectorAll: () => object[] };
      };
      let scrollTop = 500;
      let contentTop = 520;
      Object.defineProperty(target, 'scrollTop', {
        get: () => Math.min(scrollTop, target.scrollHeight - target.clientHeight),
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, target.scrollHeight - target.clientHeight));
        },
      });
      const anchor = {
        isConnected: true,
        getBoundingClientRect: () => ({
          top: contentTop - target.scrollTop,
          bottom: contentTop - target.scrollTop + 40,
        }),
      };
      target.shadowRoot = { querySelector: () => ({}), querySelectorAll: () => [anchor] };
      const controller = new ChatScrollController(vi.fn());
      controller.connect(target as unknown as HTMLElement);
      controller.preserveAnchorForInteraction(anchor as unknown as HTMLElement);
      controller.afterRender(1);
      await Promise.resolve();

      contentTop -= 400;
      target.scrollHeight -= 400;
      expect(target.scrollTop).toBe(300);
      target.scrollTop += userScroll;
      target.emitScroll();
      resize();

      expect(target.scrollTop).toBe(100 + userScroll);
      expect(anchor.getBoundingClientRect().top).toBe(20 - userScroll);
      expect(controller.state.mode).toBe('paused');
      controller.disconnect();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});
