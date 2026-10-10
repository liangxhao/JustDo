export const RENDERER_PREFERENCES_KEY = 'app.renderer-preferences.v1';
export const RENDERER_PREFERENCE_FIXED_KEYS = [
  'justdo-theme-id',
  'justdo-pet-floating-position',
  'justdo-scheduled-task-result-preferences-v1',
] as const;
export const RENDERER_PREFERENCE_LIMITS = {
  entries: 128,
  valueBytes: 64 * 1024,
  totalBytes: 512 * 1024,
  browserKeys: 4096,
} as const;

export const isRendererPreferenceKey = (key: string): boolean =>
  (RENDERER_PREFERENCE_FIXED_KEYS as readonly string[]).includes(key) ||
  /^justdo:goal-completion-feedback:[a-zA-Z0-9:_-]{1,256}$/u.test(key);
