// @vitest-environment jsdom

import { AppUpdateCheckFrequency } from '@shared/appUpdate';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import AppUpdateFrequencySetting from './AppUpdateFrequencySetting';

const appUpdateMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  setCheckFrequency: vi.fn(),
}));

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
  },
}));

vi.mock('@/shared/components/ui/ThemedSelect', () => ({
  default: ({
    ariaLabel,
    disabled,
    onChange,
    options,
    value,
  }: {
    ariaLabel?: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    value: string;
  }) =>
    React.createElement(
      'select',
      {
        'aria-label': ariaLabel,
        disabled,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      options.map(option =>
        React.createElement('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
}));

describe('AppUpdateFrequencySetting', () => {
  beforeEach(() => {
    appUpdateMocks.getPreferences.mockReset();
    appUpdateMocks.setCheckFrequency.mockReset();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        appUpdate: appUpdateMocks,
      },
    });
  });

  afterEach(cleanup);

  test('loads and persists daily, weekly, or never automatic checks', async () => {
    appUpdateMocks.getPreferences.mockResolvedValue({
      supported: true,
      checkFrequency: AppUpdateCheckFrequency.Daily,
    });
    appUpdateMocks.setCheckFrequency.mockResolvedValue({
      supported: true,
      checkFrequency: AppUpdateCheckFrequency.Weekly,
    });
    render(React.createElement(AppUpdateFrequencySetting));

    const select = screen.getByRole('combobox', {
      name: 'appUpdateFrequencyTitle',
    }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe(AppUpdateCheckFrequency.Daily);

    fireEvent.change(select, { target: { value: AppUpdateCheckFrequency.Weekly } });
    await waitFor(() => {
      expect(appUpdateMocks.setCheckFrequency).toHaveBeenCalledWith(AppUpdateCheckFrequency.Weekly);
      expect(select.value).toBe(AppUpdateCheckFrequency.Weekly);
    });
    expect(screen.getByText('appUpdateFrequencyWeeklyHint')).toBeTruthy();
  });

  test('disables the frequency selector when automatic updates are unsupported', async () => {
    appUpdateMocks.getPreferences.mockResolvedValue({
      supported: false,
      checkFrequency: AppUpdateCheckFrequency.Daily,
    });
    render(React.createElement(AppUpdateFrequencySetting));

    const select = screen.getByRole('combobox', {
      name: 'appUpdateFrequencyTitle',
    }) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(screen.getByText('appUpdateStatusUnsupported')).toBeTruthy();
  });
});
