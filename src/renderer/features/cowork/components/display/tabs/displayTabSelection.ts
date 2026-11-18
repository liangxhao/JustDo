import { BROWSER_DISPLAY_TAB_PREFIX } from './displayTabIds';

/** The visible workspace tab also selects the browser guest it displays. */
export const getBrowserPanelTargetId = (
  displayTabId: string | null,
  retainedTargetId: string | null,
): string | null =>
  displayTabId?.startsWith(BROWSER_DISPLAY_TAB_PREFIX)
    ? displayTabId.slice(BROWSER_DISPLAY_TAB_PREFIX.length)
    : retainedTargetId;

export const getAdjacentDisplayTabId = (
  tabIds: readonly string[],
  closingId: string,
): string | null => {
  const closingIndex = tabIds.indexOf(closingId);
  if (closingIndex < 0) return null;
  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? null;
};
