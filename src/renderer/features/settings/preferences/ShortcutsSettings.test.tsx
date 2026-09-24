// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultConfig } from '@/app/config';
import { i18nService } from '@/services/i18n';

import ShortcutsSettings, {
  findShortcutConflict,
  type ShortcutSettingsValue,
} from './ShortcutsSettings';

afterEach(cleanup);

describe('ShortcutsSettings', () => {
  it('shows editable workspace shortcuts with Codex defaults', () => {
    i18nService.setLanguage('en', { persist: false });
    const onShortcutChange = vi.fn();

    render(
      <ShortcutsSettings
        shortcuts={defaultConfig.shortcuts as ShortcutSettingsValue}
        onShortcutChange={onShortcutChange}
      />,
    );

    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByText('Browser')).toBeTruthy();
    expect(screen.getByText('Side chat')).toBeTruthy();
    expect(screen.getByText('Ctrl+`')).toBeTruthy();
    expect(screen.getByText('Ctrl+T')).toBeTruthy();
    expect(screen.getByText('Ctrl+Alt+S')).toBeTruthy();

    const terminalShortcut = screen.getByRole('button', { name: 'Terminal: Ctrl+`' });
    fireEvent.click(terminalShortcut);
    fireEvent.keyDown(terminalShortcut, { key: 'K', ctrlKey: true });
    expect(onShortcutChange).toHaveBeenCalledWith('terminal', 'Ctrl+K');
  });

  it('allows more than one shortcut to be unset', () => {
    const shortcuts = {
      ...(defaultConfig.shortcuts as ShortcutSettingsValue),
      terminal: '',
    };

    expect(findShortcutConflict(shortcuts, 'browser', '')).toBeUndefined();
  });

  it('opens the send shortcut menu from the keyboard', () => {
    i18nService.setLanguage('en', { persist: false });

    render(
      <ShortcutsSettings
        shortcuts={defaultConfig.shortcuts as ShortcutSettingsValue}
        onShortcutChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /Send Message:/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(0);
  });
});
