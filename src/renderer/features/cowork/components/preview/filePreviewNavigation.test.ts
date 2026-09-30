import { describe, expect, test, vi } from 'vitest';

import {
  isCurrentFilePreviewRequest,
  runGuardedFilePreviewNavigation,
} from './filePreviewNavigation';

describe('runGuardedFilePreviewNavigation', () => {
  test('does not navigate when the user cancels the pending file transition', async () => {
    const navigate = vi.fn();

    const result = await runGuardedFilePreviewNavigation(async () => false, navigate);

    expect(result).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('waits for the transition before navigating', async () => {
    const order: string[] = [];

    const result = await runGuardedFilePreviewNavigation(
      async () => {
        order.push('transition');
        return true;
      },
      () => {
        order.push('navigate');
      },
    );

    expect(result).toBe(true);
    expect(order).toEqual(['transition', 'navigate']);
  });

  test('passes tab-preservation options to the transition guard', async () => {
    const requestTransition = vi.fn().mockResolvedValue(true);
    const navigate = vi.fn();

    await runGuardedFilePreviewNavigation(requestTransition, navigate, { preserveTabs: true });

    expect(requestTransition).toHaveBeenCalledWith({ preserveTabs: true });
    expect(navigate).toHaveBeenCalledOnce();
  });

  test('does not change assistant or project when a dirty-file transition is cancelled', async () => {
    const prepare = vi.fn().mockResolvedValue(true);
    const navigate = vi.fn();
    expect(
      await runGuardedFilePreviewNavigation(
        async () => false,
        navigate,
        { preserveTabs: true },
        prepare,
      ),
    ).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('prepares the new conversation only after approval and before navigating', async () => {
    const steps: string[] = [];
    expect(
      await runGuardedFilePreviewNavigation(
        async () => {
          steps.push('guard');
          return true;
        },
        () => {
          steps.push('navigate');
        },
        { preserveTabs: true },
        async () => {
          steps.push('prepare');
          return true;
        },
      ),
    ).toBe(true);
    expect(steps).toEqual(['guard', 'prepare', 'navigate']);
  });

  test('keeps the current conversation when preparation becomes stale or fails', async () => {
    const navigate = vi.fn();
    expect(
      await runGuardedFilePreviewNavigation(
        async () => true,
        navigate,
        undefined,
        async () => false,
      ),
    ).toBe(false);
    await expect(
      runGuardedFilePreviewNavigation(
        async () => true,
        navigate,
        undefined,
        async () => {
          throw new Error('failed');
        },
      ),
    ).rejects.toThrow('failed');
    expect(navigate).not.toHaveBeenCalled();
  });

  test('accepts only the latest request from the active session', () => {
    expect(isCurrentFilePreviewRequest(3, 3, 'session-a', 'session-a')).toBe(true);
    expect(isCurrentFilePreviewRequest(2, 3, 'session-a', 'session-a')).toBe(false);
    expect(isCurrentFilePreviewRequest(3, 3, 'session-a', 'session-b')).toBe(false);
  });
});
