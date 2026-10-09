// @vitest-environment jsdom
import { type ExtensionChangedEvent, OpenClawExtensionId } from '@shared/openclaw/extensions';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { getExtensionEnabled, useExtensionEnablement } from './useExtensionEnablement';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const list = vi.fn();
  const unsubscribe = vi.fn();
  let changed!: (event: ExtensionChangedEvent) => void;
  vi.stubGlobal('electron', {
    extensions: {
      list,
      onChanged: (callback: typeof changed) => {
        changed = callback;
        return unsubscribe;
      },
    },
  });
  return {
    list,
    unsubscribe,
    changed: (enabled: boolean, extensionId = OpenClawExtensionId.SWARM_WORKFLOW as string) =>
      changed({ extensionId, enabled }),
  };
}
const catalog = (enabled: boolean) => ({
  success: true,
  extensions: [{ id: OpenClawExtensionId.SWARM_WORKFLOW, enabled }],
});

test.each([true, false, undefined])(
  'uses the native enabled setting %s and treats a missing plugin as disabled',
  async enabled => {
    const f = fixture();
    f.list.mockResolvedValue(
      enabled === undefined ? { success: true, extensions: [] } : catalog(enabled),
    );
    const { result } = renderHook(useExtensionEnablement);
    expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBeUndefined();
    await waitFor(() =>
      expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(
        enabled === true,
      ),
    );
  },
);

test('tracks multiple plugins with one catalog read and independent toggle states', async () => {
  const f = fixture();
  f.list.mockResolvedValue(catalog(true));
  const { result } = renderHook(useExtensionEnablement);
  const swarm = () => getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW);
  const other = () => getExtensionEnabled(result.current, 'another-plugin');
  await waitFor(() => expect(swarm()).toBe(true));
  expect(other()).toBe(false);
  act(() => f.changed(true, 'another-plugin'));
  expect(other()).toBe(true);
  expect(swarm()).toBe(true);
  act(() => f.changed(false));
  expect(swarm()).toBe(false);
  expect(other()).toBe(true);
  act(() => f.changed(true));
  expect(swarm()).toBe(true);
  expect(f.list).toHaveBeenCalledOnce();
});

test('does not let a catalog response restore a plugin disabled during the request', async () => {
  const f = fixture();
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  f.list.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const { result } = renderHook(useExtensionEnablement);
  act(() => f.changed(false));
  expect(getExtensionEnabled(result.current, 'another-plugin')).toBeUndefined();
  act(() => f.changed(true, 'another-plugin'));
  await act(async () => resolve(catalog(true)));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false);
  expect(getExtensionEnabled(result.current, 'another-plugin')).toBe(true);
  expect(result.current.loaded).toBe(true);
});

test('refreshes the setting when the window regains focus and releases its listeners on unmount', async () => {
  const f = fixture();
  f.list.mockResolvedValueOnce(catalog(true)).mockResolvedValueOnce(catalog(false));
  const { result, unmount } = renderHook(useExtensionEnablement);
  await waitFor(() =>
    expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true),
  );
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() =>
    expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false),
  );
  unmount();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('focus'));
  f.changed(true);
  expect(f.list).toHaveBeenCalledTimes(2);
});

test('keeps an observed disabled setting when the catalog is temporarily unavailable', async () => {
  const f = fixture();
  f.list.mockResolvedValueOnce(catalog(true)).mockRejectedValueOnce(new Error('unavailable'));
  const { result } = renderHook(useExtensionEnablement);
  await waitFor(() =>
    expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true),
  );
  act(() => f.changed(false));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false);
});

test('a toggle of one plugin does not discard the catalog state of another plugin', async () => {
  const f = fixture();
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  f.list.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const { result } = renderHook(useExtensionEnablement);
  act(() => f.changed(true, 'another-plugin'));
  await act(async () => resolve(catalog(true)));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true);
  expect(getExtensionEnabled(result.current, 'another-plugin')).toBe(true);
});

test('an older focus refresh cannot override a newer catalog response', async () => {
  const f = fixture();
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  f.list
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(catalog(false));
  const { result } = renderHook(useExtensionEnablement);
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  await act(async () => resolve(catalog(true)));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false);
});
