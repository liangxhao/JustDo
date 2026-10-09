// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { BrowserMode } from '@shared/browser/browser';
import { defaultCustomProxyConfig, ProxyMode } from '@shared/network/proxy';
import { createDefaultAgentRuntimeSettings } from '@shared/openclaw/agentRuntimeSettings';
import { createDefaultExternalAgentSettings } from '@shared/openclaw/externalAgents';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { type AppConfig, defaultConfig } from '@/app/config';

import Settings from './Settings';

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), updateConfig: vi.fn() }));

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('./preferences/GeneralSettingsPage', () => ({
  GeneralSettingsPage: () => <p>General preferences</p>,
}));
vi.mock('@/services/config', () => ({ configService: mocks }));
vi.mock('@/services/theme', () => ({
  themeService: {
    getTheme: () => 'light',
    getThemeId: () => 'classic-light',
    setTheme: vi.fn(),
    restoreTheme: vi.fn(),
  },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
    getLanguage: () => 'zh',
    setLanguage: vi.fn(),
    subscribe: () => () => {},
  },
}));

let currentConfig: AppConfig;

beforeEach(() => {
  currentConfig = structuredClone(defaultConfig);
  currentConfig.browserMode = BrowserMode.Embedded;
  currentConfig.proxy = {
    mode: ProxyMode.CUSTOM,
    custom: { ...defaultCustomProxyConfig, host: '127.0.0.1', port: '8888' },
  };
  mocks.getConfig.mockImplementation(() => structuredClone(currentConfig));
  mocks.updateConfig.mockImplementation(async (patch: Partial<AppConfig>) => {
    currentConfig = { ...currentConfig, ...patch };
  });
  vi.stubGlobal('electron', {
    cowork: {
      getAgentRuntimeSettings: vi.fn().mockResolvedValue({
        success: true,
        settings: createDefaultAgentRuntimeSettings(),
      }),
      getConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
    },
    openclaw: {
      externalAgents: {
        getSettings: vi.fn().mockResolvedValue({
          success: true,
          settings: createDefaultExternalAgentSettings(),
        }),
      },
      engine: {
        getPort: vi.fn().mockResolvedValue({ success: true, port: 18789 }),
        onProgress: () => () => {},
      },
    },
    browser: {
      getStatus: vi.fn().mockResolvedValue({ success: false }),
    },
    extensions: { onChanged: () => () => {} },
    autoLaunch: { get: vi.fn().mockResolvedValue({ enabled: false }) },
    preventSleep: { get: vi.fn().mockResolvedValue({ enabled: false }) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function renderSettings(onClose = vi.fn()) {
  const store = configureStore({ reducer: () => ({}) });
  return render(
    <Provider store={store}>
      <Settings initialTab="browser" onClose={onClose} />
    </Provider>,
  );
}

const proxySection = () => screen.getByRole('region', { name: 'browserProxySettings' });
const footerSave = () => {
  const buttons = screen.getAllByRole('button', { name: 'save' });
  return buttons[buttons.length - 1];
};

test.each(['footer', 'section', 'form'] as const)(
  '%s submit saves the browser proxy independently of the application debugging proxy',
  async submit => {
    const view = renderSettings();
    expect(
      (within(proxySection()).getByRole('combobox', { name: 'proxyMode' }) as HTMLSelectElement)
        .value,
    ).toBe(ProxyMode.SYSTEM);
    fireEvent.change(within(proxySection()).getByRole('combobox', { name: 'proxyMode' }), {
      target: { value: ProxyMode.DIRECT },
    });
    if (submit === 'section') {
      fireEvent.click(within(proxySection()).getByRole('button', { name: 'save' }));
    } else if (submit === 'footer') {
      fireEvent.click(footerSave());
    } else {
      fireEvent.submit(view.container.querySelector('form')!);
    }

    await screen.findByText('settingsSaved');
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        browserProxy: { mode: ProxyMode.DIRECT, custom: defaultCustomProxyConfig },
      }),
    );
    expect(mocks.updateConfig.mock.calls.every(([patch]) => !('proxy' in patch))).toBe(true);
    expect(currentConfig.proxy.mode).toBe(ProxyMode.CUSTOM);
  },
);

test('retains the browser proxy draft when changing tabs and saves it from the general page', async () => {
  renderSettings();
  fireEvent.change(within(proxySection()).getByRole('combobox', { name: 'proxyMode' }), {
    target: { value: ProxyMode.DIRECT },
  });
  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  fireEvent.click(screen.getByRole('button', { name: 'browserSettings' }));
  expect(
    (within(proxySection()).getByRole('combobox', { name: 'proxyMode' }) as HTMLSelectElement)
      .value,
  ).toBe(ProxyMode.DIRECT);
  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  fireEvent.click(footerSave());

  await screen.findByText('settingsSaved');
  expect(currentConfig.browserProxy.mode).toBe(ProxyMode.DIRECT);
});

test('rejects invalid custom proxy settings and saves normalized values after correction', async () => {
  renderSettings();
  fireEvent.change(within(proxySection()).getByRole('combobox', { name: 'proxyMode' }), {
    target: { value: ProxyMode.CUSTOM },
  });
  fireEvent.click(footerSave());
  expect(screen.getByText('proxyInvalidConfiguration')).toBeTruthy();
  expect(screen.queryByText('settingsSaved')).toBeNull();
  expect(mocks.updateConfig).not.toHaveBeenCalled();

  fireEvent.change(within(proxySection()).getByLabelText('proxyHost'), {
    target: { value: ' proxy.example ' },
  });
  fireEvent.change(within(proxySection()).getByLabelText('proxyPort'), {
    target: { value: '8080' },
  });
  fireEvent.click(footerSave());

  await screen.findByText('settingsSaved');
  expect(currentConfig.browserProxy).toEqual({
    mode: ProxyMode.CUSTOM,
    custom: { ...defaultCustomProxyConfig, host: 'proxy.example', port: '8080' },
  });
});

test('retains an editable proxy draft after persistence failure and allows retry', async () => {
  mocks.updateConfig.mockRejectedValueOnce(new Error('storage unavailable'));
  renderSettings();
  fireEvent.change(within(proxySection()).getByRole('combobox', { name: 'proxyMode' }), {
    target: { value: ProxyMode.DIRECT },
  });
  fireEvent.click(footerSave());

  await screen.findByText('storage unavailable');
  expect(screen.queryByText('settingsSaved')).toBeNull();
  expect(
    (within(proxySection()).getByRole('combobox', { name: 'proxyMode' }) as HTMLSelectElement)
      .value,
  ).toBe(ProxyMode.DIRECT);
  expect((footerSave() as HTMLButtonElement).disabled).toBe(false);
  expect(currentConfig.browserProxy.mode).toBe(ProxyMode.SYSTEM);

  fireEvent.click(footerSave());
  await screen.findByText('settingsSaved');
  expect(currentConfig.browserProxy.mode).toBe(ProxyMode.DIRECT);
});

test('cancel discards the unsaved browser proxy draft', async () => {
  const onClose = vi.fn();
  const view = renderSettings(onClose);
  fireEvent.change(within(proxySection()).getByRole('combobox', { name: 'proxyMode' }), {
    target: { value: ProxyMode.DIRECT },
  });
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(mocks.updateConfig).not.toHaveBeenCalled();
  view.unmount();

  renderSettings();
  await waitFor(() =>
    expect(
      (within(proxySection()).getByRole('combobox', { name: 'proxyMode' }) as HTMLSelectElement)
        .value,
    ).toBe(ProxyMode.SYSTEM),
  );
});
