import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
} from '@heroicons/react/24/outline';
import type { BrowserAgentProfile } from '@shared/browser/browser';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type BrowserPdfViewerProps = {
  url: string;
  profile: BrowserAgentProfile;
  active?: boolean;
  onNotPdf?: () => void;
  onZoomChange?: (zoom: number) => void;
};

export type BrowserPdfViewerHandle = {
  setZoom: (zoom: number) => void;
  reload: () => void;
};

type BrowserPdfPageProps = {
  active: boolean;
  availableWidth: number;
  document: PDFDocumentProxy;
  pageNumber: number;
  scrollRoot: HTMLDivElement | null;
  zoom: number;
  onRenderError: () => void;
};

const BrowserPdfPage = ({
  active,
  availableWidth,
  document,
  pageNumber,
  scrollRoot,
  zoom,
  onRenderError,
}: BrowserPdfPageProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspectRatio, setAspectRatio] = useState(792 / 612);
  const [shouldRender, setShouldRender] = useState(pageNumber <= 2);
  const pageWidth = availableWidth * zoom;
  const pageHeight = pageWidth * aspectRatio;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === 'undefined') {
      setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => setShouldRender(entries.some(entry => entry.isIntersecting)),
      { root: scrollRoot, rootMargin: '1200px 0px' },
    );
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !shouldRender || !active) {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      return;
    }
    let disposed = false;
    let renderTask: RenderTask | null = null;
    void document
      .getPage(pageNumber)
      .then(page => {
        if (disposed) return;
        const baseViewport = page.getViewport({ scale: 1 });
        setAspectRatio(baseViewport.height / baseViewport.width);
        const viewport = page.getViewport({ scale: pageWidth / baseViewport.width });
        // Keep unusually tall pages and large panels below Chromium's canvas limits.
        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(16_777_216 / (viewport.width * viewport.height)),
          16_384 / Math.max(viewport.width, viewport.height),
        );
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) throw new Error('Canvas is unavailable.');
        renderTask = page.render({
          canvas,
          canvasContext,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        return renderTask.promise;
      })
      .catch(renderError => {
        if (
          !disposed &&
          (renderError as { name?: string }).name !== 'RenderingCancelledException'
        ) {
          onRenderError();
        }
      });
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  }, [active, document, onRenderError, pageNumber, pageWidth, shouldRender]);

  return (
    <div
      ref={wrapperRef}
      data-pdf-page-number={pageNumber}
      className="relative mx-auto shrink-0 bg-white shadow-[0_2px_8px_rgba(0,0,0,0.45)]"
      style={{ width: pageWidth, height: pageHeight }}
    >
      <canvas
        ref={canvasRef}
        aria-label={`${i18nService.t('browserPdfPage')} ${pageNumber}`}
        className={`block bg-white ${shouldRender ? '' : 'invisible'}`}
      />
    </div>
  );
};

const BrowserPdfViewer = forwardRef<BrowserPdfViewerHandle, BrowserPdfViewerProps>(
  ({ url, profile, active = true, onNotPdf, onZoomChange }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
    const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
    const [pageNumber, setPageNumber] = useState(1);
    const pageNumberRef = useRef(1);
    pageNumberRef.current = pageNumber;
    const [zoom, setZoom] = useState(1);
    const [availableWidth, setAvailableWidth] = useState(480);
    const [error, setError] = useState<string | null>(null);
    const [reloadVersion, setReloadVersion] = useState(0);
    const onNotPdfRef = useRef(onNotPdf);
    onNotPdfRef.current = onNotPdf;
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;

    useImperativeHandle(
      ref,
      () => ({
        setZoom: value => setZoom(Math.min(2, Math.max(0.5, value))),
        reload: () => setReloadVersion(value => value + 1),
      }),
      [],
    );

    useEffect(() => {
      if (active) onZoomChangeRef.current?.(zoom);
    }, [active, zoom]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const updateWidth = () => setAvailableWidth(Math.max(240, container.clientWidth - 32));
      updateWidth();
      const observer = new ResizeObserver(updateWidth);
      observer.observe(container);
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      let disposed = false;
      let loadingTask: PDFDocumentLoadingTask | null = null;
      const requestId = crypto.randomUUID();
      setDocument(null);
      setPageNumber(1);
      setError(null);
      void window.electron.browser
        .loadPdf({ url, profile, requestId })
        .then(async result => {
          // IPC may finish after the tab closes. Never create a worker for that response.
          if (disposed) return;
          if (!result.success) {
            if (result.errorCode === 'not_pdf' && onNotPdfRef.current) {
              onNotPdfRef.current();
              return;
            }
            throw new Error(result.errorCode);
          }
          const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href;
          loadingTask = getDocument({
            data: new Uint8Array(result.data),
            cMapUrl: `${assetBase}cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${assetBase}standard_fonts/`,
            wasmUrl: `${assetBase}wasm/`,
            iccUrl: `${assetBase}iccs/`,
            // Electron permits bundled file: resources in workers. PDF.js's
            // browser-only URL heuristic otherwise disables ICC color decoding.
            useWorkerFetch: true,
          });
          const loadedDocument = await loadingTask.promise;
          if (disposed) return;
          setDocument(loadedDocument);
        })
        .catch(reason => {
          if (!disposed)
            setError(
              i18nService.t(
                reason instanceof Error && reason.message === 'too_large'
                  ? 'browserPdfTooLarge'
                  : 'browserPdfLoadFailed',
              ),
            );
        });
      return () => {
        disposed = true;
        window.electron.browser.cancelPdf(requestId);
        if (loadingTask) void loadingTask.destroy().catch(() => {});
      };
    }, [profile, reloadVersion, url]);

    const handleRenderError = useCallback(
      () => setError(i18nService.t('browserPdfRenderFailed')),
      [],
    );

    const scrollToPage = useCallback(
      (nextPage: number, behavior: ScrollBehavior = 'smooth') => {
        if (!scrollRoot || !document) return;
        const boundedPage = Math.min(document.numPages, Math.max(1, nextPage));
        const page = scrollRoot.querySelector<HTMLElement>(
          `[data-pdf-page-number="${boundedPage}"]`,
        );
        if (!page) return;
        const top = Math.max(
          0,
          scrollRoot.scrollTop +
            page.getBoundingClientRect().top -
            scrollRoot.getBoundingClientRect().top -
            16,
        );
        if (typeof scrollRoot.scrollTo === 'function') scrollRoot.scrollTo({ top, behavior });
        else scrollRoot.scrollTop = top;
        setPageNumber(boundedPage);
      },
      [document, scrollRoot],
    );

    const updateCurrentPageFromScroll = useCallback(() => {
      if (!scrollRoot) return;
      const rootTop = scrollRoot.getBoundingClientRect().top + 16;
      const pages = [...scrollRoot.querySelectorAll<HTMLElement>('[data-pdf-page-number]')];
      const visiblePage =
        pages.find(page => page.getBoundingClientRect().bottom > rootTop) ??
        pages[pages.length - 1];
      const nextPage = Number(visiblePage?.dataset.pdfPageNumber);
      if (Number.isInteger(nextPage) && nextPage > 0) setPageNumber(nextPage);
    }, [scrollRoot]);

    useEffect(() => {
      if (!document) return;
      scrollToPage(pageNumberRef.current, 'auto');
    }, [document, scrollToPage, zoom]);

    const buttonClass =
      'inline-flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-35';

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 z-[4] flex min-h-0 flex-col bg-[#525659]"
        data-browser-pdf-viewer
      >
        <div className="flex h-10 shrink-0 items-center justify-center gap-2 bg-[#323639] px-2 text-xs text-white shadow-md">
          <button
            type="button"
            className={buttonClass}
            disabled={!document || pageNumber <= 1}
            aria-label={i18nService.t('browserPdfPreviousPage')}
            onClick={() => scrollToPage(pageNumber - 1)}
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </button>
          <span className="min-w-16 text-center tabular-nums">
            {document ? `${pageNumber} / ${document.numPages}` : '—'}
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={!document || pageNumber >= document.numPages}
            aria-label={i18nService.t('browserPdfNextPage')}
            onClick={() => scrollToPage(pageNumber + 1)}
          >
            <ChevronRightIcon className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-white/25" />
          <button
            type="button"
            className={buttonClass}
            disabled={!document || zoom <= 0.5}
            aria-label={i18nService.t('browserPdfZoomOut')}
            onClick={() => setZoom(current => Math.max(0.5, Math.round((current - 0.1) * 10) / 10))}
          >
            <MagnifyingGlassMinusIcon className="h-4 w-4" />
          </button>
          <span className="min-w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={buttonClass}
            disabled={!document || zoom >= 2}
            aria-label={i18nService.t('browserPdfZoomIn')}
            onClick={() => setZoom(current => Math.min(2, Math.round((current + 0.1) * 10) / 10))}
          >
            <MagnifyingGlassPlusIcon className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={setScrollRoot}
          className="relative min-h-0 flex-1 overflow-auto p-4 text-center"
          onScroll={updateCurrentPageFromScroll}
        >
          {!document && !error && (
            <div className="flex h-full items-center justify-center text-sm text-secondary">
              {i18nService.t('browserPdfLoading')}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="flex h-full flex-col items-center justify-center gap-3 px-4 text-sm text-red-300"
            >
              {error}
              <button
                type="button"
                className="rounded border border-white/30 px-3 py-1 text-white"
                onClick={() => setReloadVersion(value => value + 1)}
              >
                {i18nService.t('browserPdfRetry')}
              </button>
            </div>
          )}
          {document && !error && (
            <div className="flex min-w-max flex-col gap-4 pb-4">
              {Array.from({ length: document.numPages }, (_, index) => (
                <BrowserPdfPage
                  active={active}
                  key={index + 1}
                  availableWidth={availableWidth}
                  document={document}
                  pageNumber={index + 1}
                  scrollRoot={scrollRoot}
                  zoom={zoom}
                  onRenderError={handleRenderError}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },
);
BrowserPdfViewer.displayName = 'BrowserPdfViewer';

export default BrowserPdfViewer;
