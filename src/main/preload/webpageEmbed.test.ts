import { expect, test, vi } from 'vitest';

import { WebpageEmbedIpc } from '../../shared/browser/webpageEmbed';
import { WebpageEmbedSettingsIpc } from '../../shared/browser/webpageEmbedSettings';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ success: false, code: 'unavailable' })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer: ipc }));

import { createWebpageEmbedApi } from './webpageEmbed';

test('exposes only typed native settings operations on the application bridge', async () => {
  const api = createWebpageEmbedApi();
  await api.getSettings();
  expect(ipc.invoke).toHaveBeenLastCalledWith(WebpageEmbedSettingsIpc.Get);
  const input = { allowExternalEmbedUrls: true, revision: 'viewed' };
  await api.saveSettings(input);
  expect(ipc.invoke).toHaveBeenLastCalledWith(WebpageEmbedSettingsIpc.Save, input);
});

test('forwards Main semantic events without exposing IPC and releases only its own listener', () => {
  const api = createWebpageEmbedApi();
  const receive = vi.fn();
  const otherReceive = vi.fn();
  const unsubscribe = api.onEvent(receive);
  const unsubscribeOther = api.onEvent(otherReceive);
  const [channel, handler] = ipc.on.mock.calls.at(-2)!;
  const [, otherHandler] = ipc.on.mock.calls.at(-1)!;
  const value = { mountId: 'mount', type: 'proxy-ready' };
  expect(channel).toBe(WebpageEmbedIpc.Event);
  handler({ sender: 'private IPC event' }, value);
  expect(receive).toHaveBeenCalledExactlyOnceWith(value);
  unsubscribe();
  unsubscribe();
  expect(ipc.removeListener).toHaveBeenCalledExactlyOnceWith(WebpageEmbedIpc.Event, handler);
  handler({}, value);
  expect(receive).toHaveBeenCalledOnce();
  otherHandler({}, value);
  expect(otherReceive).toHaveBeenCalledExactlyOnceWith(value);
  unsubscribeOther();
  expect(ipc.removeListener).toHaveBeenLastCalledWith(WebpageEmbedIpc.Event, otherHandler);
});
