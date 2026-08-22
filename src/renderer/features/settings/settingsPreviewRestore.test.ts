import { describe, expect, test, vi } from 'vitest';

import { defaultAppearanceConfig } from '@/app/appearance';
import { createSettingsPreviewRestore } from '@/features/settings/settingsPreviewRestore';

describe('settings preview restore', () => {
  test('restores the latest committed snapshot after a later draft is previewed', () => {
    const snapshots = {
      themeId: { current: 'classic-light' },
      theme: { current: 'light' as 'light' | 'dark' | 'system' },
      appearance: { current: defaultAppearanceConfig },
      language: { current: 'zh' as 'zh' | 'en' },
    };
    const restoreTheme = vi.fn();
    const restoreAppearance = vi.fn();
    const restoreLanguage = vi.fn();
    const cleanup = createSettingsPreviewRestore(snapshots, {
      restoreTheme,
      restoreAppearance,
      restoreLanguage,
    });
    const committedAppearance = { ...defaultAppearanceConfig, fontSize: 18 };

    snapshots.themeId.current = 'midnight';
    snapshots.theme.current = 'dark';
    snapshots.appearance.current = committedAppearance;
    snapshots.language.current = 'en';
    // A subsequent live preview changes the DOM, not the committed refs.
    cleanup();

    expect(restoreTheme).toHaveBeenCalledWith('midnight', 'dark');
    expect(restoreAppearance).toHaveBeenCalledWith(committedAppearance);
    expect(restoreLanguage).toHaveBeenCalledWith('en');
  });
});
