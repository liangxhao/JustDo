/** @vitest-environment jsdom */
import { AutomaticErrorRetryPhase as Phase, type AutomaticErrorRetryPresentation } from '@shared/cowork/automaticErrorRetry';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { useAutomaticErrorRetryActivity } from './useAutomaticErrorRetryActivity';

test('keeps technical preparation busy, ignores stale reads and retires session ownership', async () => {
  const original = window.electron;
  let publish!: (value: AutomaticErrorRetryPresentation) => void;
  let resolve!: (value: unknown) => void;
  const remove = vi.fn();
  Object.defineProperty(window, 'electron', { configurable: true, value: { cowork: {
    getAutomaticErrorRetry: vi.fn(() => new Promise(value => { resolve = value; })),
    onAutomaticErrorRetryChanged: (callback: typeof publish) => { publish = callback; return remove; },
  } } });
  const snapshot = (phase: AutomaticErrorRetryPresentation['phase'], revision: number) => ({
    sessionId: 'session', chainId: 'chain', revision, phase, attempt: 1, maxContinuations: 2, runs: [],
  });
  try {
    const hook = renderHook(({ sessionId }) => useAutomaticErrorRetryActivity(sessionId), {
      initialProps: { sessionId: 'session' },
    });
    expect(hook.result.current).toBe(false);
    act(() => publish(snapshot(Phase.Preparing, 3)));
    expect(hook.result.current).toBe(true);
    await act(async () => resolve({ success: true, presentation: snapshot(Phase.Completed, 1) }));
    expect(hook.result.current).toBe(true);
    act(() => publish(snapshot(Phase.Unknown, 4)));
    expect(hook.result.current).toBe(false);
    act(() => publish(snapshot(Phase.Running, 5)));
    hook.rerender({ sessionId: 'other' });
    expect(hook.result.current).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    hook.unmount();
  } finally {
    Object.defineProperty(window, 'electron', { configurable: true, value: original });
  }
});
