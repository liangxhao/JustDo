// @vitest-environment jsdom

import {
  AppServerIntegrationFailure,
  type AppServerIntegrationStatus,
} from '@shared/integrations/appServerIntegration';
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
const status: AppServerIntegrationStatus = {
  running: true, url, configuredPort: 0, restartRequired: false,
};
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
  const getStatus = vi.fn(async (): Promise<AppServerIntegrationStatus> => status);
  const getConnectionConfig = vi.fn(async () => config);
  const setPort = vi.fn(async (port: number): Promise<AppServerIntegrationStatus> => ({
    ...status, configuredPort: port, restartRequired: true,
  }));
  const regenerateToken = vi.fn(async (): Promise<AppServerIntegrationStatus> => ({
    ...status, restartRequired: true,
  }));
  const writeText = vi.fn(async (_value: string): Promise<void> => {});
  vi.stubGlobal('electron', { appServer: { getStatus, getConnectionConfig, setPort, regenerateToken } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return { getStatus, getConnectionConfig, setPort, regenerateToken, writeText };
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
const settingsToggle = () => screen.getByRole<HTMLButtonElement>('button', {
  name: new RegExp(`^${text().appServerWebSocketSettings}`),
});
const toggleSettings = async () => {
  await act(async () => { fireEvent.click(settingsToggle()); });
};
const openSettings = async () => {
  if (settingsToggle().getAttribute('aria-expanded') === 'false') await toggleSettings();
};
const chooseFixedPort = async () => {
  await openSettings();
  await click(text().appServerWebSocketFixed);
};
const portField = () => screen.getByRole<HTMLInputElement>('spinbutton', { name: text().appServerWebSocketPort });

test.each(['zh', 'en'] as const)('shows %s status without fetching or rendering credentials, then copies fresh config', async locale => {
  language.current = locale;
  const api = fixture();
  await mount();
  expect(screen.getByRole('region', { name: text().appServerWebSocketTitle })).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(text().appServerWebSocketReady);
  expect(screen.getByText(url)).toBeTruthy();
  expect(screen.queryByText(/Chrome/)).toBeNull();
  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('private-copy-only');
  expect(screen.queryByRole('switch')).toBeNull();
  expect(settingsToggle().getAttribute('aria-expanded')).toBe('false');
  const settings = document.getElementById(settingsToggle().getAttribute('aria-controls')!)!;
  expect(settings.hidden).toBe(true);
  expect(screen.queryByRole('button', { name: text().appServerWebSocketFixed })).toBeNull();
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('button', { name: text().appServerWebSocketSavePort })).toBeNull();

  await openSettings();
  expect(settingsToggle().getAttribute('aria-expanded')).toBe('true');
  expect(settings.hidden).toBe(false);
  expect(screen.getByRole('button', { name: text().appServerWebSocketAutomatic }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText(text().appServerWebSocketTokenStored)).toBeTruthy();
  expect(api.getStatus).toHaveBeenCalledOnce();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  await toggleSettings();

  await click(text().appServerWebSocketCopyConfig);
  expect(api.getConnectionConfig).toHaveBeenCalledOnce();
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual(config);
  expect(screen.getByRole('button', { name: text().appServerWebSocketCopied })).toBeTruthy();
  expect(document.body.textContent).not.toContain('private-copy-only');
});

test.each(['not running', 'status failure'])('disables copying for %s without requesting credentials', async kind => {
  const api = fixture();
  if (kind === 'not running') api.getStatus.mockResolvedValueOnce({ ...status, running: false, url: '' });
  else api.getStatus.mockRejectedValueOnce(new Error('Sensitive backend details'));
  await mount();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketCopyConfig }).disabled).toBe(true);
  await click(text().appServerWebSocketCopyConfig);
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(api.writeText).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Sensitive backend details');
  if (kind === 'status failure') {
    expect(screen.queryByText(text().appServerWebSocketTokenStored)).toBeNull();
    await openSettings();
    expect(screen.queryByText(text().appServerWebSocketTokenStored)).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketAutomatic }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketRegenerateToken }).disabled).toBe(true);
  }
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
  const pending = deferred<AppServerIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(pending.promise);
  render(<AppServerWebSocketConnectionCard />);
  await act(async () => { pending.resolve(status); });
  const refresh = deferred<AppServerIntegrationStatus>();
  api.getStatus.mockReturnValueOnce(refresh.promise);
  await click(text().appServerWebSocketRefresh);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketCopyConfig }).disabled).toBe(true);
  await act(async () => { refresh.resolve({ ...status, running: false, url: '' }); });
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

const changePort = (value: string) => {
  fireEvent.change(portField(), { target: { value } });
};

test.each(['zh', 'en'] as const)('saves a fixed port in %s without changing the current copied configuration', async locale => {
  language.current = locale;
  const api = fixture();
  await mount();
  await chooseFixedPort();
  expect(portField().value).toBe('34567');
  changePort('13042');

  await click(text().appServerWebSocketSavePort);

  expect(api.setPort).toHaveBeenCalledExactlyOnceWith(13042);
  expect(screen.queryByText(text().appServerWebSocketSettingsSaved)).toBeNull();
  expect(screen.queryByRole('button', { name: text().appServerWebSocketSavePort })).toBeNull();
  expect(screen.queryByRole('button', { name: text().appServerWebSocketCancel })).toBeNull();
  await toggleSettings();
  expect(screen.getByText(text().appServerWebSocketRestartRequired).closest('[hidden]')).toBeNull();
  expect(screen.getByText(url)).toBeTruthy();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(api.regenerateToken).not.toHaveBeenCalled();
  await click(text().appServerWebSocketCopyConfig);
  expect(JSON.parse(api.writeText.mock.lastCall![0])).toEqual(config);
});

test('delays fixed-port validation until blur or save and maps automatic mode to zero', async () => {
  const api = fixture();
  api.getStatus.mockResolvedValueOnce({ ...status, configuredPort: 13042 });
  await mount();
  await openSettings();
  expect(portField().value).toBe('13042');
  expect(screen.queryByRole('button', { name: text().appServerWebSocketSavePort })).toBeNull();
  for (const value of ['', '0', '65536', '12.5']) {
    changePort(value);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(portField());
    expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketPortInvalid);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketSavePort }).disabled).toBe(false);
  }
  changePort('');
  await click(text().appServerWebSocketSavePort);
  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketPortInvalid);
  expect(document.activeElement).toBe(portField());
  expect(portField().getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  expect(api.setPort).not.toHaveBeenCalled();

  await click(text().appServerWebSocketAutomatic);
  expect(screen.queryByRole('spinbutton')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await click(text().appServerWebSocketSavePort);

  expect(api.setPort).toHaveBeenCalledExactlyOnceWith(0);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('leaves a new fixed port empty without a current address and validates it only on demand', async () => {
  const api = fixture();
  api.getStatus.mockResolvedValueOnce({ ...status, running: false, url: '' });
  await mount();
  await chooseFixedPort();
  expect(portField().value).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
  await click(text().appServerWebSocketSavePort);
  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketPortInvalid);
  expect(api.setPort).not.toHaveBeenCalled();
});

test('cancel restores the latest saved mode and port and clears validation', async () => {
  const api = fixture();
  await mount();
  await chooseFixedPort();
  changePort('13042');
  api.getStatus.mockResolvedValueOnce({ ...status, configuredPort: 14000, restartRequired: true });
  await click(text().appServerWebSocketRefresh);
  expect(portField().value).toBe('13042');
  changePort('');
  fireEvent.blur(portField());
  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketPortInvalid);

  await click(text().appServerWebSocketCancel);

  expect(portField().value).toBe('14000');
  expect(screen.getByRole('button', { name: text().appServerWebSocketFixed }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: text().appServerWebSocketSavePort })).toBeNull();
  expect(screen.queryByRole('button', { name: text().appServerWebSocketCancel })).toBeNull();
  expect(api.setPort).not.toHaveBeenCalled();
  expect(api.regenerateToken).not.toHaveBeenCalled();
});

test('retains an invalid fixed zero draft across refresh instead of reverting to automatic mode', async () => {
  const api = fixture();
  await mount();
  await chooseFixedPort();
  changePort('0');
  fireEvent.blur(portField());

  await click(text().appServerWebSocketRefresh);

  expect(portField().value).toBe('0');
  expect(screen.getByRole('button', { name: text().appServerWebSocketFixed }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('alert').textContent).toBe(text().appServerWebSocketPortInvalid);
  expect(api.setPort).not.toHaveBeenCalled();
});

test('uses neutral token status when reopened with pending settings but no local rotation receipt', async () => {
  const api = fixture();
  api.getStatus.mockResolvedValueOnce({ ...status, restartRequired: true });
  await mount();
  expect(screen.getByText(text().appServerWebSocketRestartRequired).closest('[hidden]')).toBeNull();

  await openSettings();

  expect(screen.getByText(text().appServerWebSocketTokenStoredPending)).toBeTruthy();
  expect(screen.queryByText(text().appServerWebSocketTokenStored)).toBeNull();
  expect(screen.queryByText(text().appServerWebSocketTokenPending)).toBeNull();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(api.regenerateToken).not.toHaveBeenCalled();
});

test.each(['port', 'token'] as const)('keeps unsaved port input and hides backend details when saving %s fails', async kind => {
  const api = fixture();
  const failure = new Error('Bearer secret-backend-detail');
  if (kind === 'port') api.setPort.mockRejectedValueOnce(failure);
  else api.regenerateToken.mockRejectedValueOnce(failure);
  await mount();
  await chooseFixedPort();
  changePort('13042');

  await click(kind === 'port' ? text().appServerWebSocketSavePort : text().appServerWebSocketRegenerateToken);

  expect(screen.getByRole('alert').textContent).toBe(kind === 'port'
    ? text().appServerWebSocketSaveFailed
    : text().appServerWebSocketTokenFailed);
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: text().appServerWebSocketPort }).value).toBe('13042');
  expect(document.body.textContent).not.toContain('secret-backend-detail');
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketSavePort }).disabled).toBe(false);
});

test('retains a fixed-port draft through mode switching, folding, refresh and token regeneration', async () => {
  const api = fixture();
  await mount();
  await chooseFixedPort();
  changePort('13042');
  await click(text().appServerWebSocketAutomatic);
  expect(screen.queryByRole('button', { name: text().appServerWebSocketSavePort })).toBeNull();
  await click(text().appServerWebSocketFixed);
  expect(portField().value).toBe('13042');
  await toggleSettings();
  expect(screen.queryByRole('spinbutton')).toBeNull();
  await openSettings();
  expect(portField().value).toBe('13042');

  await click(text().appServerWebSocketRefresh);
  await click(text().appServerWebSocketRegenerateToken);

  expect(api.regenerateToken).toHaveBeenCalledOnce();
  expect(api.setPort).not.toHaveBeenCalled();
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: text().appServerWebSocketPort }).value).toBe('13042');
  expect(screen.queryByText(text().appServerWebSocketTokenSaved)).toBeNull();
  expect(screen.getByText(text().appServerWebSocketTokenPending)).toBeTruthy();
  expect(screen.getByText(text().appServerWebSocketRestartRequired)).toBeTruthy();
  await toggleSettings();
  expect(screen.getByText(text().appServerWebSocketRestartRequired).closest('[hidden]')).toBeNull();
  expect(document.body.textContent).not.toContain('private-copy-only');
});

test('disables other actions while saving and ignores an earlier credential response', async () => {
  const api = fixture();
  const credentials = deferred<typeof config>();
  const save = deferred<AppServerIntegrationStatus>();
  api.getConnectionConfig.mockReturnValueOnce(credentials.promise);
  api.setPort.mockReturnValueOnce(save.promise);
  await mount();
  await click(text().appServerWebSocketCopyConfig);
  await chooseFixedPort();
  changePort('13042');

  await click(text().appServerWebSocketSavePort);

  for (const name of [
    text().appServerWebSocketSavePort,
    text().appServerWebSocketCancel,
    text().appServerWebSocketAutomatic,
    text().appServerWebSocketFixed,
    text().appServerWebSocketRegenerateToken,
    text().appServerWebSocketRefresh,
    text().appServerWebSocketCopyConfig,
  ]) {
    expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
  }
  expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: text().appServerWebSocketPort }).disabled).toBe(true);
  await act(async () => {
    credentials.resolve(config);
    save.resolve({ ...status, configuredPort: 13042, restartRequired: true });
  });
  expect(api.writeText).not.toHaveBeenCalled();
  expect(screen.getByText(text().appServerWebSocketRestartRequired)).toBeTruthy();
});

test.each([
  [AppServerIntegrationFailure.PortInUse, 'appServerWebSocketPortInUse'],
  [AppServerIntegrationFailure.Unavailable, 'appServerWebSocketUnavailable'],
] as const)('allows settings to be repaired when the service reports %s', async (failure, message) => {
  const api = fixture();
  api.getStatus.mockResolvedValueOnce({
    ...status, running: false, url: '', configuredPort: 13042, failure,
  });
  await mount();

  expect(screen.getByRole('alert').textContent).toBe(text()[message]);
  expect(screen.getByRole('alert').closest('[hidden]')).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketCopyConfig }).disabled).toBe(true);
  await openSettings();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: text().appServerWebSocketRegenerateToken }).disabled).toBe(false);
  changePort('13043');
  await click(text().appServerWebSocketSavePort);
  expect(api.setPort).toHaveBeenCalledExactlyOnceWith(13043);
  expect(api.getConnectionConfig).not.toHaveBeenCalled();
});
