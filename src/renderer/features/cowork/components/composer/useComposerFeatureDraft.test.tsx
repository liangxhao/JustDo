// @vitest-environment jsdom
import type { ExtensionChangedEvent } from '@shared/openclaw/extensions';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useExtensionEnablement } from '@/features/plugins/extensions/useExtensionEnablement';

import { useComposerFeatureDraft } from './useComposerFeatureDraft';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  let changed!: (event: ExtensionChangedEvent) => void;
  const list = vi.fn().mockResolvedValue({
    success: true,
    extensions: [
      { id: 'first-plugin', enabled: true },
      { id: 'second-plugin', enabled: true },
    ],
  });
  vi.stubGlobal('electron', {
    extensions: {
      list,
      onChanged: (callback: typeof changed) => {
        changed = callback;
        return vi.fn();
      },
    },
  });
  return {
    list,
    toggle: (extensionId: string, enabled: boolean) => changed({ extensionId, enabled }),
  };
}

function setup() {
  const f = fixture();
  const view = renderHook(
    ({ key, plugin }) => {
      const settings = useExtensionEnablement();
      const first = useComposerFeatureDraft<{ task: string }>(key, plugin, settings);
      const second = useComposerFeatureDraft<{ task: string }>(key, 'second-plugin', settings);
      return { first, second, loaded: settings.loaded };
    },
    { initialProps: { key: 'chat-1', plugin: 'first-plugin' } },
  );
  return { ...f, ...view };
}

test('does not select an unconfirmed plugin, then stores options separately for each chat', async () => {
  const f = setup();
  act(() => f.result.current.first.setValue({ task: 'Too early' }));
  expect(f.result.current.first.value).toBeUndefined();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  const first = { task: 'First' };
  act(() => f.result.current.first.setValue(first));
  f.rerender({ key: 'chat-2', plugin: 'first-plugin' });
  expect(f.result.current.first.value).toBeUndefined();
  act(() => f.result.current.first.setValue({ task: 'Second' }));
  f.rerender({ key: 'chat-1', plugin: 'first-plugin' });
  expect(f.result.current.first.value).toBe(first);
});

test('a disable and enable in one React batch cancel selections in every chat', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  act(() => f.result.current.first.setValue({ task: 'First' }));
  f.rerender({ key: 'chat-2', plugin: 'first-plugin' });
  act(() => f.result.current.first.setValue({ task: 'Second' }));
  act(() => {
    f.toggle('first-plugin', false);
    f.toggle('first-plugin', true);
  });
  expect(f.result.current.first.value).toBeUndefined();
  f.rerender({ key: 'chat-1', plugin: 'first-plugin' });
  expect(f.result.current.first.value).toBeUndefined();
  act(() => f.result.current.first.setValue({ task: 'New choice' }));
  expect(f.result.current.first.value?.task).toBe('New choice');
});

test('disabling one plugin preserves another plugin selection and shares its catalog read', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  const other = { task: 'Other' };
  act(() => {
    f.result.current.first.setValue({ task: 'First' });
    f.result.current.second.setValue(other);
  });
  act(() => f.toggle('first-plugin', false));
  expect(f.result.current.first.value).toBeUndefined();
  expect(f.result.current.second.value).toBe(other);
  expect(f.list).toHaveBeenCalledOnce();
});

test('cancelling or replacing a selection invalidates an asynchronous submission and preserves the replacement', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  const submitted = { task: 'Submitted' };
  act(() => f.result.current.first.setValue(submitted));
  const check = f.result.current.first.isCurrent;
  expect(check('chat-1', submitted)).toBe(true);
  act(() => f.result.current.first.setValue(undefined));
  expect(check('chat-1', submitted)).toBe(false);
  const replacement = { task: 'Replacement' };
  act(() => f.result.current.first.setValue(replacement));
  act(() => f.result.current.first.clearAccepted('chat-1', submitted));
  expect(f.result.current.first.value).toBe(replacement);
  expect(check('chat-1', submitted)).toBe(false);
});

test('a chat switch invalidates submission and accepted cleanup applies only to its original draft', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  const submitted = { task: 'First' };
  act(() => f.result.current.first.setValue(submitted));
  const check = f.result.current.first.isCurrent;
  f.rerender({ key: 'chat-2', plugin: 'first-plugin' });
  expect(check('chat-1', submitted)).toBe(false);
  const other = { task: 'Second' };
  act(() => f.result.current.first.setValue(other));
  act(() => f.result.current.first.clearAccepted('chat-1', submitted));
  expect(f.result.current.first.value).toBe(other);
  f.rerender({ key: 'chat-1', plugin: 'first-plugin' });
  expect(f.result.current.first.value).toBeUndefined();
});

test('catalog removal cancels the selection and later reinstallation does not restore it', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  act(() => f.result.current.first.setValue({ task: 'First' }));
  f.list.mockResolvedValueOnce({ success: true, extensions: [] });
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(f.result.current.first.value).toBeUndefined());
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(3));
  expect(f.result.current.first.value).toBeUndefined();
});

test('changing the bound plugin cannot reuse another plugin options', async () => {
  const f = setup();
  await waitFor(() => expect(f.result.current.loaded).toBe(true));
  act(() => f.result.current.first.setValue({ task: 'First' }));
  f.rerender({ key: 'chat-1', plugin: 'second-plugin' });
  expect(f.result.current.first.value).toBeUndefined();
});
