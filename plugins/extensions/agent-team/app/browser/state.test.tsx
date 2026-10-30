// @vitest-environment jsdom
import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { bindBrowserHost } from './ports';
import { coworkService, setDraftPrompt, store, useSelector } from './state';

vi.unmock('./state');
afterEach(cleanup);

it('subscribes directly to the public metadata port without an application store', () => {
  let snapshot = { cowork: { sessions: [{ id: 'first' }] } };
  const listeners = new Set<() => void>();
  const release = bindBrowserHost({
    signal: new AbortController().signal,
    application: {
      metadata: {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    },
  } as unknown as AppBrowserHost);
  try {
    const hook = renderHook(() => useSelector(state => state.cowork.sessions[0]?.id));
    expect(hook.result.current).toBe('first');
    act(() => {
      snapshot = { cowork: { sessions: [{ id: 'second' }] } };
      listeners.forEach(listener => listener());
    });
    expect(hook.result.current).toBe('second');
    expect(store.getState()).toBe(snapshot);
    hook.unmount();
    expect(listeners.size).toBe(0);
  } finally { release(); }
});

it('forwards draft effects and session reads to the live host ports', async () => {
  const setPrompt = vi.fn();
  const loadSession = vi.fn().mockResolvedValue(true);
  const release = bindBrowserHost({
    signal: new AbortController().signal,
    application: { drafts: { setPrompt }, sessions: { loadSession } },
  } as unknown as AppBrowserHost);
  try {
    const input = { draftKey: 'source', draft: 'Keep my latest prompt' };
    store.dispatch(setDraftPrompt(input));
    expect(setPrompt).toHaveBeenCalledExactlyOnceWith(input);
    await expect(coworkService.loadSession('source')).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledExactlyOnceWith('source');
  } finally { release(); }
  expect(() => store.getState()).toThrow('appPluginUnavailable');
});
