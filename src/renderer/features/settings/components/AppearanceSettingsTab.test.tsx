// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';

import AppearanceSettingsTab from './AppearanceSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

afterEach(cleanup);

describe('AppearanceSettingsTab', () => {
  test('shows bubble layout as the default and lets the user preview document layout', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AppearanceSettingsTab value={defaultAppearanceConfig} onChange={onChange} />,
    );

    expect(
      screen.getByRole('button', { name: 'messageLayoutBubble' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(document.querySelector('[data-message-layout-preview="bubble"]')).not.toBeNull();
    expect(document.querySelector('[data-message-layout-preview="document"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'messageLayoutDocument' }));

    expect(onChange).toHaveBeenCalledWith({
      ...defaultAppearanceConfig,
      messageLayout: 'document',
    });

    rerender(
      <AppearanceSettingsTab
        value={{ ...defaultAppearanceConfig, messageLayout: 'document' }}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'messageLayoutDocument' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'messageLayoutBubble' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  test('restores reading defaults without changing the independently selected layout', () => {
    const onChange = vi.fn();
    const documentAppearance = {
      ...defaultAppearanceConfig,
      chatContentWidth: 88,
      messageLayout: 'document' as const,
    };
    render(<AppearanceSettingsTab value={documentAppearance} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'restoreDefaults' }));

    expect(onChange).toHaveBeenCalledWith({
      ...defaultAppearanceConfig,
      messageLayout: 'document',
    });
  });
});
