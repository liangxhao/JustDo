// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import {
  RendererStartupActivity,
  StartupStartedAtContext,
} from '../initialization/startupPresentation';
import StartupLoading from './StartupLoading';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('names the real renderer operation without inventing measurable progress', () => {
  vi.useFakeTimers();
  const view = render(<StartupLoading activity={RendererStartupActivity.Conversations} />);
  expect(screen.getByText('startupRenderer_conversations')).toBeTruthy();
  const progress = screen.getByRole('progressbar');
  expect(progress.hasAttribute('aria-valuenow')).toBe(false);
  act(() => {
    vi.advanceTimersByTime(91_000);
  });
  expect(screen.getByText('startupExtendedWait')).toBeTruthy();
  expect(screen.getByText('01:31')).toBeTruthy();
  view.rerender(<StartupLoading activity={RendererStartupActivity.EngineStatus} />);
  expect(screen.queryByText('startupExtendedWait')).toBeNull();
  expect(screen.getByText('startupRenderer_engineStatus')).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('continues the launch clock after Main hands off to renderer loading', () => {
  vi.useFakeTimers();
  render(
    <StartupStartedAtContext.Provider value={Date.now() - 65_000}>
      <StartupLoading activity={RendererStartupActivity.Interface} />
    </StartupStartedAtContext.Provider>,
  );
  expect(screen.getByText('01:05')).toBeTruthy();
  expect(screen.queryByText('startupLongWait')).toBeNull();
});
