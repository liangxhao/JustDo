import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  fromPartition: vi.fn(() => ({ fetch: 'browser fetch' })),
  cacheController: new AbortController(),
}));
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition } }));
vi.mock('../data/browserDataImportService', () => ({
  readBrowserHistoryFavicon: mocks.read,
  updateBrowserHistoryFaviconData: mocks.save,
}));
vi.mock('./browserFavicon', () => ({ loadBrowserFavicon: mocks.load }));
vi.mock('./browserFaviconCache', () => ({
  getBrowserFaviconCacheSignal: () => mocks.cacheController.signal,
}));

import { loadBrowserHistoryFavicon } from './browserHistoryFavicon';

const dataUrl = 'data:image/png;base64,aWNvbg==';
const newerDataUrl = 'data:image/png;base64,bmV3';
const pageUrl = 'https://example.com/';
function deferredImage() {
  let resolve!: (image: string | undefined) => void;
  const promise = new Promise<string | undefined>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mocks.cacheController.abort();
  mocks.cacheController = new AbortController();
  vi.clearAllMocks();
  mocks.read.mockReturnValue({
    faviconUrl: 'https://cdn.example.com/icon.png',
    faviconDataUrl: '',
  });
  mocks.load.mockResolvedValue(dataUrl);
});
afterEach(() => vi.restoreAllMocks());

describe('recent history favicon loading', () => {
  it('reuses a stored image without network access', async () => {
    mocks.read.mockReturnValue({
      faviconUrl: 'https://cdn.example.com/icon.png',
      faviconDataUrl: dataUrl,
    });
    expect(await loadBrowserHistoryFavicon('https://example.com/')).toEqual({
      success: true,
      dataUrl,
    });
    expect(mocks.fromPartition).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('backfills older records through the browser partition, saving the result', async () => {
    expect(await loadBrowserHistoryFavicon('https://example.com/')).toEqual({
      success: true,
      dataUrl,
    });
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:justdo-browser');
    expect(mocks.load).toHaveBeenCalledWith(
      { fetch: 'browser fetch' },
      'https://example.com/',
      ['https://cdn.example.com/icon.png'],
      expect.any(AbortSignal),
    );
    expect(mocks.save).toHaveBeenCalledWith('https://example.com/', dataUrl);
  });

  it('retries the site fallback when a cached image cannot be decoded', async () => {
    mocks.read.mockReturnValue({
      faviconUrl: 'https://cdn.example.com/broken.png',
      faviconDataUrl: dataUrl,
    });
    expect(await loadBrowserHistoryFavicon('https://example.com/', true)).toEqual({
      success: true,
      dataUrl,
    });
    expect(mocks.load).toHaveBeenCalledWith(
      expect.anything(),
      'https://example.com/',
      [],
      expect.any(AbortSignal),
    );
  });

  it.each([
    null,
    {},
    'file:///private',
    'https://169.254.169.254/',
    'https://user:pass@example.com/',
  ])('rejects unsafe page references: %s', async url => {
    expect(await loadBrowserHistoryFavicon(url)).toEqual({
      success: false,
      errorCode: 'invalid_request',
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('refuses URLs that are not recorded in history', async () => {
    mocks.read.mockReturnValue(null);
    expect(await loadBrowserHistoryFavicon('https://missing.example/')).toEqual({
      success: false,
      errorCode: 'not_found',
    });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('merges concurrent requests and avoids recreating history deleted during loading', async () => {
    let resolve!: (dataUrl: string) => void;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const first = loadBrowserHistoryFavicon('https://example.com/');
    const second = loadBrowserHistoryFavicon('https://example.com/');
    expect(mocks.load).toHaveBeenCalledTimes(1);
    mocks.read.mockReturnValue(null);
    resolve(dataUrl);
    expect(await first).toEqual({ success: false, errorCode: 'not_found' });
    expect(await second).toEqual({ success: false, errorCode: 'not_found' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('returns a failure when no usable image is available', async () => {
    mocks.load.mockResolvedValue(undefined);
    expect(await loadBrowserHistoryFavicon('https://example.com/')).toEqual({
      success: false,
      errorCode: 'load_failed',
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('rejects pre-clear work and preserves deduplication for a new request after clearing', async () => {
    const oldImage = deferredImage();
    const newImage = deferredImage();
    mocks.load.mockReturnValueOnce(oldImage.promise).mockReturnValueOnce(newImage.promise);
    const oldRequest = loadBrowserHistoryFavicon(pageUrl);
    const oldSignal = mocks.load.mock.calls[0][3] as AbortSignal;
    mocks.cacheController.abort();
    mocks.cacheController = new AbortController();
    const newRequest = loadBrowserHistoryFavicon(pageUrl);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(oldSignal.aborted).toBe(true);
    oldImage.resolve(dataUrl);
    expect(await oldRequest).toEqual({ success: false, errorCode: 'load_failed' });
    expect(mocks.save).not.toHaveBeenCalled();
    const mergedRequest = loadBrowserHistoryFavicon(pageUrl);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    newImage.resolve(newerDataUrl);
    expect(await newRequest).toEqual({ success: true, dataUrl: newerDataUrl });
    expect(await mergedRequest).toEqual({ success: true, dataUrl: newerDataUrl });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(pageUrl, newerDataUrl);
  });

  it.each([dataUrl, undefined])(
    'prefers a newer native image saved during backfill, even when loading returned %s',
    async loadedImage => {
      const image = deferredImage();
      mocks.load.mockReturnValueOnce(image.promise);
      const result = loadBrowserHistoryFavicon(pageUrl);
      mocks.read.mockReturnValue({
        faviconUrl: 'https://cdn.example.com/new.png',
        faviconDataUrl: newerDataUrl,
      });
      image.resolve(loadedImage);
      expect(await result).toEqual({ success: true, dataUrl: newerDataUrl });
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it('discards an old backfill when its source changed without a replacement image', async () => {
    const image = deferredImage();
    mocks.load.mockReturnValueOnce(image.promise);
    const result = loadBrowserHistoryFavicon(pageUrl);
    mocks.read.mockReturnValue({
      faviconUrl: 'https://cdn.example.com/new.png',
      faviconDataUrl: '',
    });
    image.resolve(dataUrl);
    expect(await result).toEqual({ success: false, errorCode: 'load_failed' });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('queues a fifth distinct page and starts it when a browser request finishes', async () => {
    const images = Array.from({ length: 4 }, () => deferredImage());
    images.forEach(image => mocks.load.mockReturnValueOnce(image.promise));
    const requests = Array.from({ length: 5 }, (_, index) =>
      loadBrowserHistoryFavicon(`https://example.com/${index}`),
    );
    expect(mocks.load).toHaveBeenCalledTimes(4);
    images[0].resolve(dataUrl);
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(5));
    images.slice(1).forEach(image => image.resolve(dataUrl));
    expect(await Promise.all(requests)).toEqual(
      Array.from({ length: 5 }, () => ({ success: true, dataUrl })),
    );
  });

  it('bounds admitted requests to sixteen including the four active requests', async () => {
    const images = Array.from({ length: 4 }, () => deferredImage());
    images.forEach(image => mocks.load.mockReturnValueOnce(image.promise));
    const requests = Array.from({ length: 16 }, (_, index) =>
      loadBrowserHistoryFavicon(`https://example.com/${index}`),
    );
    expect(mocks.load).toHaveBeenCalledTimes(4);
    expect(await loadBrowserHistoryFavicon('https://example.com/overflow')).toEqual({
      success: false,
      errorCode: 'load_failed',
    });
    expect(mocks.load).toHaveBeenCalledTimes(4);
    images.forEach(image => image.resolve(dataUrl));
    expect(await Promise.all(requests)).toEqual(
      Array.from({ length: 16 }, () => ({ success: true, dataUrl })),
    );
    expect(mocks.load).toHaveBeenCalledTimes(16);
  });

  it.each(['clear', 'deadline'])(
    'expires queued work on %s without starting its network load',
    async reason => {
      const images = Array.from({ length: 4 }, () => deferredImage());
      images.forEach(image => mocks.load.mockReturnValueOnce(image.promise));
      const requests = Array.from({ length: 4 }, (_, index) =>
        loadBrowserHistoryFavicon(`https://example.com/${index}`),
      );
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
      const queued = loadBrowserHistoryFavicon('https://example.com/queued');
      if (reason === 'clear') {
        mocks.cacheController.abort();
        mocks.cacheController = new AbortController();
      } else deadline.abort();
      expect(await queued).toEqual({ success: false, errorCode: 'load_failed' });
      expect(mocks.load).toHaveBeenCalledTimes(4);
      images.forEach(image => image.resolve(dataUrl));
      await Promise.all(requests);
      expect(mocks.load).toHaveBeenCalledTimes(4);
    },
  );
});
