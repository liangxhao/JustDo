// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import AppServerWebSocketConnectionCard from './AppServerWebSocketConnectionCard';

const language = vi.hoisted(() => ({ current: 'en' as 'zh' | 'en' }));
vi.mock('@/services/i18n', async () => {
  const { translations: dictionary } = await import('@/services/i18n/translations');
  return { i18nService: { t: (key: string) => dictionary[language.current][key] ?? key } };
});

const text = () => translations[language.current];
const url = 'ws://127.0.0.1:34567/app-server';
const config = { url, headers: { Authorization: 'Bearer private-copy-only' } };
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  language.current = 'en';
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

function fixture() {
  const getStatus = vi.fn(async () => ({ running: true, url }));
  const getConnectionConfig = vi.fn(async () => config);
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { appServer: { getStatus, getConnectionConfig } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, getConnectionConfig, writeText };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const click = async (name: string) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
};
const mount = async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<AppServerWebSocketConnectionCard />); });
  return view;
};

test.each(['zh', 'en'] as const)('shows %s status without fetching or rendering credentials, then copies fresh config', async locale => {
  language.current = locale;
  const api = fixture();
  await mount();
  expect(screen.getByRole('region', { name: text().appServerWebSocketTitle })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(text().appServerWebSocketReady);
  expect(screen.getByText(url)).toBeTruthy();
  expect(screen.getByText(text().appServerWebSocketAuthHint)).toBeTruthy();
  expect(screen.queryByText(/Chrome/)).toBeNull();
  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('private-copy-only');
  expect(screen.queryByRole('switch')).toBeNull();

  await click(text().appServerWebSocketCopyConfig);
  expect(api.getConnectionConfig).toHaveBeenCalledOnce();
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual(config);
  expect(screen.getByRole('button', { name: text().appServerWebSocketCopied })).toBeTruthy();
  expect(document.body.textContent).not.toContain('private-copy-only');
});

test.each(['not running', 'status failure'])('disables copying for %s without requesting credentials', async kind => {
  const api = fixture();
  if (kind === 'not running') api.getStatus.mockResolvedValueOnce({ running: false, url: '' });
  else api.getStatus.mockRejectedValueOnce(new Error('Sensitive backend details'));
  await mount();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketCopyConfig }).disabled).toBe(true);
  await click(text().appServerWebSocketCopyConfig);
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(api.writeText).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Sensitive backend details');
});

test.each(['refresh', 'unmount', 'new copy'])('does not copy stale credentials after %s', async kind => {
  const api = fixture();
  const pending = deferred<typeof config>();
  api.getConnectionConfig.mockReturnValueOnce(pending.promise);
  const view = await mount();
  await click(text().appServerWebSocketCopyConfig);
  if (kind === 'refresh') await click(text().appServerWebSocketRefresh);
  else if (kind === 'unmount') view.unmount();
  else await click(text().appServerWebSocketCopyConfig);
  await act(async () => { pending.resolve({ ...config, headers: { Authorization: 'Bearer obsolete' } }); });
  expect(api.writeText).toHaveBeenCalledTimes(kind === 'new copy' ? 1 : 0);
  expect(api.writeText.mock.calls.some(([value]) => value.includes('obsolete'))).toBe(false);
  expect(document.body.textContent).not.toContain('obsolete');
});

test('disables credential copying while status is being refreshed', async () => {
  const api = fixture();
  const pending = deferred<{ running: boolean; url: string }>();
  api.getStatus.mockReturnValueOnce(pending.promise);
  render(<AppServerWebSocketConnectionCard />);
  await act(async () => { pending.resolve({ running: true, url }); });
  const refresh = deferred<{ running: boolean; url: string }>();
  api.getStatus.mockReturnValueOnce(refresh.promise);
  await click(text().appServerWebSocketRefresh);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketCopyConfig }).disabled).toBe(true);
  await act(async () => { refresh.resolve({ running: false, url: '' }); });
  expect(screen.getByRole('status').textContent).toBe(text().appServerWebSocketNotReady);
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
});

test.each(['credentials', 'clipboard'])('reports a safe copy error for %s failure and allows retry', async kind => {
  const api = fixture();
  const failure = new Error('Bearer private-copy-only');
  if (kind === 'credentials') api.getConnectionConfig.mockRejectedValueOnce(failure);
  else api.writeText.mockRejectedValueOnce(failure);
  await mount();
  await click(text().appServerWebSocketCopyConfig);
  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketCopyFailed);
  expect(document.body.textContent).not.toContain('private-copy-only');
  await click(text().appServerWebSocketCopyConfig);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual(config);
});

test('clears copy feedback on refresh and unmount', async () => {
  fixture();
  const view = await mount();
  vi.useFakeTimers();
  await click(text().appServerWebSocketCopyConfig);
  expect(vi.getTimerCount()).toBe(1);
  await click(text().appServerWebSocketRefresh);
  expect(vi.getTimerCount()).toBe(0);
  await click(text().appServerWebSocketCopyConfig);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['resolve', 'reject'] as const)('ignores clipboard %s after a newer status failure', async settlement => {
  const api = fixture();
  const pending = deferred<void>();
  api.writeText.mockReturnValueOnce(pending.promise);
  await mount();
  vi.useFakeTimers();
  await click(text().appServerWebSocketCopyConfig);
  api.getStatus.mockRejectedValueOnce(new Error('Status failed'));

  await click(text().appServerWebSocketRefresh);
  await act(async () => {
    if (settlement === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Bearer obsolete'));
  });

  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketStatusFailed);
  expect(screen.getByRole('status').textContent).toBe(text().appServerWebSocketNotReady);
  expect(vi.getTimerCount()).toBe(0);
  expect(document.body.textContent).not.toContain('obsolete');
  expect(api.getConnectionConfig).toHaveBeenCalledOnce();
});
