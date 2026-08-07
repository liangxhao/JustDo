import { describe, expect, it, vi } from 'vitest';

import { runGoalActionSingleFlight } from './goalActionSingleFlight';

describe('runGoalActionSingleFlight', () => {
  it('rejects a second action while the first action is pending', async () => {
    const pendingRef = { current: false };
    const setPending = vi.fn();
    let releaseFirstAction: (() => void) | undefined;
    const firstAction = vi.fn(
      () => new Promise<void>(resolve => {
        releaseFirstAction = resolve;
      }),
    );
    const secondAction = vi.fn();

    const firstRun = runGoalActionSingleFlight(pendingRef, setPending, firstAction);
    const secondRun = runGoalActionSingleFlight(pendingRef, setPending, secondAction);

    expect(await secondRun).toBe(false);
    expect(secondAction).not.toHaveBeenCalled();
    releaseFirstAction?.();
    expect(await firstRun).toBe(true);
    expect(setPending).toHaveBeenNthCalledWith(1, true);
    expect(setPending).toHaveBeenLastCalledWith(false);
  });

  it('releases the guard when an action fails', async () => {
    const pendingRef = { current: false };
    const setPending = vi.fn();

    await expect(
      runGoalActionSingleFlight(pendingRef, setPending, async () => {
        throw new Error('submit failed');
      }),
    ).rejects.toThrow('submit failed');

    expect(pendingRef.current).toBe(false);
    expect(setPending).toHaveBeenLastCalledWith(false);
  });
});
