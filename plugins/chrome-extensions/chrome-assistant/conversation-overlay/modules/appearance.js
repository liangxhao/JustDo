export const APPEARANCE_KEY = 'justdoSidePanelTheme';
export const THEMES = ['dark', 'light', 'warm', 'blue', 'system'];
export const normalizeTheme = value => (THEMES.includes(value) ? value : 'light');

export async function initializeAppearance({
  root = document.documentElement,
  onChange = () => {},
  storage = globalThis.chrome?.storage,
  media = globalThis.matchMedia?.('(prefers-color-scheme: dark)'),
} = {}) {
  let selected = 'light';
  let revision = 0;
  const apply = value => {
    selected = normalizeTheme(value);
    root.dataset.theme = selected === 'system' ? (media?.matches ? 'dark' : 'light') : selected;
    onChange(selected);
  };
  const changed = (changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, APPEARANCE_KEY)) return;
    revision += 1;
    apply(changes[APPEARANCE_KEY].newValue);
  };
  const systemChanged = () => {
    if (selected === 'system') apply(selected);
  };
  storage?.onChanged?.addListener(changed);
  media?.addEventListener('change', systemChanged);
  apply(selected);
  try {
    const snapshotRevision = revision;
    const result = await storage?.local.get(APPEARANCE_KEY);
    if (revision === snapshotRevision) apply(result?.[APPEARANCE_KEY]);
  } catch {
    /* Keep the default palette if browser storage is unavailable. */
  }
  return {
    async select(value) {
      const next = normalizeTheme(value);
      if (!storage?.local) throw new Error('Storage unavailable');
      const snapshotRevision = revision;
      await storage.local.set({ [APPEARANCE_KEY]: next });
      if (revision === snapshotRevision) apply(next);
    },
    dispose() {
      storage?.onChanged?.removeListener(changed);
      media?.removeEventListener('change', systemChanged);
    },
  };
}
