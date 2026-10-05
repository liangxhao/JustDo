// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { translations } from '@/services/i18n/translations';

import { matchesSettingsPage, SETTINGS_PAGES } from './settingsCatalog';
import { SettingsNavigation } from './SettingsNavigation';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (translations.zh as Record<string, string>)[key] ?? key,
  },
}));

afterEach(cleanup);

describe('SettingsNavigation', () => {
  it('opens computer control from navigation and finds it by the image requirement', () => {
    const onSelect = vi.fn();
    render(<SettingsNavigation activeTab="general" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '图像' } });
    fireEvent.click(screen.getByRole('button', { name: /电脑操控/ }));
    expect(onSelect).toHaveBeenCalledWith('computer');
  });
  it('finds a page by a setting within it without changing the current page', () => {
    const onSelect = vi.fn();
    render(<SettingsNavigation activeTab="model" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '启动' } });
    expect(screen.getByRole('button', { name: /通用/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '外观' })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /通用/ }));
    expect(onSelect).toHaveBeenCalledWith('general');
  });

  it('shows an empty state and restores navigation when search is cleared', () => {
    render(<SettingsNavigation activeTab="general" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched-setting' } });
    expect(screen.getByRole('status').textContent).toContain('未找到匹配的设置');
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: '通用' }).getAttribute('aria-current')).toBe('page');
  });

  it('clears search with Escape and routes the back button through the close guard', () => {
    const onClose = vi.fn();
    render(<SettingsNavigation activeTab="general" onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '语言' } });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('matches multiple case-insensitive terms and translates all catalog metadata', () => {
    for (const locale of [translations.zh, translations.en]) {
      const dictionary = locale as Record<string, string>;
      for (const page of SETTINGS_PAGES) {
        for (const key of [page.label, page.description, ...page.keywords]) {
          expect(dictionary[key], key).toBeTruthy();
        }
      }
    }
    const model = SETTINGS_PAGES.find(page => page.id === 'model')!;
    const translate = (key: string) => (translations.en as Record<string, string>)[key] ?? key;
    expect(matchesSettingsPage(model, '  API   providers ', translate)).toBe(true);
    expect(matchesSettingsPage(model, 'API downloads', translate)).toBe(false);
  });
});
