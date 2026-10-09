// Invalidates work started before browser history or image caches are cleared.
let cacheController = new AbortController();

export const getBrowserFaviconCacheSignal = (): AbortSignal => cacheController.signal;

export const invalidateBrowserFaviconCache = (): void => {
  cacheController.abort();
  cacheController = new AbortController();
};
