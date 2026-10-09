// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BrowserPdfViewer from './BrowserPdfViewer';

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions: {} }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

const loadPdf = vi.fn();
const cancelPdf = vi.fn();
const destroy = vi.fn();
const url = 'https://example.test/report.pdf';
const pdfDocument = {
  numPages: 3,
  getPage: vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { loadPdf, cancelPdf } },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  loadPdf.mockResolvedValue({ success: true, data: new TextEncoder().encode('%PDF-1.7') });
  destroy.mockResolvedValue(undefined);
  getDocument.mockReturnValue({ promise: Promise.resolve(pdfDocument), destroy });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BrowserPdfViewer lifecycle and navigation', () => {
  it('cancels an unmounted request without creating a worker when IPC finishes late', async () => {
    let resolve!: (result: unknown) => void;
    loadPdf.mockReturnValue(
      new Promise(result => {
        resolve = result;
      }),
    );
    const { unmount } = render(<BrowserPdfViewer url={url} profile="embedded" />);
    const request = loadPdf.mock.calls[0][0];
    unmount();
    expect(cancelPdf).toHaveBeenCalledWith(request.requestId);
    await act(async () => {
      resolve({ success: true, data: new Uint8Array([1]) });
    });
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('destroys an in-progress parsing worker on unmount', async () => {
    getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy });
    const { unmount } = render(<BrowserPdfViewer url={url} profile="embedded" />);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('loads bundled font, CMap and decoder assets and retains the document while inactive', async () => {
    const { rerender } = render(<BrowserPdfViewer url={url} profile="embedded" />);
    await screen.findByText('1 / 3');
    const options = getDocument.mock.calls[0][0];
    expect(options).toMatchObject({
      cMapUrl: expect.stringMatching(/\/pdfjs\/cmaps\/$/u),
      cMapPacked: true,
      standardFontDataUrl: expect.stringMatching(/\/pdfjs\/standard_fonts\/$/u),
      wasmUrl: expect.stringMatching(/\/pdfjs\/wasm\/$/u),
      iccUrl: expect.stringMatching(/\/pdfjs\/iccs\/$/u),
      useWorkerFetch: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'browserPdfZoomIn' }));
    expect(screen.getByText('110%')).toBeTruthy();
    rerender(<BrowserPdfViewer url={url} profile="embedded" active={false} />);
    rerender(<BrowserPdfViewer url={url} profile="embedded" active />);
    expect(loadPdf).toHaveBeenCalledTimes(1);
    expect(screen.getByText('110%')).toBeTruthy();
  });

  it('positions a page relative to the scroller, excluding the toolbar and window position', async () => {
    const { container } = render(<BrowserPdfViewer url={url} profile="embedded" />);
    await screen.findByText('1 / 3');
    const page = container.querySelector<HTMLElement>('[data-pdf-page-number="2"]')!;
    const scroller = page.parentElement!.parentElement!;
    scroller.scrollTop = 80;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, 'scrollTo', { configurable: true, value: scrollTo });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 140 } as DOMRect);
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ top: 656 } as DOMRect);
    Object.defineProperty(page, 'offsetTop', { configurable: true, value: 636 });
    fireEvent.click(screen.getByRole('button', { name: 'browserPdfNextPage' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 580, behavior: 'smooth' });
  });

  it('offers retry for oversized downloads and returns HTML responses to the browser', async () => {
    loadPdf.mockResolvedValueOnce({ success: false, errorCode: 'too_large' });
    const onNotPdf = vi.fn();
    render(<BrowserPdfViewer url={url} profile="embedded" onNotPdf={onNotPdf} />);
    expect((await screen.findByRole('alert')).textContent).toContain('browserPdfTooLarge');
    loadPdf.mockResolvedValueOnce({ success: false, errorCode: 'not_pdf' });
    fireEvent.click(screen.getByRole('button', { name: 'browserPdfRetry' }));
    await waitFor(() => expect(onNotPdf).toHaveBeenCalledTimes(1));
    expect(loadPdf).toHaveBeenCalledTimes(2);
  });
});
