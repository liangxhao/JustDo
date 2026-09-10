// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { AppConfig } from '@/app/config';

import ModelSettingsTab from './ModelSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

const providers: NonNullable<AppConfig['providers']> = {
  builtin_models: {
    enabled: true,
    readonly: true,
    apiKey: '',
    baseUrl: '',
    apiFormat: 'openai',
    models: [],
  },
  custom_0: {
    enabled: false,
    apiKey: 'secret',
    baseUrl: 'https://example.test/v1',
    apiFormat: 'openai',
    displayName: 'Acme',
    models: [],
  },
};

const renderTab = (
  options: {
    displayNameError?: string | null;
    providers?: NonNullable<AppConfig['providers']>;
  } = {},
) => {
  const handleProviderConfigChange = vi.fn();
  const setDisplayNameError = vi.fn();

  render(
    <ModelSettingsTab
      activeProvider="custom_0"
      providers={options.providers ?? providers}
      isTesting={false}
      displayNameError={options.displayNameError ?? null}
      providerRequiresApiKey={() => true}
      isProviderReadOnly={provider => provider === 'builtin_models'}
      getProviderDefaultBaseUrl={() => null}
      handleProviderChange={vi.fn()}
      handleProviderConfigChange={handleProviderConfigChange}
      toggleProviderEnabled={vi.fn()}
      handleAddCustomProvider={vi.fn()}
      handleAddModel={vi.fn()}
      handleDetectModels={vi.fn()}
      handleEditModel={vi.fn()}
      handleDeleteModel={vi.fn()}
      handleModelEnabledChange={vi.fn()}
      handleSetAllModelsEnabled={vi.fn()}
      handleTestConnection={vi.fn()}
      handleTestModelConnection={vi.fn()}
      handleRefreshBuiltinModels={vi.fn()}
      isRefreshingBuiltinModels={false}
      isDetectingModels={false}
      modelDiscoveryMessage={null}
      modelConnectionTestStatuses={{}}
      setDisplayNameError={setDisplayNameError}
      setProviders={vi.fn()}
      setError={vi.fn()}
      onRequestDeleteProvider={vi.fn()}
    />,
  );

  return { handleProviderConfigChange, setDisplayNameError };
};

describe('ModelSettingsTab', () => {
  afterEach(cleanup);

  test('reveals and hides the API key without changing its value', () => {
    const { handleProviderConfigChange } = renderTab();
    const input = screen.getByLabelText(/apiKey/) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'showApiKey' }));
    expect(input.type).toBe('text');
    expect(input.value).toBe('secret');
    fireEvent.click(screen.getByRole('button', { name: 'hideApiKey' }));
    expect(input.type).toBe('password');
    expect(input.value).toBe('secret');
    expect(handleProviderConfigChange).not.toHaveBeenCalled();
  });

  test.each([
    ['JustDo', 'providerNameReserved'],
    ['Invalid@Name', 'providerNameInvalid'],
  ])('keeps %s in parent state while reporting %s', (value, expectedError) => {
    const { handleProviderConfigChange, setDisplayNameError } = renderTab();

    fireEvent.change(screen.getByLabelText('customDisplayName'), { target: { value } });

    expect(handleProviderConfigChange).toHaveBeenCalledWith('custom_0', 'displayName', value);
    expect(setDisplayNameError).toHaveBeenCalledWith(expectedError);
  });

  test('connects the inline validation message to the input', () => {
    renderTab({ displayNameError: 'providerNameInvalid' });

    const input = screen.getByLabelText('customDisplayName');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('custom_0-displayName-error');
    expect(screen.getByRole('alert').textContent).toBe('providerNameInvalid');
  });

  test('keeps newly appended providers at the end instead of sorting them alphabetically', () => {
    renderTab({
      providers: {
        ...providers,
        zulu: {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          apiFormat: 'openai',
          displayName: 'Zulu',
          models: [],
        },
        alpha: {
          enabled: false,
          apiKey: '',
          baseUrl: '',
          apiFormat: 'openai',
          displayName: 'Alpha',
          models: [],
        },
      },
    });

    const zulu = screen.getByText('Zulu');
    const alpha = screen.getByText('Alpha');
    expect(zulu.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
