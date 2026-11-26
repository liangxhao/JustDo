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

const { fetchModels, refreshBuiltinModels, testBuiltinModel, locale } = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  refreshBuiltinModels: vi.fn(),
  testBuiltinModel: vi.fn(),
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
          builtin_models: {
            ...defaultConfig.providers?.builtin_models,
            enabled: false,
            models: [
              { id: 'team-model', name: 'Team Model', enabled: true },
              { id: 'second-model', name: 'Second Model', enabled: true },
              { id: 'third-model', name: 'Third Model', enabled: true },
            ],
          },
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
      t: (key: string) => key.startsWith('builtinModelRefresh') || key === 'connectionTestSummary'
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
      <button type="button" onClick={() => languageSettings.handleTestConnection('team-model')}>
        test built-in model
      </button>
      <button type="button" onClick={() => languageSettings.handleTestConnection()}>
        test all models
      </button>
      <output>{languageSettings.providers.office?.models?.map(model => model.id).join(',')}</output>
      <output>{String(languageSettings.providers.builtin_models?.models?.[0]?.enabled)}</output>
      <output aria-label="Team Model status">{languageSettings.modelConnectionTestStatuses['team-model']}</output>
    </>
  ),
}));

beforeEach(() => {
  fetchModels.mockReset();
  refreshBuiltinModels.mockReset();
  testBuiltinModel.mockReset();
  locale.language = 'zh';
  vi.stubGlobal('electron', {
    api: { fetch: fetchModels, testBuiltinModel, cancelFetch: vi.fn().mockResolvedValue(undefined) },
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
    language: 'en',
    result: { errorCode: BuiltinModelRefreshErrorCode.ExchangeHttpError, httpStatus: 403 },
    message: 'The model authentication service returned HTTP 403.',
  },
  {
    language: 'zh',
    result: { errorCode: BuiltinModelRefreshErrorCode.DeviceUnavailable },
    message: 'Could not obtain a device MAC address for model authentication.',
  },
] as const)('shows the $result.errorCode built-in refresh failure in English in $language', async ({
  language, result, message,
}) => {
  locale.language = language;
  refreshBuiltinModels.mockResolvedValue({ success: false, ...result });

  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'refresh built-in models' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'settingsOperationFailed' });
  expect(dialog.textContent).toContain(message);
});

test.each(['skipped', 'rejected'])('does not open an error dialog when built-in refresh is %s internally', async outcome => {
  if (outcome === 'skipped') refreshBuiltinModels.mockResolvedValue({ success: false, skipped: true });
  else refreshBuiltinModels.mockRejectedValue(new Error('private failure detail'));

  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'refresh built-in models' }));

  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'refresh built-in models' })).toHaveProperty('disabled', false));
  expect(screen.queryByRole('alertdialog', { name: 'settingsOperationFailed' })).toBeNull();
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

const successfulBuiltinProbe = {
  outcome: 'completed',
  response: {
    ok: true, status: 200, statusText: 'OK', data: { choices: [{ message: { content: 'Hi' } }] },
  },
};

test('waits for the same built-in probe and presents its completed result', async () => {
  const pending = Promise.withResolvers<typeof successfulBuiltinProbe>();
  testBuiltinModel.mockReturnValue(pending.promise);
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));

  fireEvent.click(screen.getByRole('button', { name: 'test built-in model' }));

  await vi.waitFor(() => expect(testBuiltinModel).toHaveBeenCalledWith({
    modelId: 'team-model', requestId: expect.any(String),
  }));
  expect(screen.getByText('connectionTestRunning')).toBeTruthy();
  await act(async () => { pending.resolve(successfulBuiltinProbe); });

  expect(screen.getAllByText('connectionSuccess').length).toBeGreaterThan(0);
  expect(testBuiltinModel).toHaveBeenCalledOnce();
  expect(fetchModels).not.toHaveBeenCalled();
  expect(screen.queryByText('connectionFailed')).toBeNull();
  expect(screen.getByText('true', { selector: 'output' })).toBeTruthy();
});

test('closes an interrupted probe silently and preserves the previous model status', async () => {
  testBuiltinModel.mockResolvedValueOnce(successfulBuiltinProbe).mockResolvedValueOnce({ outcome: 'interrupted' });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));
  const probe = screen.getByRole('button', { name: 'test built-in model' });
  fireEvent.click(probe);
  await screen.findAllByText('connectionSuccess');
  fireEvent.click(within(screen.getByRole('dialog', { name: 'connectionTestResult' })).getByRole('button', { name: 'close' }));

  fireEvent.click(probe);
  await vi.waitFor(() => expect(testBuiltinModel).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('dialog', { name: 'connectionTestResult' })).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByLabelText('Team Model status').textContent).toBe('success');
  expect(screen.getByText('true', { selector: 'output' })).toBeTruthy();
});

test('stops an interrupted provider-wide probe and shows only the completed rows', async () => {
  locale.language = 'en';
  testBuiltinModel.mockResolvedValueOnce(successfulBuiltinProbe).mockResolvedValueOnce({ outcome: 'interrupted' });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));

  fireEvent.click(screen.getByRole('button', { name: 'test all models' }));

  await screen.findByText('Tested 1/3 models');
  const dialog = within(screen.getByRole('dialog', { name: 'connectionTestResult' }));
  expect(dialog.getByText('Team Model')).toBeTruthy();
  expect(dialog.queryByText('Second Model')).toBeNull();
  expect(dialog.queryByText('Third Model')).toBeNull();
  expect(dialog.getAllByText('connectionSuccess')).toHaveLength(1);
  expect(dialog.queryByText('connectionFailed')).toBeNull();
  expect(testBuiltinModel).toHaveBeenCalledTimes(2);
});

test('reports an actionable probe authentication rejection in English without failing the model', async () => {
  testBuiltinModel.mockResolvedValue({
    outcome: 'authentication-rejected',
    issue: { errorCode: BuiltinModelRefreshErrorCode.ExchangeHttpError, httpStatus: 403 },
  });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));

  fireEvent.click(screen.getByRole('button', { name: 'test built-in model' }));

  const dialog = await screen.findByRole('alertdialog', { name: 'settingsOperationFailed' });
  expect(dialog.textContent).toContain('The model authentication service returned HTTP 403.');
  expect(screen.queryByRole('dialog', { name: 'connectionTestResult' })).toBeNull();
  expect(screen.getByLabelText('Team Model status').textContent).toBe('');
  expect(screen.getByText('true', { selector: 'output' })).toBeTruthy();
});

test('shows the built-in server response without disabling the model', async () => {
  testBuiltinModel.mockResolvedValue({
    outcome: 'completed',
    response: { ok: false, status: 503, statusText: 'Service Unavailable', data: { error: 'Model service is busy' } },
  });
  renderSettings();
  fireEvent.click(screen.getByRole('button', { name: 'switch-provider' }));
  fireEvent.click(screen.getByRole('button', { name: 'test built-in model' }));

  await screen.findAllByText('Model service is busy');
  expect(screen.getByText('true', { selector: 'output' })).toBeTruthy();
});
