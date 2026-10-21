import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';

import { RENDERER_PREFERENCES_KEY } from '../../../shared/app/rendererPreferences';
import { WindowAppearanceIpc } from '../../../shared/app/windowAppearance';
import { readStoredWindowAppearance, registerWindowAppearance } from './windowAppearance';

afterEach(() => vi.restoreAllMocks());

test('reads the configured mode and named palette from Main-owned settings only', () => {
  const get = vi.fn((key: string) =>
    key === 'app_config'
      ? { theme: 'dark', api: { secret: 'not-display-data' } }
      : { 'justdo-theme-id': 'midnight', other: 'not-display-data' },
  );
  expect(readStoredWindowAppearance({ get })).toEqual({ mode: 'dark', themeId: 'midnight' });
  expect(get.mock.calls).toEqual([['app_config'], [RENDERER_PREFERENCES_KEY]]);
});

function fixture() {
  const data = new Map<string, unknown>([['app_config', { theme: 'light' }]]);
  const get = vi.fn((key: string) => data.get(key));
  const store = vi.fn(() => ({ get }));
  const contents = Object.assign(new EventEmitter(), {
    ipc: new EventEmitter(),
    mainFrame: {},
    isDestroyed: () => false,
  });
  registerWindowAppearance(contents as unknown as WebContents, store);
  const read = (sender: unknown = contents, senderFrame: unknown = contents.mainFrame) => {
    const replies: unknown[] = [];
    const event = {
      sender,
      senderFrame,
      set returnValue(value: unknown) {
        replies.push(value);
      },
    };
    contents.ipc.emit(WindowAppearanceIpc.Get, event);
    expect(replies).toHaveLength(1);
    return replies[0];
  };
  return { data, get, store, contents, read };
}

test('reads named preferences after the beforeLoad importer, rather than at window construction', () => {
  const { data, store, read } = fixture();
  expect(store).not.toHaveBeenCalled();
  data.set('app_config', { theme: 'dark' });
  data.set(RENDERER_PREFERENCES_KEY, { 'justdo-theme-id': 'midnight' });
  expect(read()).toEqual({ mode: 'dark', themeId: 'midnight' });
});

test('refreshes the bootstrap after saved appearance changes in the same window', () => {
  const { data, read } = fixture();
  expect(read()).toEqual({ mode: 'light' });
  data.set('app_config', { theme: 'dark' });
  data.set(RENDERER_PREFERENCES_KEY, { 'justdo-theme-id': 'midnight' });
  expect(read()).toEqual({ mode: 'dark', themeId: 'midnight' });
});

test('rejects other senders and subframes without accessing the product Store', () => {
  const { contents, store, read } = fixture();
  expect(read({}, contents.mainFrame)).toEqual({ mode: 'light' });
  expect(read(contents, {})).toEqual({ mode: 'light' });
  expect(read(contents, null)).toEqual({ mode: 'light' });
  expect(store).not.toHaveBeenCalled();
});

test('revokes the window-local bootstrap listener when its WebContents is destroyed', () => {
  const { contents } = fixture();
  expect(contents.ipc.listenerCount(WindowAppearanceIpc.Get)).toBe(1);
  contents.emit('destroyed');
  expect(contents.ipc.listenerCount(WindowAppearanceIpc.Get)).toBe(0);
});

test('does not block the error window when saved settings cannot be read', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(
    readStoredWindowAppearance({
      get: () => {
        throw new Error('database unavailable');
      },
    }),
  ).toEqual({ mode: 'light' });
});
