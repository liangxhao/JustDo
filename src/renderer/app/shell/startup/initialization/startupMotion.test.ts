// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  prepareStartupEntry,
  STARTUP_ENTRY_DURATION_MS,
  STARTUP_ENTRY_STARTED_ATTRIBUTE,
  startupEntryRemaining,
} from './startupMotion';

beforeEach(() => {
  HTMLElement.prototype.animate = vi.fn(() => ({ currentTime: 0, cancel: vi.fn() })) as never;
});

afterEach(() => {
  document.documentElement.removeAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE);
  document.body.replaceChildren();
  vi.useRealTimers();
});

function frame() {
  const element = document.createElement('main');
  element.innerHTML = '<div class="startup-emblem"><img src="logo.png" /></div>';
  element.querySelector('img')!.animate = vi.fn(() => ({
    currentTime: 0,
    cancel: vi.fn(),
  })) as never;
  document.body.append(element);
  return element;
}

test('continues one entry clock across the static document and React replacements', () => {
  vi.useFakeTimers();
  const first = frame();
  const releaseFirst = prepareStartupEntry(first);
  expect(first.dataset.entry).toBe('opening');
  vi.advanceTimersByTime(600);
  releaseFirst();
  first.remove();
  const react = frame();
  const releaseReact = prepareStartupEntry(react);
  expect(startupEntryRemaining()).toBe(STARTUP_ENTRY_DURATION_MS - 600);
  expect(document.querySelectorAll('.startup-soft-seed')).toHaveLength(1);
  expect(react.contains(document.querySelector('.startup-soft-seed'))).toBe(true);
  vi.advanceTimersByTime(STARTUP_ENTRY_DURATION_MS - 600);
  expect(react.dataset.entry).toBe('open');
  releaseReact();
  const snapshot = frame();
  const releaseSnapshot = prepareStartupEntry(snapshot);
  expect(snapshot.dataset.entry).toBe('open');
  releaseSnapshot();
  expect(vi.getTimerCount()).toBe(0);
});

test('reveals failures immediately without reserving an animation or leaving timers', () => {
  vi.useFakeTimers();
  const element = frame();
  const release = prepareStartupEntry(element, true);
  expect(element.dataset.entry).toBe('open');
  expect(document.documentElement.hasAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE)).toBe(false);
  release();
  expect(vi.getTimerCount()).toBe(0);
});
