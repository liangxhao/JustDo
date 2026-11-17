// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { createDefaultAgentRuntimeSettings } from '@shared/agents/agentRuntimeSettings';
import { createDefaultExternalAgentSettings } from '@shared/integrations/externalAgents';
import { BuiltinModelRefreshErrorCode } from '@shared/providers/builtinModels';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { LanguageModelSettingsProps } from './models/LanguageModelSettings';
import Settings from './Settings';

const { fetchModels, refreshBuiltinModels, locale } = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  refreshBuiltinModels: vi.fn(),
  locale: { language: 'zh' as 'zh' | 'en' },
}));

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/config', async () => {
  const { defaultConfig } = await import('@/app/config');
  return {
    configService: {
      getConfig: () => ({
        ...structuredClone(defaultConfig),
        providers: {
          builtin_models: { ...defaultConfig.providers?.builtin_models, enabled: false },
          office: {
            enabled: true,
            apiKey: 'fixture-key',
            baseUrl: 'https://models.example.test/v1',
            models: [{ id: 'manual-model', name: 'Manual', enabled: true }],
          },
        },
      }),
    },
  };
});
vi.mock('@/theme/themeService', () => ({
  themeService: {
    getTheme: () => 'light',
    getThemeId: () => 'classic-light',
    restoreTheme: vi.fn(),
  },
}));
vi.mock('@/services/i18n', async () => {
  const { settingsTranslations } = await import('@/services/i18n/settingsTranslations');
  const dictionary: Record<'zh' | 'en', Record<string, string>> = settingsTranslations;
  return {
    i18nService: {
      t: (key: string) => key.startsWith('builtinModelRefresh')
        ? dictionary[locale.language][key] ?? key : key,
      getLanguage: () => locale.language,
      setLanguage: vi.fn(),
      subscribe: () => () => {},
    },
  };
});
vi.mock('./models/ModelSettingsTab', () => ({
  default: ({ languageSettings }: { languageSettings: LanguageModelSettingsProps }) => (
    <>
      <button type="button" onClick={languageSettings.handleDetectModels}>
        detect
      </button>
      <button type="button" onClick={languageSettings.handleRefreshBuiltinModels}>
        refresh built-in models
      </button>
      <button
        type="button"
        onClick={() => languageSettings.setError('Import failed: invalid file')}
      >
        import-error
      </button>
      <button type="button" onClick={() => languageSettings.handleProviderChange('builtin_models')}>
        switch-provider
      </button>
      <output>{languageSettings.providers.office?.models?.map(model => model.id).join(',')}</output>
    </>
  ),
}));

beforeEach(() => {
  fetchModels.mockReset();
  refreshBuiltinModels.mockReset();
  locale.language = 'zh';
  vi.stubGlobal('electron', {
    api: { fetch: fetchModels },
    builtinModels: { refresh: refreshBuiltinModels },
    cowork: {
      getAgentRuntimeSettings: vi
        .fn()
        .mockResolvedValue({ success: true, settings: createDefaultAgentRuntimeSettings() }),
      getConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
    },
    openclaw: {
      externalAgents: {
        getSettings: vi
          .fn()
          .mockResolvedValue({ success: true, settings: createDefaultExternalAgentSettings() }),
      },
      engine: { getPort: vi.fn().mockResolvedValue({ success: true, port: 18789 }) },
    },
    autoLaunch: { get: vi.fn().mockResolvedValue({ enabled: false }) },
    preventSleep: { get: vi.fn().mockResolvedValue({ enabled: false }) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderSettings = (props: { notice?: string } = {}) =>
  render(
    <Provider store={configureStore({ reducer: () => ({}) })}>
      <Settings initialTab="model" onClose={vi.fn()} {...props} />
    </Provider>,
  );

test.each([
  {
    language: 'zh',
    result: { errorCode: BuiltinModelRefreshErrorCode.ExchangeTimeout },
    message: '模型换证请求超时，请重试。',
  },
  {
    language: 'en',
    result: { errorCode: BuiltinModelRefreshErrorCode.ExchangeHttpError, httpStatus: 403 },
    message: 'The model authentication service returned HTTP 403.',
  },
  {
    language: 'zh',
    result: { errorCode: BuiltinModelRefreshErrorCode.DeviceUnavailable },
    message: '无法获取用于模型换证的设备网卡地址。',
  },
] as const)('localizes the $result.errorCode built-in refresh failure in $language', async ({
  language, result, message,
}) => {
  locale.language = language;
  refreshBuiltinModels.mockResolvedValue({ success: false, error: 'opaque-fixture', ...result });

  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'refresh built-in models' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'settingsOperationFailed' });
  expect(dialog.textContent).toContain(message);
  expect(dialog.textContent).not.toContain('opaque-fixture');
});

test('shows a localized fallback when the built-in refresh bridge rejects', async () => {
  refreshBuiltinModels.mockRejectedValue(new Error('private failure detail'));

  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'refresh built-in models' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'settingsOperationFailed' });
  expect(dialog.textContent).toContain('无法刷新内置模型，请重试。');
  expect(dialog.textContent).not.toContain('private failure detail');
});

test('shows the real HTTP status and server reason in a dialog and preserves the model draft', async () => {
  fetchModels.mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: {},
    data: { error: { message: 'This service does not expose a model catalog' } },
  });
  renderSettings();
  const detect = screen.getByRole('button', { name: 'detect' });
  detect.focus();
  fireEvent.click(detect);

  const dialog = await screen.findByRole('alertdialog', { name: 'settingsOperationFailed' });
  expect(dialog.textContent).toContain('HTTP 404 Not Found');
  expect(dialog.textContent).toContain('This service does not expose a model catalog');
  expect(dialog.textContent).toContain('modelDiscoveryEndpointNotFound');
  expect(fetchModels).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://models.example.test/v1/models',
    }),
  );
  expect(screen.getByText('manual-model')).toBeTruthy();
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'confirm' }));

  fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(detect);
});

test('explains a closed model service connection without displaying a fictitious HTTP status', async () => {
  fetchModels.mockResolvedValue({
    ok: false,
    status: 0,
    statusText: 'net::ERR_CONNECTION_CLOSED',
    headers: {},
    data: null,
    error: 'net::ERR_CONNECTION_CLOSED',
  });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'detect' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('modelDiscoveryConnectionClosed');
  expect(dialog.textContent).toContain('net::ERR_CONNECTION_CLOSED');
  expect(dialog.textContent).not.toContain('0 net::');
  expect(dialog.textContent).not.toContain('HTTP 0');

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('uses the same dismissible dialog for other settings errors and traps keyboard focus', () => {
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'import-error' }));
  const dialog = screen.getByRole('alertdialog');
  const confirm = within(dialog).getByRole('button', { name: 'confirm' });
  const close = within(dialog).getByRole('button', { name: 'close' });
  expect(dialog.textContent).toContain('Import failed: invalid file');
  fireEvent.keyDown(confirm, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(confirm);
  fireEvent.click(close);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

test('uses a neutral title for notices', () => {
  renderSettings({ notice: 'Settings saved successfully' });
  const dialog = screen.getByRole('dialog', { name: 'settingsNoticeTitle' });
  expect(dialog.textContent).toContain('Settings saved successfully');
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'confirm' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('ignores a failed discovery response after switching providers', async () => {
  let finish!: (response: unknown) => void;
  fetchModels.mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'detect' }));
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));
  await act(async () => {
    finish({ ok: false, status: 404, statusText: 'Not Found', data: 'old provider error' });
  });
  expect(fetchModels).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
