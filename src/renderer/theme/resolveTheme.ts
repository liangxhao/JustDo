import type { WindowAppearance } from '@shared/app/windowAppearance';

import { allThemes } from './themes';
import type { ThemeDefinition } from './themes/types';

/** Startup and the full theme service must choose the same saved palette. */
export function resolveTheme(
  mode: WindowAppearance['mode'],
  savedId: string | null | undefined,
  systemDark: boolean,
): ThemeDefinition {
  const appearance = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const saved = allThemes.find(theme => theme.meta.id === savedId);
  return saved?.meta.appearance === appearance
    ? saved
    : allThemes.find(theme => theme.meta.appearance === appearance)!;
}
