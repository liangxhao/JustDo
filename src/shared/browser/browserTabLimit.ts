export const DEFAULT_BROWSER_TAB_LIMIT = 20;
export const MIN_BROWSER_TAB_LIMIT = 1;
export const MAX_BROWSER_TAB_LIMIT = 50;

export function normalizeBrowserTabLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BROWSER_TAB_LIMIT;
  return Math.min(MAX_BROWSER_TAB_LIMIT, Math.max(MIN_BROWSER_TAB_LIMIT, Math.round(value)));
}
