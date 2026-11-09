import { type Dispatch, type SetStateAction, useLayoutEffect } from 'react';

/** Commit the displayed fallback to the owning session before background tabs arrive. */
export function useDisplayTabSelection(
  runtimeId: string,
  tabIds: readonly string[],
  preferredTabId: string | null,
  setPreferredTabId: Dispatch<SetStateAction<string | null>>,
): string | null {
  const selectedTabId =
    preferredTabId && tabIds.includes(preferredTabId)
      ? preferredTabId
      : (tabIds[tabIds.length - 1] ?? null);
  useLayoutEffect(() => {
    if (preferredTabId !== selectedTabId) {
      setPreferredTabId(current => current === preferredTabId ? selectedTabId : current);
    }
  }, [runtimeId, preferredTabId, selectedTabId, setPreferredTabId]);
  return selectedTabId;
}
