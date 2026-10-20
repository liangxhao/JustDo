// @vitest-environment jsdom
import { type ExtensionChangedEvent } from '@shared/plugins/extensions';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  getExtensionEnabled,
  useExtensionAvailability,
  useExtensionEnabled,
  useExtensionEnablement,
} from './useExtensionEnablement';

const readiness = vi.hoisted(() => ({
  ready: true,
  listeners: new Set<() => void>(),
}));
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  getEngineReadinessSnapshot: () => ({ ready: readiness.ready }),
  subscribeEngineReadiness: (listener: () => void) => {
    readiness.listeners.add(listener);
    return () => readiness.listeners.delete(listener);
  },
}));

beforeEach(() => {
  readiness.ready = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const list = vi.fn();
  const unsubscribe = vi.fn();
  const callbacks = new Set<(event: ExtensionChangedEvent) => void>();
  const onChanged = vi.fn((callback: (event: ExtensionChangedEvent) => void) => {
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
      unsubscribe();
    };
  });
  vi.stubGlobal('electron', {
    extensions: {
      list,
      onChanged,
    },
  });
  return {
    list,
    onChanged,
    unsubscribe,
    changed: (enabled: boolean, extensionId = OpenClawExtensionId.SWARM_WORKFLOW as string) => {
      for (const callback of callbacks) callback({ extensionId, enabled });
    },
  };
}
const catalog = (enabled: boolean) => ({
  success: true,
  extensions: [{ id: OpenClawExtensionId.SWARM_WORKFLOW, enabled }],
});

test('waits for execution admission and refreshes once for all entrances when the engine recovers', async () => {
  readiness.ready = false;
  const f = fixture();
  f.list.mockResolvedValue(catalog(true));
  const first = renderHook(useExtensionEnablement);
  renderHook(useExtensionEnablement);
  expect(first.result.current.loaded).toBe(false);
  expect(f.list).not.toHaveBeenCalled();
  expect(readiness.listeners.size).toBe(1);

  await act(async () => {
    readiness.ready = true;
    readiness.listeners.forEach(listener => listener());
  });
  expect(first.result.current.loaded).toBe(true);
  expect(f.list).toHaveBeenCalledOnce();

  await act(async () => {
    readiness.ready = false;
    readiness.listeners.forEach(listener => listener());
    window.dispatchEvent(new Event('focus'));
  });
  expect(f.list).toHaveBeenCalledOnce();
  expect(getExtensionEnabled(first.result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true);

  await act(async () => {
    readiness.ready = true;
    readiness.listeners.forEach(listener => listener());
  });
  expect(f.list).toHaveBeenCalledTimes(2);
});

test('ignores a catalog read retired by a new preparation phase', async () => {
  const f = fixture();
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  f.list.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const { result } = renderHook(useExtensionEnablement);
  act(() => {
    readiness.ready = false;
    readiness.listeners.forEach(listener => listener());
  });
  await act(async () => resolve(catalog(true)));
  expect(result.current.loaded).toBe(false);
  f.list.mockResolvedValue(catalog(false));
  await act(async () => {
    readiness.ready = true;
    readiness.listeners.forEach(listener => listener());
  });
  expect(result.current.loaded).toBe(true);
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false);
});

test('retries an unavailable catalog on Native readiness and retains observed enablement during loss', async () => {
  const f = fixture();
  let ready: (() => void) | undefined;
  const release = vi.fn();
  Object.assign(window.electron, {
    appPlugins: {
      onChanged: (listener: () => void) => {
        ready = listener;
        return release;
      },
    },
  });
  f.list
    .mockResolvedValueOnce({ success: false, error: 'Unavailable' })
    .mockResolvedValue(catalog(true));
  const { result, unmount } = renderHook(() => useExtensionEnablement());
  await waitFor(() => expect(f.list).toHaveBeenCalledOnce());
  await act(async () => ready?.());
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true);
  act(() => ready?.());
  expect(f.list).toHaveBeenCalledTimes(2);
  f.list.mockResolvedValueOnce({ success: false, error: 'Disconnected' });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(true);
  f.list.mockResolvedValue(catalog(false));
  await act(async () => ready?.());
  await waitFor(() =>
    expect(getExtensionEnabled(result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(false),
  );
  unmount();
  expect(release).toHaveBeenCalledOnce();
});

test('retains disable revisions across a batched disable and enable for open UI retirement', async () => {
  const f = fixture();
  f.list.mockResolvedValue({
    success: true,
    extensions: [{ id: OpenClawExtensionId.AGENT_TEAM, enabled: true }],
  });
  const { result } = renderHook(() => useExtensionAvailability(OpenClawExtensionId.AGENT_TEAM));
  await waitFor(() => expect(result.current.enabled).toBe(true));
  act(() => {
    f.changed(false, OpenClawExtensionId.AGENT_TEAM);
    f.changed(true, OpenClawExtensionId.AGENT_TEAM);
  });
  expect(result.current).toEqual({ loaded: true, enabled: true, disabledRevision: 1 });
});

test('distinguishes unknown enablement from a confirmed disabled plugin', async () => {
  const f = fixture();
  f.list.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useExtensionAvailability(OpenClawExtensionId.AGENT_TEAM));
  expect(result.current).toMatchObject({ loaded: false, enabled: false });
  act(() => f.changed(false, OpenClawExtensionId.AGENT_TEAM));
  expect(result.current).toMatchObject({ loaded: true, enabled: false });
});

test('shares observed settings with newly mounted views and unsubscribes after the last view', async () => {
  const f = fixture();
  f.list.mockResolvedValue({
    success: true,
    extensions: [{ id: OpenClawExtensionId.AGENT_TEAM, enabled: true }],
  });
  const entrance = renderHook(() => useExtensionAvailability(OpenClawExtensionId.AGENT_TEAM));
  await waitFor(() => expect(entrance.result.current.enabled).toBe(true));
  const panel = renderHook(() => useExtensionAvailability(OpenClawExtensionId.AGENT_TEAM));
  expect(panel.result.current).toMatchObject({ loaded: true, enabled: true });
  expect(f.list).toHaveBeenCalledOnce();
  expect(f.onChanged).toHaveBeenCalledOnce();

  act(() => f.changed(false, OpenClawExtensionId.AGENT_TEAM));
  expect(entrance.result.current.enabled).toBe(false);
  expect(panel.result.current.enabled).toBe(false);
  entrance.unmount();
  expect(f.unsubscribe).not.toHaveBeenCalled();
  act(() => f.changed(true, OpenClawExtensionId.AGENT_TEAM));
  expect(panel.result.current.enabled).toBe(true);
  panel.unmount();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('focus'));
  expect(f.list).toHaveBeenCalledOnce();
});

test('discards settings and late reads after the last subscriber leaves', async () => {
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
  const first = renderHook(useExtensionEnablement);
  act(() => f.changed(true));
  first.unmount();
  const second = renderHook(useExtensionEnablement);
  expect(
    getExtensionEnabled(second.result.current, OpenClawExtensionId.SWARM_WORKFLOW),
  ).toBeUndefined();
  await waitFor(() => expect(second.result.current.loaded).toBe(true));
  await act(async () => resolve(catalog(true)));
  expect(getExtensionEnabled(second.result.current, OpenClawExtensionId.SWARM_WORKFLOW)).toBe(
    false,
  );
});

test('hides feature entrances until enabled and applies disable events immediately', async () => {
  const f = fixture();
  let resolve!: (value: {
    success: boolean;
    extensions: { id: string; enabled: boolean }[];
  }) => void;
  f.list.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const { result } = renderHook(() => useExtensionEnabled(OpenClawExtensionId.AGENT_TEAM));
  expect(result.current).toBe(false);
  act(() => f.changed(true, OpenClawExtensionId.AGENT_TEAM));
  expect(result.current).toBe(true);
  act(() => f.changed(false, OpenClawExtensionId.AGENT_TEAM));
  expect(result.current).toBe(false);
  await act(async () =>
    resolve({ success: true, extensions: [{ id: OpenClawExtensionId.AGENT_TEAM, enabled: true }] }),
  );
  expect(result.current).toBe(false);
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
