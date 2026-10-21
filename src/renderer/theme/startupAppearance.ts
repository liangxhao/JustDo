import { normalizeWindowAppearance } from '@shared/app/windowAppearance';

import { resolveTheme } from './resolveTheme';

// Bundled into the HTML head: consumes the synchronous preload snapshot, before modules load.
const initial = window.electron?.initialization?.appearance;
const appearance = normalizeWindowAppearance(initial?.mode, initial?.themeId);
const theme = resolveTheme(
  appearance.mode,
  appearance.themeId,
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);
const root = document.documentElement;
root.dataset.theme = theme.meta.id;
root.classList.toggle('dark', theme.meta.appearance === 'dark');
root.classList.toggle('light', theme.meta.appearance === 'light');
