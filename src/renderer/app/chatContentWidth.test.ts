// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { observeChatContentWidth, resolveChatContentWidthProgress } from './chatContentWidth';

const progressProperty = '--chat-content-width-progress';
const cleanups: Array<() => void> = [];

const resize = (width: number, availableWidth = 1920): void => {
  vi.spyOn(window, 'outerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(availableWidth);
  window.dispatchEvent(new Event('resize'));
};

beforeEach(() => {
  document.documentElement.style.cssText = '';
  resize(1280);
});
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  vi.restoreAllMocks();
});

describe('adaptive chat content width', () => {
  test.each([800, 1200, 1280])('fills the available area in a %ipx window', width => {
    expect(resolveChatContentWidthProgress(width, 1920)).toBe(0);
  });

  test('continuously approaches the configured percentage as the window grows', () => {
    const progress = [1280, 1440, 1600, 1760, 1920].map(width =>
      resolveChatContentWidthProgress(width, 1920),
    );
    expect(progress).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // The same layout factor respects custom settings as well as the 60% default.
    expect(progress.map(value => 100 - (100 - 60) * value)).toEqual([100, 90, 80, 70, 60]);
    expect(progress.map(value => 100 - (100 - 80) * value)).toEqual([100, 95, 90, 85, 80]);
  });

  test('distinguishes maximized and restored windows on smaller displays', () => {
    expect(resolveChatContentWidthProgress(1280, 1280, true)).toBe(1);
    expect(resolveChatContentWidthProgress(1280, 1280, false)).toBe(0);
    expect(resolveChatContentWidthProgress(1024, 1024, true)).toBe(1);
    expect(resolveChatContentWidthProgress(800, 1024, false)).toBe(0);
  });

  test('keeps invalid or out-of-range geometry within the supported layout range', () => {
    expect(resolveChatContentWidthProgress(2400, 1920)).toBe(1);
    expect(resolveChatContentWidthProgress(Number.NaN, 1920)).toBe(0);
    expect(resolveChatContentWidthProgress(1600, Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveChatContentWidthProgress(1600, 0)).toBe(0);
  });

  test('updates during resize and display changes without overwriting the saved percentage', () => {
    const root = document.documentElement;
    root.style.setProperty('--justdo-chat-content-width', '60%');
    const observer = observeChatContentWidth(root);
    cleanups.push(observer.dispose);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0');

    resize(1600);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0.5');
    resize(1920);
    expect(root.style.getPropertyValue(progressProperty)).toBe('1');
    resize(1920, 2560);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0.5');
    resize(1280, 2560);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0');
    expect(root.style.getPropertyValue('--justdo-chat-content-width')).toBe('60%');

    observer.dispose();
    resize(1920);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0');
  });

  test('uses native maximize and restore events and rejects an outdated initial query', async () => {
    resize(1280, 1280);
    let finishInitialQuery!: (value: boolean) => void;
    let onState!: (state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => void;
    const unsubscribe = vi.fn();
    const observer = observeChatContentWidth(document.documentElement, {
      isMaximized: () => new Promise(resolve => { finishInitialQuery = resolve; }),
      onStateChanged: callback => { onState = callback; return unsubscribe; },
    });
    cleanups.push(observer.dispose);

    onState({ isMaximized: true, isFullscreen: false, isFocused: true });
    expect(document.documentElement.style.getPropertyValue(progressProperty)).toBe('1');
    finishInitialQuery(false);
    await Promise.resolve();
    expect(document.documentElement.style.getPropertyValue(progressProperty)).toBe('1');

    onState({ isMaximized: false, isFullscreen: false, isFocused: true });
    expect(document.documentElement.style.getPropertyValue(progressProperty)).toBe('0');
    observer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test('recomputes a workspace document independently after copying the main appearance', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    cleanups.push(() => frame.remove());
    const view = frame.contentWindow!;
    const root = view.document.documentElement;
    vi.spyOn(view, 'outerWidth', 'get').mockReturnValue(1920);
    vi.spyOn(view, 'innerWidth', 'get').mockReturnValue(900);
    vi.spyOn(view.screen, 'availWidth', 'get').mockReturnValue(1920);
    const observer = observeChatContentWidth(root);
    cleanups.push(observer.dispose);

    root.style.setProperty(progressProperty, '1');
    observer.update();
    expect(root.style.getPropertyValue(progressProperty)).toBe('0');
    resize(1920);
    expect(root.style.getPropertyValue(progressProperty)).toBe('0');
  });
});
