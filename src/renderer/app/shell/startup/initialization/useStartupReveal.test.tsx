// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import {
  STARTUP_ENTRY_DURATION_MS,
  STARTUP_ENTRY_STARTED_ATTRIBUTE,
  STARTUP_REVEAL_DURATION_MS,
} from './startupMotion';
import { useStartupReveal } from './useStartupReveal';

function Probe({ firstLaunch = false, loading = true }) {
  const { covered, revealing } = useStartupReveal(firstLaunch, loading);
  return (
    <output data-covered={covered} data-revealing={revealing}>
      presentation
    </output>
  );
}
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE);
  vi.useRealTimers();
});

test('waits for real readiness and the one entry, then reveals the home page once', () => {
  vi.useFakeTimers();
  document.documentElement.setAttribute(STARTUP_ENTRY_STARTED_ATTRIBUTE, String(Date.now()));
  const view = render(<Probe />);
  const output = screen.getByText('presentation');
  act(() => vi.advanceTimersByTime(300));
  expect(output.dataset.covered).toBe('true');
  expect(output.dataset.revealing).toBe('false');
  view.rerender(<Probe loading={false} />);
  act(() => vi.advanceTimersByTime(STARTUP_ENTRY_DURATION_MS - 301));
  expect(output.dataset.revealing).toBe('false');
  act(() => vi.advanceTimersByTime(1));
  expect(output.dataset.revealing).toBe('true');
  expect(output.dataset.covered).toBe('true');
  act(() => vi.advanceTimersByTime(STARTUP_REVEAL_DURATION_MS));
  expect(output.dataset.covered).toBe('false');
  view.rerender(<Probe loading={false} />);
  expect(output.dataset.covered).toBe('false');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('fresh setup uses the shared reveal only after real readiness', () => {
  vi.useFakeTimers();
  const view = render(<Probe firstLaunch />);
  view.rerender(<Probe firstLaunch loading={false} />);
  act(() => vi.advanceTimersByTime(0));
  expect(screen.getByText('presentation').dataset.covered).toBe('true');
  expect(screen.getByText('presentation').dataset.revealing).toBe('true');
  act(() => vi.advanceTimersByTime(STARTUP_REVEAL_DURATION_MS));
  expect(screen.getByText('presentation').dataset.covered).toBe('false');
  expect(vi.getTimerCount()).toBe(0);
});

test('a failure during reveal covers the application again and cancels dismissal', () => {
  vi.useFakeTimers();
  const view = render(<Probe loading={false} />);
  act(() => vi.advanceTimersByTime(0));
  expect(screen.getByText('presentation').dataset.revealing).toBe('true');
  view.rerender(<Probe loading />);
  act(() => vi.advanceTimersByTime(STARTUP_REVEAL_DURATION_MS));
  expect(screen.getByText('presentation').dataset.covered).toBe('true');
  expect(screen.getByText('presentation').dataset.revealing).toBe('false');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
