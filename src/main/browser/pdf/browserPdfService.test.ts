import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchPdf, fromPartition } = vi.hoisted(() => {
  const fetchPdf = vi.fn();
  return { fetchPdf, fromPartition: vi.fn(() => ({ fetch: fetchPdf })) };
});

vi.mock('electron', () => ({ session: { fromPartition } }));

import {
  BROWSER_PDF_TIMEOUT_MS,
  isBrowserPdfLoadRequest,
  loadBrowserPdf,
  MAX_BROWSER_PDF_BYTES,
} from './browserPdfService';

describe('browserPdfService', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    fetchPdf.mockReset();
    fromPartition.mockClear();
  });

  it('accepts only safe web URLs and valid browser profiles', () => {
    expect(
      isBrowserPdfLoadRequest({
        requestId: 'test',
        url: 'https://example.test/report',
        profile: 'embedded',
      }),
    ).toBe(true);
    expect(isBrowserPdfLoadRequest({ url: 'file:///report.pdf', profile: 'embedded' })).toBe(false);
    expect(
      isBrowserPdfLoadRequest({ url: 'https://example.test/report', profile: '../escape' }),
    ).toBe(false);
  });

  it('loads PDF bytes through the selected browser partition', async () => {
    const data = new TextEncoder().encode('%PDF-1.7\nexample');
    fetchPdf.mockResolvedValue(
      new Response(data, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );

    const result = await loadBrowserPdf({
      requestId: 'test',
      url: 'https://example.test/report',
      profile: 'work',
    });

    expect(fromPartition).toHaveBeenCalledWith('persist:justdo-browser-profile-work');
    expect(fetchPdf).toHaveBeenCalledWith('https://example.test/report', {
      credentials: 'include',
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({ success: true, data });
  });

  it('rejects non-PDF and oversized responses', async () => {
    fetchPdf.mockResolvedValueOnce(
      new Response('not a PDF', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(
      loadBrowserPdf({
        requestId: 'test',
        url: 'https://example.test/report',
        profile: 'embedded',
      }),
    ).resolves.toEqual({ success: false, errorCode: 'not_pdf' });

    fetchPdf.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(MAX_BROWSER_PDF_BYTES + 1),
        },
      }),
    );
    await expect(
      loadBrowserPdf({
        requestId: 'test',
        url: 'https://example.test/large.pdf',
        profile: 'embedded',
      }),
    ).resolves.toEqual({ success: false, errorCode: 'too_large' });
  });

  it('cancels an oversized response without consuming its body', async () => {
    const cancel = vi.fn();
    fetchPdf.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'content-length': String(MAX_BROWSER_PDF_BYTES + 1) },
      }),
    );
    await expect(
      loadBrowserPdf({
        requestId: 'test',
        url: 'https://example.test/large.pdf',
        profile: 'embedded',
      }),
    ).resolves.toEqual({ success: false, errorCode: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'timeout'])('aborts pending downloads on %s', async reason => {
    vi.useFakeTimers();
    fetchPdf.mockImplementation(
      (_url, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        }),
    );
    const cancellation = new AbortController();
    const result = loadBrowserPdf(
      { requestId: 'test', url: 'https://example.test/slow.pdf', profile: 'embedded' },
      cancellation.signal,
    );
    if (reason === 'cancel') cancellation.abort();
    else await vi.advanceTimersByTimeAsync(BROWSER_PDF_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ success: false, errorCode: 'load_failed' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
