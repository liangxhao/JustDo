// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useWorkboardAvailability } from './useWorkboardAvailability';

afterEach(() => vi.unstubAllGlobals());

test('does not let an older catalog request undo disabling Workboard', async () => {
  let resolveList!: (value: unknown) => void;
  let onChanged!: (event: { extensionId: string; enabled: boolean }) => void;
  vi.stubGlobal('electron', {
    extensions: {
      list: vi.fn(
        () =>
          new Promise(resolve => {
            resolveList = resolve;
          }),
      ),
      onChanged: (callback: typeof onChanged) => {
        onChanged = callback;
        return vi.fn();
      },
    },
    workboard: { onChanged: () => vi.fn() },
  });
  const { result, unmount } = renderHook(() => useWorkboardAvailability(true));
  act(() => onChanged({ extensionId: 'workboard', enabled: false }));
  await act(async () =>
    resolveList({ success: true, extensions: [{ id: 'workboard', enabled: true }] }),
  );
  expect(result.current).toBe(false);
  unmount();
});

test('hides Workboard when a successful refreshed catalog no longer contains it', async () => {
  let refresh!: () => void;
  const list = vi
    .fn()
    .mockResolvedValueOnce({ success: true, extensions: [{ id: 'workboard', enabled: true }] })
    .mockResolvedValueOnce({ success: true, extensions: [] });
  vi.stubGlobal('electron', {
    extensions: { list, onChanged: () => vi.fn() },
    workboard: {
      onChanged: (callback: () => void) => {
        refresh = callback;
        return vi.fn();
      },
    },
  });
  const { result, unmount } = renderHook(() => useWorkboardAvailability(true));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => refresh());
  await waitFor(() => expect(result.current).toBe(false));
  unmount();
});
