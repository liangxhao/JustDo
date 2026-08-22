import type { AppearanceConfig } from '@/app/appearance';

type ThemeMode = 'light' | 'dark' | 'system';
type Language = 'zh' | 'en';
type MutableSnapshot<T> = { current: T };

interface PreviewSnapshots {
  themeId: MutableSnapshot<string>;
  theme: MutableSnapshot<ThemeMode>;
  appearance: MutableSnapshot<AppearanceConfig>;
  language: MutableSnapshot<Language>;
}

interface PreviewRestoreActions {
  restoreTheme: (themeId: string, theme: ThemeMode) => void;
  restoreAppearance: (appearance: AppearanceConfig) => void;
  restoreLanguage: (language: Language) => void;
}

/** Build an unmount cleanup that reads the latest successfully committed snapshots. */
export const createSettingsPreviewRestore = (
  snapshots: PreviewSnapshots,
  actions: PreviewRestoreActions,
): (() => void) => {
  return () => {
    actions.restoreTheme(snapshots.themeId.current, snapshots.theme.current);
    actions.restoreAppearance(snapshots.appearance.current);
    actions.restoreLanguage(snapshots.language.current);
  };
};
