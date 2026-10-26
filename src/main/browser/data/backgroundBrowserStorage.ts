const activeProfiles = new Map<string, number>();
let clearing = false;

/** Counts shared-profile background resources before their first async boundary. */
export const acquireBackgroundBrowserStorage = (partition: string): (() => void) => {
  if (clearing) throw new Error('Browser data is being cleared. Retry after it finishes.');
  activeProfiles.set(partition, (activeProfiles.get(partition) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeProfiles.get(partition) ?? 1) - 1;
    if (remaining > 0) activeProfiles.set(partition, remaining);
    else activeProfiles.delete(partition);
  };
};

/** Only explicit user data-clear coordinates profile-wide storage mutation. */
export const reserveBackgroundBrowserStorageClear = (): (() => void) | null => {
  if (clearing || activeProfiles.size) return null;
  clearing = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearing = false;
  };
};
