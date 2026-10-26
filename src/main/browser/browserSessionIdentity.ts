import path from 'path';

export const browserSessionStorageKey = (browserSession: Electron.Session): string | null => {
  if (!browserSession.storagePath) return null;
  const absolute = path.resolve(browserSession.storagePath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

/** Electron can expose different Session wrappers for one persistent partition. */
export const isSameBrowserSession = (left: Electron.Session, right: Electron.Session): boolean =>
  left === right ||
  (browserSessionStorageKey(left) !== null &&
    browserSessionStorageKey(left) === browserSessionStorageKey(right));
