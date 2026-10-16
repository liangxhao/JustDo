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
  test('shows document layout as the default and lets the user preview bubble layout', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AppearanceSettingsTab value={defaultAppearanceConfig} onChange={onChange} />,
    );

    expect(
      screen.getByRole('button', { name: 'messageLayoutDocument' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(document.querySelector('[data-message-layout-preview="bubble"]')).not.toBeNull();
    expect(document.querySelector('[data-message-layout-preview="document"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'messageLayoutBubble' }));

    expect(onChange).toHaveBeenCalledWith({
      ...defaultAppearanceConfig,
      messageLayout: 'bubble',
    });

    rerender(
      <AppearanceSettingsTab
        value={{ ...defaultAppearanceConfig, messageLayout: 'bubble' }}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'messageLayoutBubble' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'messageLayoutDocument' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  test('restores reading defaults without changing the independently selected layout', () => {
    const onChange = vi.fn();
    const bubbleAppearance = {
      ...defaultAppearanceConfig,
      chatContentWidth: 88,
      messageLayout: 'bubble' as const,
    };
    render(<AppearanceSettingsTab value={bubbleAppearance} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'restoreDefaults' }));

    expect(onChange).toHaveBeenCalledWith({
      ...defaultAppearanceConfig,
      messageLayout: 'bubble',
    });
  });

  test('restoring reading defaults preserves pet preferences', () => {
    const onChange = vi.fn();
    const appearance = { ...defaultAppearanceConfig, petEnabled: false, petAnimationEnabled: false };
    render(<AppearanceSettingsTab value={appearance} onChange={onChange} />);
    expect(screen.queryByRole('switch', { name: 'coworkPetShow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'restoreDefaults' }));
    expect(onChange).toHaveBeenCalledWith({
      ...defaultAppearanceConfig,
      petEnabled: false,
      petAnimationEnabled: false,
    });
  });
});
