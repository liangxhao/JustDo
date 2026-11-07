import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

import { waitForBrowserGuestReady } from './browserAgentReadiness';

function fixture() {
  const events = new EventEmitter();
  const state = { url: 'about:blank', loading: false, destroyed: false };
  const loadURL = vi.fn();
  const guest = Object.assign(events, {
    getURL: () => state.url,
    isLoadingMainFrame: () => state.loading,
    isDestroyed: () => state.destroyed,
    loadURL,
  }) as unknown as Electron.WebContents;
  const assertReleased = () => {
    expect(events.listenerCount('did-stop-loading')).toBe(0);
    expect(events.listenerCount('destroyed')).toBe(0);
    expect(loadURL).not.toHaveBeenCalled();
  };
  return { events, guest, state, loadURL, assertReleased };
}

test('accepts an already loaded document without listeners or another navigation', async () => {
  const f = fixture();

  await expect(waitForBrowserGuestReady(f.guest)).resolves.toBeUndefined();

  f.assertReleased();
});

test('waits for the first document even when an empty guest is not yet loading', async () => {
  const f = fixture();
  f.state.url = '';
  const completed = vi.fn();

  const pending = waitForBrowserGuestReady(f.guest).then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(f.events.listenerCount('did-stop-loading')).toBe(1);

  f.state.url = 'about:blank';
  f.events.emit('did-stop-loading');
  await pending;

  expect(completed).toHaveBeenCalledExactlyOnceWith(undefined);
  f.assertReleased();
});

test('ignores an initial did-finish-load until the bootstrap document stops loading', async () => {
  const f = fixture();
  f.state.loading = true;
  const controller = new AbortController();
  const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
  const completed = vi.fn();

  const pending = waitForBrowserGuestReady(f.guest, controller.signal).then(completed);
  f.events.emit('did-finish-load');
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(f.loadURL).not.toHaveBeenCalled();

  f.state.loading = false;
  f.events.emit('did-stop-loading');
  await pending;

  expect(completed).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  f.assertReleased();
});

test('rejects an already aborted request without waiting or navigating', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('Run authorization withdrawn');
  controller.abort(reason);

  await expect(waitForBrowserGuestReady(f.guest, controller.signal)).rejects.toBe(reason);

  f.assertReleased();
});

test('cancels a pending bootstrap wait and ignores later loading events', async () => {
  const f = fixture();
  f.state.loading = true;
  const controller = new AbortController();
  const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
  const pending = waitForBrowserGuestReady(f.guest, controller.signal);
  const result = expect(pending).rejects.toThrow('Browser request was cancelled.');

  controller.abort();
  await result;
  f.state.loading = false;
  f.events.emit('did-stop-loading');

  expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  f.assertReleased();
});

test('rejects an already destroyed guest without subscribing or navigating', async () => {
  const f = fixture();
  f.state.destroyed = true;

  await expect(waitForBrowserGuestReady(f.guest)).rejects.toThrow(
    'The browser page is no longer available.',
  );

  f.assertReleased();
});

test('rejects destruction during bootstrap and releases event and abort listeners', async () => {
  const f = fixture();
  f.state.loading = true;
  const controller = new AbortController();
  const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
  const pending = waitForBrowserGuestReady(f.guest, controller.signal);
  const result = expect(pending).rejects.toThrow('The browser page is no longer available.');

  f.state.destroyed = true;
  f.events.emit('destroyed');
  await result;
  controller.abort();
  f.events.emit('did-stop-loading');

  expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
  f.assertReleased();
});

test('rejects a stopped guest with no document rather than starting a replacement navigation', async () => {
  const f = fixture();
  f.state.url = '';
  const pending = waitForBrowserGuestReady(f.guest);
  const result = expect(pending).rejects.toThrow('The browser page is no longer available.');

  f.events.emit('did-stop-loading');
  await result;

  f.assertReleased();
});
