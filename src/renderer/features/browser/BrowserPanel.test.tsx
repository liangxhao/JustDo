// @vitest-environment jsdom

import {
  BROWSER_AGENT_PANEL_TARGET_ID,
  BROWSER_GUEST_ZOOM_CHANNEL,
  type BrowserAgentInteractionState,
  type BrowserAnnotationDraft,
  type BrowserLocalHtmlPreviewResult,
  type BrowserPanelTab,
} from '@shared/browser/browser';
import { BrowserRecordingChannel } from '@shared/browser/browserRecording';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ComponentProps, StrictMode, useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import BrowserPanel, { type BrowserPanelHandle, getBrowserTabAddress } from './BrowserPanel';
import { promoteBrowserPanelTabs } from './browserPanelRetention';

const { getPdfDocument } = vi.hoisted(() => ({ getPdfDocument: vi.fn() }));

vi.mock('pdfjs-dist', () => ({
  getDocument: getPdfDocument,
  GlobalWorkerOptions: {},
}));

vi.mock('@/features/cowork/components/composer/LocalSpeechInputButton', () => ({
  LocalSpeechInputButton: () => null,
}));

type PanelOpenTabListener = (event: {
  url: string;
  openerGuestId?: number;
  errorCode?: 'post-navigation-blocked';
}) => void;
type PanelPdfDetectedListener = (event: { url: string; guestId: number }) => void;
type PanelHttpAuthListener = (event: {
  id: string;
  guestId: number;
  host: string;
  port: number;
  realm: string;
  scheme: string;
}) => void;

let panelOpenTabListener: PanelOpenTabListener | null = null;
let panelPdfDetectedListener: PanelPdfDetectedListener | null = null;
let panelHttpAuthListener: PanelHttpAuthListener | null = null;
let panelHttpAuthDismissedListener: ((event: { id: string; guestId: number }) => void) | null =
  null;
let agentInteractionListener:
  | ((event: { sessionId: string; targetId: string; busy: boolean; operationId?: string }) => void)
  | null = null;
let nextId = 0;
const loadUrl = vi.fn(async function (this: HTMLElement, url: string) {
  this.setAttribute('src', url);
});
const reload = vi.fn();
const setAudioMuted = vi.fn();
const findInPage = vi.fn(() => 1);
const stopFind = vi.fn();
const printPage = vi.fn((_options, callback) => callback?.(true));
const setZoomFactor = vi.fn();
const openDevTools = vi.fn();
const guestSend = vi.fn(function (this: HTMLElement, channel: string, requestId?: unknown) {
  if (channel === BrowserRecordingChannel.Control) {
    this.dispatchEvent(
      Object.assign(new Event('ipc-message'), {
        channel: BrowserRecordingChannel.Ready,
        args: [{ ...(requestId as object), documentId: 'recording-document' }],
      }),
    );
    return;
  }
  if (channel !== 'justdo-browser-inspect') return;
  const event = new Event('ipc-message');
  Object.assign(event, {
    channel: 'justdo-browser-inspect-result',
    args: [requestId, [inspectedElement]],
  });
  this.dispatchEvent(event);
});
const listImportSources = vi.fn().mockResolvedValue({
  success: true,
  sources: [{ id: 'Default', browser: 'chrome', name: 'Google Chrome · Profile 1' }],
});
const importData = vi.fn().mockResolvedValue({
  success: true,
  imported: { passwords: 2, cookies: 3, history: 4 },
  skippedAppBound: { passwords: 0, cookies: 0 },
});
const getClearDataSummary = vi.fn().mockResolvedValue({
  success: true,
  summary: {
    history: 12,
    latestHistoryOrigin: 'example.com',
    cookieSites: 3,
    downloads: 2,
    autofill: 1,
  },
});
const clearBrowsingData = vi.fn().mockResolvedValue({ success: true });
const createLocalHtmlPreview = vi.fn();
const loadPdf = vi.fn().mockResolvedValue({ success: false, errorCode: 'load_failed' });
const openExternal = vi.fn().mockResolvedValue({ success: true });
const openLocalHtmlExternal = vi.fn().mockResolvedValue({ success: true });
const registerAgentTab = vi.fn();
const unregisterAgentTab = vi.fn();
const setAgentActiveTab = vi.fn();
const setUserInteractionState = vi.fn();
const acknowledgeAgentInteraction = vi.fn();
const respondToPanelHttpAuth = vi.fn();
const inspectedElement = {
  tag: 'a',
  id: 'docs',
  classes: ['link'],
  role: 'link',
  name: 'Documentation',
  rect: { x: 20, y: 20, width: 100, height: 24 },
  focusable: true,
  cssPath: 'main > a#docs',
};

const defineWebviewMethod = (name: string, value: unknown) => {
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    writable: true,
    value,
  });
};

const useCompatibilityPdfViewer = () => {
  fireEvent.click(screen.getByLabelText('More browser options'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Try compatibility PDF viewer' }));
};

function BrowserPanelHarness({
  draftKey = '__home__',
  embedded = false,
  isOpen = true,
  onTabsChange,
  onRecordingRetentionChange,
  onAddAnnotation = () => true,
  onRequestBrowserSettings,
  panelRef,
  initialTabs,
  retainedTargetIds,
  agentInteractionStates,
  onStopTask,
  onContinueTask,
}: {
  draftKey?: string;
  embedded?: boolean;
  isOpen?: boolean;
  onTabsChange?: ComponentProps<typeof BrowserPanel>['onTabsChange'];
  onRecordingRetentionChange?: ComponentProps<typeof BrowserPanel>['onRecordingRetentionChange'];
  onAddAnnotation?: ComponentProps<typeof BrowserPanel>['onAddAnnotation'];
  onRequestBrowserSettings?: (page?: 'history' | 'downloads') => void;
  panelRef?: (instance: BrowserPanelHandle | null) => void;
  initialTabs?: readonly BrowserPanelTab[];
  retainedTargetIds?: readonly string[];
  agentInteractionStates?: readonly BrowserAgentInteractionState[];
  onStopTask?: ComponentProps<typeof BrowserPanel>['onStopTask'];
  onContinueTask?: ComponentProps<typeof BrowserPanel>['onContinueTask'];
}) {
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  return (
    <BrowserPanel
      ref={panelRef}
      draftKey={draftKey}
      isOpen={isOpen}
      width={520}
      activeTargetId={activeTargetId}
      onClose={vi.fn()}
      onWidthChange={vi.fn()}
      onActiveTargetChange={setActiveTargetId}
      onAddAnnotation={onAddAnnotation}
      onTabsChange={onTabsChange}
      onRecordingRetentionChange={onRecordingRetentionChange}
      onRequestBrowserSettings={onRequestBrowserSettings}
      initialTabs={initialTabs}
      retainedTargetIds={retainedTargetIds}
      agentInteractionStates={agentInteractionStates}
      onStopTask={onStopTask}
      onContinueTask={onContinueTask}
      embedded={embedded}
    />
  );
}

describe('BrowserPanel embedded webview', () => {
  it('keeps the first tab opened by a parent effect during initial mount', () => {
    function FirstOpen() {
      const panel = useRef<BrowserPanelHandle | null>(null);
      const pending = useRef(true);
      const [tabs, setTabs] = useState<BrowserPanelTab[]>([]);
      useEffect(() => {
        if (!pending.current || !panel.current) return;
        pending.current = false;
        panel.current.openTab();
      }, []);
      return (
        <BrowserPanelHarness
          panelRef={instance => {
            panel.current = instance;
          }}
          initialTabs={tabs}
          retainedTargetIds={tabs.map(tab => tab.targetId)}
          onTabsChange={setTabs}
        />
      );
    }
    const { container } = render(
      <StrictMode>
        <FirstOpen />
      </StrictMode>,
    );
    expect(container.querySelectorAll('webview')).toHaveLength(1);
  });

  beforeEach(() => {
    panelOpenTabListener = null;
    panelPdfDetectedListener = null;
    panelHttpAuthListener = null;
    agentInteractionListener = null;
    loadUrl.mockClear();
    reload.mockClear();
    setAudioMuted.mockClear();
    findInPage.mockClear();
    stopFind.mockClear();
    printPage.mockClear();
    setZoomFactor.mockClear();
    openDevTools.mockClear();
    guestSend.mockClear();
    listImportSources.mockClear();
    importData.mockClear();
    getClearDataSummary.mockClear();
    clearBrowsingData.mockClear();
    createLocalHtmlPreview.mockReset();
    loadPdf.mockClear();
    getPdfDocument.mockReset();
    openExternal.mockClear();
    openLocalHtmlExternal.mockClear();
    registerAgentTab.mockClear();
    unregisterAgentTab.mockClear();
    setAgentActiveTab.mockClear();
    setUserInteractionState.mockClear();
    acknowledgeAgentInteraction.mockClear();
    respondToPanelHttpAuth.mockClear();
    i18nService.setLanguage('en', { persist: false });

    vi.stubGlobal('crypto', {
      randomUUID: vi.fn(() => `browser-tab-${++nextId}`),
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    defineWebviewMethod('canGoBack', () => false);
    defineWebviewMethod('canGoForward', () => false);
    defineWebviewMethod('getTitle', () => '');
    defineWebviewMethod('getURL', function (this: HTMLElement) {
      return this.getAttribute('src') ?? 'about:blank';
    });
    defineWebviewMethod('getWebContentsId', () => 7);
    defineWebviewMethod('goBack', vi.fn());
    defineWebviewMethod('goForward', vi.fn());
    defineWebviewMethod('loadURL', loadUrl);
    defineWebviewMethod('reload', reload);
    defineWebviewMethod('isAudioMuted', () => false);
    defineWebviewMethod('setAudioMuted', setAudioMuted);
    defineWebviewMethod('findInPage', findInPage);
    defineWebviewMethod('stopFind', stopFind);
    defineWebviewMethod('print', printPage);
    defineWebviewMethod('getZoomFactor', () => 1);
    defineWebviewMethod('setZoomFactor', setZoomFactor);
    defineWebviewMethod('openDevTools', openDevTools);
    defineWebviewMethod('send', guestSend);
    defineWebviewMethod('capturePage', vi.fn());

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        browser: {
          setRecordingLease: vi.fn().mockResolvedValue(true),
          createLocalHtmlPreview,
          loadPdf,
          registerAgentTab,
          unregisterAgentTab,
          setAgentActiveTab,
          setUserInteractionState,
          acknowledgeAgentInteraction,
          onPanelOpenTab: (listener: PanelOpenTabListener) => {
            panelOpenTabListener = listener;
            return () => {
              if (panelOpenTabListener === listener) panelOpenTabListener = null;
            };
          },
          onPanelPdfDetected: (listener: PanelPdfDetectedListener) => {
            panelPdfDetectedListener = listener;
            return () => {
              if (panelPdfDetectedListener === listener) panelPdfDetectedListener = null;
            };
          },
          onPanelHttpAuthRequest: (listener: PanelHttpAuthListener) => {
            panelHttpAuthListener = listener;
            return () => {
              if (panelHttpAuthListener === listener) panelHttpAuthListener = null;
            };
          },
          respondToPanelHttpAuth,
          onPanelHttpAuthDismissed: (listener: typeof panelHttpAuthDismissedListener) => {
            panelHttpAuthDismissedListener = listener;
            return () => {
              panelHttpAuthDismissedListener = null;
            };
          },
          cancelPdf: vi.fn(),
          onAgentInteractionState: (
            listener: (event: {
              sessionId: string;
              targetId: string;
              busy: boolean;
              operationId?: string;
            }) => void,
          ) => {
            agentInteractionListener = listener;
            return () => {
              if (agentInteractionListener === listener) agentInteractionListener = null;
            };
          },
          listImportSources,
          importData,
          getClearDataSummary,
          clearBrowsingData,
        },
        shell: {
          openExternal,
          openLocalHtmlExternal,
        },
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('keeps the agent tab registration stable across ordinary rerenders', async () => {
    const view = render(<BrowserPanelHarness />);
    await waitFor(() => expect(registerAgentTab).toHaveBeenCalledTimes(1));
    const unregisterCount = unregisterAgentTab.mock.calls.length;

    view.rerender(<BrowserPanelHarness isOpen={false} />);

    expect(registerAgentTab).toHaveBeenCalledTimes(1);
    expect(unregisterAgentTab).toHaveBeenCalledTimes(unregisterCount);
  });

  it.each(['canGoBack', 'canGoForward'])(
    'survives an unavailable guest during %s and recovers on dom-ready',
    method => {
      let available = true;
      defineWebviewMethod(method, () => {
        if (!available) throw new Error('The WebView must be attached to the DOM');
        return true;
      });
      const view = render(<BrowserPanelHarness draftKey="navigation-draft" />);
      const webview = view.container.querySelector('webview')!;
      const label = i18nService.t(
        method === 'canGoBack' ? 'browserPanelBack' : 'browserPanelForward',
      );
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(true);
      fireEvent(webview, new Event('dom-ready'));
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(false);

      available = false;
      view.rerender(<BrowserPanelHarness draftKey="navigation-session" />);
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(true);

      available = true;
      fireEvent(webview, new Event('dom-ready'));
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(false);
      const navigate = vi.fn(() => {
        throw new Error('guest detached after render');
      });
      defineWebviewMethod(method === 'canGoBack' ? 'goBack' : 'goForward', navigate);
      fireEvent.click(screen.getByLabelText(label));
      expect(navigate).toHaveBeenCalledOnce();
      expect(view.container.querySelector('webview')).toBe(webview);
    },
  );

  it('registers a delayed webview with the promoted session instead of a stale draft key', async () => {
    let guestReady = false;
    defineWebviewMethod('getWebContentsId', () => {
      if (!guestReady) throw new Error('guest is not ready');
      return 7;
    });
    const view = render(<BrowserPanelHarness draftKey="home-draft" />);
    expect(registerAgentTab).not.toHaveBeenCalled();

    view.rerender(<BrowserPanelHarness draftKey="canonical-session" />);
    guestReady = true;
    fireEvent(view.container.querySelector('webview')!, new Event('dom-ready'));

    await waitFor(() => expect(registerAgentTab).toHaveBeenCalledTimes(1));
    expect(registerAgentTab).toHaveBeenCalledWith({
      sessionId: 'canonical-session',
      targetId: expect.any(String),
      webContentsId: 7,
      profile: 'embedded',
    });
    expect(
      registerAgentTab.mock.calls.some(([registration]) => registration.sessionId === 'home-draft'),
    ).toBe(false);
  });

  it('creates and registers an agent-provided tab on the first render', async () => {
    const initialTab: BrowserPanelTab = {
      id: 'embedded-agent-tab',
      targetId: 'embedded-agent-tab',
      title: '',
      url: 'https://www.hao123.com/',
    };
    const { container } = render(
      <BrowserPanelHarness
        draftKey="agent-session"
        embedded
        initialTabs={[initialTab]}
        retainedTargetIds={[initialTab.targetId]}
      />,
    );

    const webview = container.querySelector('webview');
    expect(webview?.getAttribute('src')).toBe(initialTab.url);
    expect(webview?.getAttribute('plugins')).toBe('true');
    await waitFor(() =>
      expect(registerAgentTab).toHaveBeenCalledWith({
        sessionId: 'agent-session',
        targetId: initialTab.targetId,
        webContentsId: 7,
        profile: 'embedded',
      }),
    );
  });

  it('uses Chromium for PDF by default and switches to compatibility mode only on request', async () => {
    const url = 'https://arxiv.org/pdf/2609.20859';
    const { container } = render(
      <BrowserPanelHarness
        draftKey="pdf-arxiv-session"
        initialTabs={[{ id: 'pdf-tab', targetId: 'pdf-tab', title: '', url }]}
        retainedTargetIds={['pdf-tab']}
      />,
    );

    expect(container.querySelector('webview')?.getAttribute('src')).toBe(url);
    expect(container.querySelector('[data-browser-pdf-viewer]')).toBeNull();
    expect(loadPdf).not.toHaveBeenCalled();
    useCompatibilityPdfViewer();
    await waitFor(() => expect(container.querySelector('[data-browser-pdf-viewer]')).toBeTruthy());
    expect(loadPdf).toHaveBeenCalledWith(expect.objectContaining({ url, profile: 'embedded' }));
    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use browser PDF viewer' }));
    expect(container.querySelector('[data-browser-pdf-viewer]')).toBeNull();
  });

  it('lays out every PDF page in one continuous scroll surface', async () => {
    const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const document = {
      numPages: 3,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 612 * scale,
          height: 792 * scale,
        }),
        render: renderPage,
      })),
    };
    loadPdf.mockResolvedValueOnce({
      success: true,
      data: new TextEncoder().encode('%PDF-1.7'),
    });
    getPdfDocument.mockReturnValue({
      promise: Promise.resolve(document),
      destroy: vi.fn().mockResolvedValue(undefined),
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D,
    );

    const url = 'https://arxiv.org/pdf/2609.20859';
    const { container } = render(
      <BrowserPanelHarness
        draftKey="continuous-pdf-session"
        initialTabs={[{ id: 'continuous-pdf', targetId: 'continuous-pdf', title: '', url }]}
        retainedTargetIds={['continuous-pdf']}
      />,
    );

    useCompatibilityPdfViewer();
    await waitFor(() =>
      expect(container.querySelectorAll('[data-pdf-page-number]')).toHaveLength(3),
    );
    expect(container.querySelector('[data-pdf-page-number="1"]')).toBeTruthy();
    expect(container.querySelector('[data-pdf-page-number="3"]')).toBeTruthy();
  });

  it('recognizes a generic PDF response without replacing the native viewer', async () => {
    const url = 'https://documents.example.test/download?id=42';
    const { container } = render(
      <BrowserPanelHarness
        draftKey="pdf-response-session"
        initialTabs={[{ id: 'pdf-response', targetId: 'pdf-response', title: '', url }]}
        retainedTargetIds={['pdf-response']}
      />,
    );

    await waitFor(() => expect(panelPdfDetectedListener).not.toBeNull());
    act(() => panelPdfDetectedListener?.({ url, guestId: 7 }));

    expect(container.querySelector('[data-browser-pdf-viewer]')).toBeNull();
    expect(loadPdf).not.toHaveBeenCalled();
    useCompatibilityPdfViewer();
    await waitFor(() => expect(container.querySelector('[data-browser-pdf-viewer]')).toBeTruthy());
    expect(loadPdf).toHaveBeenCalledWith(expect.objectContaining({ url, profile: 'embedded' }));
  });

  it('disables guest-only PDF actions and reloads the visible PDF document', async () => {
    render(
      <BrowserPanelHarness
        draftKey="pdf-actions"
        initialTabs={[
          {
            id: 'pdf-actions',
            targetId: 'pdf-actions',
            title: '',
            url: 'https://example.com/file.pdf',
          },
        ]}
        retainedTargetIds={['pdf-actions']}
      />,
    );
    useCompatibilityPdfViewer();
    await waitFor(() => expect(loadPdf).toHaveBeenCalledOnce());
    expect((screen.getByLabelText('Add comment') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('More browser options'));
    for (const name of ['Find in page', 'Print', i18nService.t('browserMenuScreenshot')]) {
      expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Browser menu' }), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText(i18nService.t('browserPanelReload')));
    await waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(2));
    expect(reload).not.toHaveBeenCalled();
    expect(printPage).not.toHaveBeenCalled();
  });

  it('retains PDF viewers when switching tabs without fetching the document again', async () => {
    const firstUrl = 'https://example.com/first.pdf';
    const secondUrl = 'https://example.com/second.pdf';
    const { container } = render(
      <BrowserPanelHarness
        draftKey="retained-pdfs"
        initialTabs={[
          { id: 'first', targetId: 'first', title: 'First PDF', url: firstUrl },
          { id: 'second', targetId: 'second', title: 'Second PDF', url: secondUrl },
        ]}
        retainedTargetIds={['first', 'second']}
      />,
    );
    useCompatibilityPdfViewer();
    fireEvent.click(screen.getByRole('tab', { name: 'Second PDF' }));
    useCompatibilityPdfViewer();
    await waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(2));
    const viewers = [...container.querySelectorAll('[data-browser-pdf-viewer]')];
    fireEvent.click(screen.getByRole('tab', { name: 'Second PDF' }));
    fireEvent.click(screen.getByRole('tab', { name: 'First PDF' }));
    expect([...container.querySelectorAll('[data-browser-pdf-viewer]')]).toEqual(viewers);
    expect(loadPdf).toHaveBeenCalledTimes(2);
  });

  it('falls back to the guest page when a PDF-like URL returns HTML', async () => {
    loadPdf.mockResolvedValueOnce({ success: false, errorCode: 'not_pdf' });
    const { container } = render(
      <BrowserPanelHarness
        draftKey="html-pdf-path"
        initialTabs={[
          { id: 'html-pdf', targetId: 'html-pdf', title: '', url: 'https://example.com/login.pdf' },
        ]}
        retainedTargetIds={['html-pdf']}
      />,
    );
    useCompatibilityPdfViewer();
    await waitFor(() => expect(loadPdf).toHaveBeenCalledOnce());
    await waitFor(() => expect(container.querySelector('[data-browser-pdf-viewer]')).toBeNull());
    expect(container.querySelector('webview')).toBeTruthy();
    expect((screen.getByLabelText('Add comment') as HTMLButtonElement).disabled).toBe(false);
    act(() => panelPdfDetectedListener?.({ url: 'https://example.com/login.pdf', guestId: 7 }));
    await waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[data-browser-pdf-viewer]')).toBeTruthy();
  });

  it('rechecks an HTML fallback after an explicit PDF URL reload', async () => {
    loadPdf.mockResolvedValueOnce({ success: false, errorCode: 'not_pdf' });
    const { container } = render(
      <BrowserPanelHarness
        draftKey="reload-html-pdf"
        initialTabs={[
          {
            id: 'retry-html',
            targetId: 'retry-html',
            title: '',
            url: 'https://example.com/retry.pdf',
          },
        ]}
        retainedTargetIds={['retry-html']}
      />,
    );
    fireEvent(container.querySelector('webview')!, new Event('dom-ready'));
    useCompatibilityPdfViewer();
    await waitFor(() => expect(loadPdf).toHaveBeenCalledOnce());
    await waitFor(() => expect(container.querySelector('[data-browser-pdf-viewer]')).toBeNull());
    fireEvent.click(screen.getByLabelText(i18nService.t('browserPanelReload')));
    await waitFor(() => expect(loadPdf).toHaveBeenCalledTimes(2));
  });

  it('registers as soon as a delayed webview attaches without waiting for page readiness', async () => {
    let guestAttached = false;
    defineWebviewMethod('getWebContentsId', () => {
      if (!guestAttached) throw new Error('guest is not attached');
      return 7;
    });
    const view = render(<BrowserPanelHarness />);
    expect(registerAgentTab).not.toHaveBeenCalled();

    guestAttached = true;
    fireEvent(view.container.querySelector('webview')!, new Event('did-attach'));

    await waitFor(() => expect(registerAgentTab).toHaveBeenCalledTimes(1));
  });

  it('uses the source file path as the user-facing address for local HTML', () => {
    expect(
      getBrowserTabAddress({
        id: 'local-preview',
        targetId: 'local-preview',
        title: 'Report',
        url: 'http://127.0.0.1:43128/token/report.html#summary',
        sourcePreviewUrl: 'http://127.0.0.1:43128/token/report.html',
        sourceFilePath: 'C:\\reports\\report.html',
      }),
    ).toBe('C:\\reports\\report.html');

    expect(
      getBrowserTabAddress({
        id: 'local-preview',
        targetId: 'local-preview',
        title: 'Details',
        url: 'http://127.0.0.1:43128/token/chapters/%E8%AF%A6%E6%83%85.html',
        sourcePreviewUrl: 'http://127.0.0.1:43128/token/report.html',
        sourceFilePath: 'C:\\reports\\report.html',
        sourcePreviewRootUrl: 'http://127.0.0.1:43128/token/',
        sourceRootPath: 'C:\\reports',
      }),
    ).toBe('C:\\reports\\chapters\\详情.html');

    expect(
      getBrowserTabAddress({
        id: 'local-preview',
        targetId: 'local-preview',
        title: 'Report',
        url: 'http://127.0.0.1:43128/token/',
        sourcePreviewUrl: 'http://127.0.0.1:43128/token/report.html',
        sourceFilePath: 'C:\\reports\\report.html',
        sourcePreviewRootUrl: 'http://127.0.0.1:43128/token/',
        sourceRootPath: 'C:\\reports',
      }),
    ).toBe('C:\\reports\\report.html');

    expect(
      getBrowserTabAddress({
        id: 'local-preview',
        targetId: 'local-preview',
        title: 'Report dashboard',
        url: 'http://127.0.0.1:43128/dashboard',
        sourcePreviewUrl: 'http://127.0.0.1:43128/token/report.html',
        sourceFilePath: 'C:\\reports\\report.html',
        sourcePreviewRootUrl: 'http://127.0.0.1:43128/token/',
        sourceRootPath: 'C:\\reports',
      }),
    ).toBe('C:\\reports\\report.html');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const name of [
      'canGoBack',
      'canGoForward',
      'getTitle',
      'getURL',
      'getWebContentsId',
      'goBack',
      'goForward',
      'loadURL',
      'reload',
      'isAudioMuted',
      'setAudioMuted',
      'findInPage',
      'stopFind',
      'print',
      'getZoomFactor',
      'setZoomFactor',
      'openDevTools',
      'send',
      'capturePage',
    ]) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('shows a browser-style start page for a blank tab and focuses the address bar', () => {
    const { container } = render(<BrowserPanelHarness />);

    expect(screen.getByText('Start browsing')).toBeTruthy();
    expect(screen.getByText('Search or enter an address to open a page')).toBeTruthy();
    const activeTab = container.querySelector('[data-browser-tab-id]');
    expect(activeTab?.textContent).toContain('New tab');
    expect(activeTab?.textContent).not.toContain('about:blank');

    fireEvent.click(screen.getByLabelText('Focus the address bar'));
    expect(document.activeElement).toBe(screen.getByLabelText('Browser address'));
  });

  it('keeps idle blank pages free of task controls while checking for an existing hold', async () => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({ ...config, browserMode: 'embedded' });
    const intervention = vi.fn().mockResolvedValue({ success: true, value: null });
    window.electron.browser.intervention = intervention;
    const stop = vi.fn(async () => true);
    render(
      <BrowserPanelHarness
        draftKey="blank-task"
        embedded
        initialTabs={[{ id: 'blank', targetId: 'blank', title: '', url: 'about:blank' }]}
        onStopTask={stop}
        onContinueTask={async () => 'sent'}
      />,
    );
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    expect(screen.queryByTestId('browser-agent-interaction-lock')).toBeNull();
    await waitFor(() =>
      expect(intervention).toHaveBeenCalledWith(expect.objectContaining({ action: 'read' })),
    );
    expect(stop).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'example.com' },
    });
    expect(screen.getByLabelText('Browser address')).toHaveProperty('value', 'example.com');
  });

  it('preserves manual notes and the continue action when switching to a blank tab', async () => {
    const config = configService.getConfig();
    vi.spyOn(configService, 'getConfig').mockReturnValue({ ...config, browserMode: 'embedded' });
    window.electron.browser.intervention = vi
      .fn()
      .mockResolvedValue({
        success: true,
        value: { token: 'hold', targetId: 'manual-page', phase: 'manual', stopConfirmed: true },
      });
    render(
      <BrowserPanelHarness
        draftKey="manual-tab-change"
        initialTabs={[
          { id: 'manual-page', targetId: 'manual-page', title: '', url: 'https://example.com' },
        ]}
        onStopTask={async () => true}
        onContinueTask={async () => 'sent'}
      />,
    );
    const note = await screen.findByRole('textbox', { name: 'Optional note, e.g. signed in' });
    fireEvent.change(note, { target: { value: 'Finished signing in' } });
    fireEvent.click(screen.getByLabelText('New tab'));
    expect(screen.getByRole('textbox', { name: 'Optional note, e.g. signed in' })).toHaveProperty(
      'value',
      'Finished signing in',
    );
    expect(screen.getByRole('button', { name: 'Done, continue task' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('shows intervention on the real embedded page and removes it in external browser mode', async () => {
    const config = configService.getConfig();
    const getConfig = vi
      .spyOn(configService, 'getConfig')
      .mockReturnValue({ ...config, browserMode: 'embedded' });
    window.electron.browser.intervention = vi
      .fn()
      .mockResolvedValue({ success: true, value: null });
    const { container } = render(
      <BrowserPanelHarness
        draftKey="intervention-session"
        embedded
        initialTabs={[{ id: 'page', targetId: 'page', title: '', url: 'https://example.com' }]}
        onStopTask={async () => true}
        onContinueTask={async () => 'sent'}
      />,
    );
    expect(container.querySelectorAll('webview')).toHaveLength(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    act(() =>
      agentInteractionListener?.({ sessionId: 'other-session', targetId: 'page', busy: true }),
    );
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    act(() =>
      agentInteractionListener?.({
        sessionId: 'intervention-session',
        targetId: 'other-page',
        busy: true,
      }),
    );
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    act(() =>
      agentInteractionListener?.({
        sessionId: 'intervention-session',
        targetId: 'page',
        busy: true,
      }),
    );
    expect(screen.getByRole('button', { name: 'Stop task and interact manually' })).toBeTruthy();
    act(() =>
      agentInteractionListener?.({
        sessionId: 'intervention-session',
        targetId: 'page',
        busy: false,
      }),
    );
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    act(() =>
      agentInteractionListener?.({
        sessionId: 'intervention-session',
        targetId: 'page',
        busy: true,
      }),
    );
    getConfig.mockReturnValue({ ...config, browserMode: 'isolated' });
    act(() => window.dispatchEvent(new CustomEvent('config-updated')));
    expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
    expect(container.querySelectorAll('webview')).toHaveLength(1);
  });

  it('creates a requested agent target beside an existing page only once', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    let latestTabs: BrowserPanelTab[] = [];
    const { container } = render(
      <BrowserPanelHarness
        draftKey="agent-open-existing"
        embedded
        initialTabs={[
          { id: 'existing', targetId: 'existing', title: '', url: 'https://one.example' },
        ]}
        onTabsChange={tabs => {
          latestTabs = tabs;
        }}
        panelRef={instance => {
          panelHandle = instance;
        }}
      />,
    );
    act(() => {
      panelHandle?.openTab('https://two.example', { targetId: 'requested', profile: 'embedded' });
      panelHandle?.openTab('https://two.example', { targetId: 'requested', profile: 'embedded' });
    });
    await waitFor(() =>
      expect(latestTabs.map(tab => tab.targetId)).toEqual(['existing', 'requested']),
    );
    expect(container.querySelectorAll('webview')).toHaveLength(2);
  });

  it('reports rejected creation at capacity without selecting a nonexistent guest', () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const initialTabs = Array.from({ length: 8 }, (_, index) => ({
      id: `page-${index}`,
      targetId: `page-${index}`,
      title: '',
      url: `https://example.com/${index}`,
    }));
    const onTabsChange = vi.fn();
    const { container } = render(
      <BrowserPanelHarness
        embedded
        initialTabs={initialTabs}
        draftKey="agent-open-capacity"
        onTabsChange={onTabsChange}
        panelRef={instance => {
          panelHandle = instance;
        }}
      />,
    );
    onTabsChange.mockClear();
    act(() => {
      expect(panelHandle?.openTab('https://example.com/overflow', { targetId: 'overflow' })).toBe(
        false,
      );
      expect(panelHandle?.openTab('https://example.com/0', { targetId: 'page-0' })).toBe(true);
    });
    expect(container.querySelectorAll('webview')).toHaveLength(8);
    expect(onTabsChange).not.toHaveBeenCalled();
  });

  it('focuses the address bar when a shortcut opens a blank embedded tab', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    render(
      <BrowserPanelHarness
        embedded
        onTabsChange={onTabsChange}
        panelRef={instance => {
          panelHandle = instance;
        }}
      />,
    );

    act(() => panelHandle?.openTab());

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Browser address')),
    );
    const tabs = onTabsChange.mock.calls[
      onTabsChange.mock.calls.length - 1
    ]?.[0] as BrowserPanelTab[];
    act(() => panelHandle?.closeTab(tabs[tabs.length - 1]!.targetId));
  });

  it('unmounts only browser tabs evicted by the external retention limit', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    let latestTabs: BrowserPanelTab[] = [];
    const { container, rerender } = render(
      <BrowserPanelHarness
        draftKey="retention-eviction-test"
        embedded
        onTabsChange={tabs => {
          latestTabs = tabs;
        }}
        panelRef={instance => {
          panelHandle = instance;
        }}
      />,
    );

    act(() => {
      panelHandle?.openTab('https://one.example');
      panelHandle?.openTab('https://two.example');
    });
    await waitFor(() => expect(latestTabs).toHaveLength(2));
    const evictedTargetId = latestTabs[0]!.targetId;
    const retainedTargetId = latestTabs[1]!.targetId;

    rerender(
      <BrowserPanelHarness
        draftKey="retention-eviction-test"
        embedded
        retainedTargetIds={[retainedTargetId]}
        onTabsChange={tabs => {
          latestTabs = tabs;
        }}
        panelRef={instance => {
          panelHandle = instance;
        }}
      />,
    );

    await waitFor(() => expect(latestTabs.map(tab => tab.targetId)).toEqual([retainedTargetId]));
    await waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(1));
    expect(unregisterAgentTab).toHaveBeenCalledWith({
      sessionId: 'retention-eviction-test',
      targetId: evictedTargetId,
    });
  });

  it('forwards the configured browser shortcut from panel controls', () => {
    const handleShortcut = vi.fn();
    window.addEventListener('cowork:shortcut:browser', handleShortcut);
    render(<BrowserPanelHarness />);

    fireEvent.keyDown(screen.getByRole('complementary'), { key: 't', ctrlKey: true });

    expect(handleShortcut).toHaveBeenCalledOnce();
    window.removeEventListener('cowork:shortcut:browser', handleShortcut);
  });

  it('forwards the files shortcut from panel controls', () => {
    const handleShortcut = vi.fn();
    window.addEventListener('cowork:shortcut:files', handleShortcut);
    render(<BrowserPanelHarness />);

    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'p', ctrlKey: true });

    expect(handleShortcut).toHaveBeenCalledOnce();
    window.removeEventListener('cowork:shortcut:files', handleShortcut);
  });

  it('does not read guest zoom until the current webview emits dom-ready', async () => {
    const getZoomFactor = vi.fn(() => 1.25);
    defineWebviewMethod('getZoomFactor', getZoomFactor);
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;

    expect(getZoomFactor).not.toHaveBeenCalled();

    fireEvent(webview, new Event('dom-ready'));

    await waitFor(() => expect(getZoomFactor).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText('More browser options'));
    expect(screen.getAllByRole('button', { name: 'Reset zoom' })[0]?.textContent).toBe('125%');
  });

  it('tolerates a webview being detached while synchronizing its zoom', async () => {
    const getZoomFactor = vi.fn(() => {
      throw new Error('The WebView must be attached to the DOM');
    });
    defineWebviewMethod('getZoomFactor', getZoomFactor);
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;

    fireEvent(webview, new Event('dom-ready'));

    await waitFor(() => expect(getZoomFactor).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText('More browser options'));
    expect(screen.getAllByRole('button', { name: 'Reset zoom' })[0]?.textContent).toBe('100%');
  });

  it('opens a local HTML tab in the system browser with its file URL', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    render(
      <BrowserPanelHarness
        embedded
        draftKey="open-external-local-test"
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );
    const previewUrl = 'http://127.0.0.1:43128/token/report.html?mode=3d#camera';
    const sourceFilePath = 'C:\\reports\\quarterly #100%.html';

    act(() =>
      panelHandle?.openTab(previewUrl, {
        sourceFilePath,
        sourcePreviewUrl: previewUrl,
      }),
    );
    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const latestTabs = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0] as
      BrowserPanelTab[] | undefined;
    const targetId = latestTabs?.[latestTabs.length - 1]?.targetId;
    expect(targetId).toBeTruthy();

    act(() => panelHandle?.openTabContextMenu(targetId!, 40, 40));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in external browser' }));

    await waitFor(() => expect(openLocalHtmlExternal).toHaveBeenCalledWith(previewUrl));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('zooms the live guest from a primary-modified mouse wheel event', () => {
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;
    fireEvent(webview, new Event('dom-ready'));

    const zoomEvent = new Event('ipc-message');
    Object.assign(zoomEvent, { channel: BROWSER_GUEST_ZOOM_CHANNEL, args: [1] });
    fireEvent(webview, zoomEvent);

    expect(setZoomFactor).toHaveBeenCalledWith(1.1);
    fireEvent.click(screen.getByLabelText('More browser options'));
    expect(screen.getByText('110%')).toBeTruthy();
  });

  it('keeps interaction on the live guest and navigates it directly', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview');
    const canvas = container.querySelector('canvas');
    expect(webview).not.toBeNull();
    expect(canvas).toBeNull();

    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'example.com/path' },
    });
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);

    await waitFor(() => expect(loadUrl).toHaveBeenCalledWith('https://example.com/path'));
    expect(loadUrl.mock.instances[0]).toBe(webview);
  });

  it('searches non-address text with the configured default search engine', async () => {
    render(<BrowserPanelHarness />);

    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'electron browser panel' },
    });
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);

    await waitFor(() =>
      expect(loadUrl).toHaveBeenCalledWith('https://www.baidu.com/s?wd=electron+browser+panel'),
    );
  });

  it('opens a file URL through the isolated local HTML preview', async () => {
    createLocalHtmlPreview.mockResolvedValue({
      success: true,
      url: 'http://127.0.0.1:43128/token/index.html',
      filePath: 'C:\\Users\\lianghao\\justdo\\project\\ai-assistant-3d\\index.html',
      rootPath: 'C:\\Users\\lianghao\\justdo\\project\\ai-assistant-3d',
      previewRootUrl: 'http://127.0.0.1:43128/token/',
    });
    const { container } = render(<BrowserPanelHarness />);
    const fileUrl = 'file:///C:/Users/lianghao/justdo/project/ai-assistant-3d/index.html';

    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: fileUrl },
    });
    fireEvent.submit(screen.getByLabelText('Browser address').closest('form')!);

    await waitFor(() => expect(createLocalHtmlPreview).toHaveBeenCalledWith(fileUrl));
    expect(loadUrl).toHaveBeenCalledWith('http://127.0.0.1:43128/token/index.html');
    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
      'C:\\Users\\lianghao\\justdo\\project\\ai-assistant-3d\\index.html',
    );

    fireEvent(container.querySelector('webview')!, new Event('dom-ready'));
    expect(setZoomFactor).toHaveBeenCalledWith(1);
  });

  it('ignores a stale local file preview when a newer address submission finishes first', async () => {
    let resolveFirst!: (result: BrowserLocalHtmlPreviewResult) => void;
    let resolveSecond!: (result: BrowserLocalHtmlPreviewResult) => void;
    createLocalHtmlPreview
      .mockReturnValueOnce(
        new Promise<BrowserLocalHtmlPreviewResult>(resolve => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<BrowserLocalHtmlPreviewResult>(resolve => {
          resolveSecond = resolve;
        }),
      );
    render(<BrowserPanelHarness draftKey="local-preview-race-test" />);
    const address = screen.getByLabelText('Browser address');
    const form = address.closest('form')!;

    fireEvent.change(address, { target: { value: 'file:///C:/reports/first.html' } });
    fireEvent.submit(form);
    fireEvent.change(address, { target: { value: 'file:///C:/reports/second.html' } });
    fireEvent.submit(form);
    await act(async () => {
      resolveSecond({
        success: true,
        url: 'http://127.0.0.1:43128/second/second.html',
        filePath: 'C:\\reports\\second.html',
        rootPath: 'C:\\reports',
        previewRootUrl: 'http://127.0.0.1:43128/second/',
      });
    });
    await waitFor(() =>
      expect(loadUrl).toHaveBeenCalledWith('http://127.0.0.1:43128/second/second.html'),
    );

    await act(async () => {
      resolveFirst({
        success: true,
        url: 'http://127.0.0.1:43128/first/first.html',
        filePath: 'C:\\reports\\first.html',
        rootPath: 'C:\\reports',
        previewRootUrl: 'http://127.0.0.1:43128/first/',
      });
    });

    expect(loadUrl).not.toHaveBeenCalledWith('http://127.0.0.1:43128/first/first.html');
    expect((address as HTMLInputElement).value).toBe('C:\\reports\\second.html');
  });

  it('retains the current URL when the panel is hidden and mounted again', async () => {
    const firstRender = render(<BrowserPanelHarness />);
    const firstWebview = firstRender.container.querySelector('webview')!;
    const navigated = new Event('did-navigate');
    Object.assign(navigated, { url: 'https://example.com/retained' });
    firstWebview.dispatchEvent(navigated);

    await waitFor(() =>
      expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
        'https://example.com/retained',
      ),
    );
    firstRender.unmount();

    const secondRender = render(<BrowserPanelHarness />);
    const restoredWebview = secondRender.container.querySelector('webview')!;
    expect(restoredWebview.getAttribute('src')).toBe('https://example.com/retained');

    const bootstrapNavigation = new Event('did-navigate');
    Object.assign(bootstrapNavigation, { url: 'about:blank' });
    restoredWebview.dispatchEvent(bootstrapNavigation);

    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
      'https://example.com/retained',
    );
  });

  it('ignores iframe navigation in the top-level address and recording steps', async () => {
    const retain = vi.fn();
    const view = render(
      <BrowserPanelHarness
        onRecordingRetentionChange={retain}
        initialTabs={[
          {
            targetId: 'recording-page',
            id: 'recording-page',
            url: 'https://example.com/',
            title: 'Example',
          },
        ]}
      />,
    );
    const guest = view.container.querySelector('webview')!;
    act(() => guest.dispatchEvent(new Event('dom-ready')));
    fireEvent.click(screen.getByRole('button', { name: 'Record actions' }));
    await screen.findByRole('button', { name: 'Pause recording' });
    expect(retain).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('1')).toBeTruthy();
    act(() =>
      guest.dispatchEvent(
        Object.assign(new Event('did-navigate-in-page'), {
          isMainFrame: false,
          url: 'https://example.com/frame#changed',
        }),
      ),
    );
    expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
      'https://example.com/',
    );
    expect(screen.getByText('1')).toBeTruthy();
    act(() =>
      guest.dispatchEvent(
        Object.assign(new Event('did-navigate-in-page'), {
          isMainFrame: true,
          url: 'https://example.com/#changed',
        }),
      ),
    );
    expect(screen.getByText('2')).toBeTruthy();
    view.rerender(<BrowserPanelHarness isOpen={false} onRecordingRetentionChange={retain} />);
    await waitFor(() =>
      expect(guestSend).toHaveBeenLastCalledWith(
        BrowserRecordingChannel.Control,
        expect.objectContaining({ active: false }),
      ),
    );
    expect(retain).toHaveBeenLastCalledWith(true);
  });

  it('keeps the live guest mounted while the panel is hidden', () => {
    const view = render(<BrowserPanelHarness />);
    const webview = view.container.querySelector('webview');

    view.rerender(<BrowserPanelHarness isOpen={false} />);
    expect(view.container.querySelector('webview')).toBe(webview);
    const hiddenPanel = view.container.querySelector('aside');
    expect(hiddenPanel?.className).toContain('hidden');
    expect(hiddenPanel?.style.display).toBe('none');
    expect((webview as HTMLElement | null)?.style.visibility).toBe('hidden');

    view.rerender(<BrowserPanelHarness />);
    expect(view.container.querySelector('webview')).toBe(webview);
    expect(view.container.querySelector('aside')?.style.display).toBe('flex');
    expect((webview as HTMLElement | null)?.style.visibility).toBe('visible');
  });

  it('does not overwrite an address being edited when page metadata changes', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const address = screen.getByLabelText('Browser address');
    fireEvent.change(address, { target: { value: 'typed.example/path' } });

    const webview = container.querySelector('webview')!;
    const titleEvent = new Event('page-title-updated');
    Object.assign(titleEvent, { title: 'Late title' });
    webview.dispatchEvent(titleEvent);
    const faviconEvent = new Event('page-favicon-updated');
    Object.assign(faviconEvent, { favicons: ['https://example.com/favicon.ico'] });
    webview.dispatchEvent(faviconEvent);

    expect((address as HTMLInputElement).value).toBe('typed.example/path');

    const navigationEvent = new Event('did-navigate');
    Object.assign(navigationEvent, { url: 'https://clicked.example/page' });
    webview.dispatchEvent(navigationEvent);
    await waitFor(() =>
      expect((address as HTMLInputElement).value).toBe('https://clicked.example/page'),
    );
  });

  it('retains a tab load error through did-stop-loading and clears it on retry', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;
    const failed = new Event('did-fail-load');
    Object.assign(failed, {
      errorCode: -105,
      errorDescription: 'Name not resolved',
      isMainFrame: true,
    });
    webview.dispatchEvent(failed);
    webview.dispatchEvent(new Event('did-stop-loading'));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Name not resolved');

    webview.dispatchEvent(new Event('did-start-loading'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('enables popup events and routes target=_blank into a managed panel tab', async () => {
    const { container } = render(<BrowserPanelHarness />);
    expect(container.querySelectorAll('webview')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('New tab'));
    await waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(2));

    expect(panelOpenTabListener).not.toBeNull();
    panelOpenTabListener?.({ url: 'https://popup.example/path' });
    await waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(3));

    const webviews = [...container.querySelectorAll('webview')];
    expect(
      webviews.some(webview => webview.getAttribute('src') === 'https://popup.example/path'),
    ).toBe(true);
    for (const webview of webviews) {
      expect(webview.getAttribute('allowpopups')).toBe('true');
      expect(webview.getAttribute('partition')).toBe('persist:justdo-browser');
    }
  });

  it('uses a separate persistent partition for imported-profile tabs', async () => {
    const importedTab: BrowserPanelTab = {
      id: 'imported-tab',
      targetId: 'imported-tab',
      title: '',
      url: 'about:blank',
      profile: 'imported',
    };
    const { container } = render(<BrowserPanelHarness initialTabs={[importedTab]} />);

    expect(container.querySelector('webview')?.getAttribute('partition')).toBe(
      'persist:justdo-browser-imported',
    );
    await waitFor(() =>
      expect(registerAgentTab).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'imported-tab', profile: 'imported' }),
      ),
    );
  });

  it('temporarily blocks user interaction while the agent controls the active tab', async () => {
    const tab: BrowserPanelTab = {
      id: 'agent-tab',
      targetId: 'agent-tab',
      title: '',
      url: 'about:blank',
      profile: 'embedded',
    };
    const { container } = render(<BrowserPanelHarness draftKey="session-1" initialTabs={[tab]} />);
    const webview = container.querySelector('webview') as HTMLElement;
    webview.tabIndex = 0;
    webview.focus();
    const blur = vi.spyOn(webview, 'blur');

    await waitFor(() => expect(agentInteractionListener).not.toBeNull());
    act(() =>
      agentInteractionListener?.({
        sessionId: 'session-1',
        targetId: 'agent-tab',
        busy: true,
        operationId: 'operation-1',
      }),
    );
    expect(screen.getByTestId('browser-agent-interaction-lock')).not.toBeNull();
    expect(blur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(webview);
    expect(acknowledgeAgentInteraction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targetId: 'agent-tab',
      operationId: 'operation-1',
    });

    act(() =>
      agentInteractionListener?.({ sessionId: 'session-1', targetId: 'agent-tab', busy: false }),
    );
    expect(screen.queryByTestId('browser-agent-interaction-lock')).toBeNull();
  });

  it('acknowledges a panel-scoped lock before an embedded tab exists', () => {
    const interaction: BrowserAgentInteractionState = {
      sessionId: 'session-1',
      targetId: BROWSER_AGENT_PANEL_TARGET_ID,
      profile: 'imported',
      busy: true,
      operationId: 'panel-operation-1',
    };
    const { container } = render(
      <BrowserPanelHarness
        draftKey="session-1"
        embedded
        isOpen={false}
        initialTabs={[]}
        agentInteractionStates={[interaction]}
      />,
    );

    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByTestId('browser-agent-interaction-lock')).not.toBeNull();
    expect(acknowledgeAgentInteraction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targetId: BROWSER_AGENT_PANEL_TARGET_ID,
      profile: 'imported',
      operationId: 'panel-operation-1',
    });
  });

  it('locks agent mutations while the user is annotating the live page', async () => {
    const tab: BrowserPanelTab = {
      id: 'annotation-tab',
      targetId: 'annotation-tab',
      title: '',
      url: 'about:blank',
      profile: 'embedded',
    };
    render(<BrowserPanelHarness draftKey="session-1" initialTabs={[tab]} />);

    fireEvent.click(screen.getByLabelText('Draw annotation'));
    await waitFor(() =>
      expect(setUserInteractionState).toHaveBeenCalledWith({
        sessionId: 'session-1',
        targetId: 'annotation-tab',
        busy: true,
      }),
    );

    fireEvent.click(screen.getByLabelText('Stop drawing'));
    await waitFor(() =>
      expect(setUserInteractionState).toHaveBeenCalledWith({
        sessionId: 'session-1',
        targetId: 'annotation-tab',
        busy: false,
      }),
    );
  });

  it('keeps annotation controls usable when a cross-profile panel lock arrives', async () => {
    const tab: BrowserPanelTab = {
      id: 'annotation-tab',
      targetId: 'annotation-tab',
      title: '',
      url: 'about:blank',
      profile: 'embedded',
    };
    const interaction: BrowserAgentInteractionState = {
      sessionId: 'session-1',
      targetId: BROWSER_AGENT_PANEL_TARGET_ID,
      profile: 'imported',
      busy: true,
      operationId: 'imported-operation',
    };
    const { rerender } = render(<BrowserPanelHarness draftKey="session-1" initialTabs={[tab]} />);
    fireEvent.click(screen.getByLabelText('Draw annotation'));
    await waitFor(() =>
      expect(setUserInteractionState).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'annotation-tab', busy: true }),
      ),
    );
    acknowledgeAgentInteraction.mockClear();

    rerender(
      <BrowserPanelHarness
        draftKey="session-1"
        initialTabs={[tab]}
        agentInteractionStates={[interaction]}
      />,
    );
    expect(screen.queryByTestId('browser-agent-interaction-lock')).toBeNull();
    expect(acknowledgeAgentInteraction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Stop drawing'));
    await waitFor(() =>
      expect(screen.getByTestId('browser-agent-interaction-lock')).not.toBeNull(),
    );
    expect(acknowledgeAgentInteraction).toHaveBeenCalledWith({
      sessionId: 'session-1',
      targetId: BROWSER_AGENT_PANEL_TARGET_ID,
      profile: 'imported',
      operationId: 'imported-operation',
    });
  });

  it('keeps popups opened by an imported-profile tab in that profile', async () => {
    const importedTab: BrowserPanelTab = {
      id: 'imported-popup-opener',
      targetId: 'imported-popup-opener',
      title: '',
      url: 'https://signed-in.example',
      profile: 'imported',
    };
    const { container } = render(<BrowserPanelHarness initialTabs={[importedTab]} />);

    panelOpenTabListener?.({
      url: 'https://popup.example/path',
      openerGuestId: 7,
    });

    await waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(2));
    const popup = [...container.querySelectorAll('webview')].find(
      webview => webview.getAttribute('src') === 'https://popup.example/path',
    );
    expect(popup?.getAttribute('partition')).toBe('persist:justdo-browser-imported');
  });

  it('keeps the active named profile in browser annotation context', async () => {
    const onAddAnnotation = vi.fn((_annotation: BrowserAnnotationDraft) => true);
    const namedProfileTab: BrowserPanelTab = {
      id: 'named-profile-tab',
      targetId: 'named-profile-tab',
      title: 'Signed in',
      url: 'https://signed-in.example',
      profile: '1-work',
    };
    defineWebviewMethod(
      'capturePage',
      vi.fn().mockResolvedValue({
        getSize: () => ({ width: 100, height: 100 }),
        toDataURL: () => 'data:image/png;base64,AAAA',
      }),
    );
    vi.stubGlobal(
      'Image',
      class Image {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setLineDash: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,BBBB',
    );
    const { container } = render(
      <BrowserPanelHarness initialTabs={[namedProfileTab]} onAddAnnotation={onAddAnnotation} />,
    );

    fireEvent.click(screen.getByLabelText('Add comment'));
    fireEvent.click(container.querySelector('canvas')!, { clientX: 24, clientY: 24 });
    const comment = await screen.findByRole('textbox', { name: 'Add a comment…' });
    fireEvent.change(comment, { target: { value: 'Check this control' } });
    fireEvent.click(screen.getByLabelText('Add annotation and comment to chat'));

    await waitFor(() => expect(onAddAnnotation).toHaveBeenCalledOnce());
    expect(onAddAnnotation.mock.calls[0]?.[0].modelContext).toContain('"profile":"1-work"');
  });

  it('ignores popup events emitted by a webview owned by another retained panel', async () => {
    const { container } = render(<BrowserPanelHarness draftKey="popup-routing-isolation" />);
    expect(container.querySelectorAll('webview')).toHaveLength(1);

    panelOpenTabListener?.({ url: 'https://foreign-popup.example', openerGuestId: 99 });

    await waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(1));
  });

  it('reports a blocked target=_blank form submission without opening a GET tab', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const initialTabCount = container.querySelectorAll('webview').length;

    panelOpenTabListener?.({
      url: 'https://example.com/submit',
      errorCode: 'post-navigation-blocked',
    });

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'This page tried to submit a form in a new tab. The unsupported request was blocked.',
    );
    expect(container.querySelectorAll('webview')).toHaveLength(initialTabCount);
  });

  it('collects website authentication credentials for the owning guest', async () => {
    render(<BrowserPanelHarness />);

    panelHttpAuthListener?.({
      id: 'auth-1',
      guestId: 7,
      host: 'private.example.com',
      port: 443,
      realm: 'Members',
      scheme: 'basic',
    });

    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(respondToPanelHttpAuth).toHaveBeenCalledWith({
      id: 'auth-1',
      guestId: 7,
      username: 'alice',
      password: 'secret',
    });
  });

  it('keeps authentication input usable during agent control and parent updates', async () => {
    const { container } = render(
      <BrowserPanelHarness
        draftKey="auth-locked"
        agentInteractionStates={[
          {
            sessionId: 'auth-locked',
            targetId: BROWSER_AGENT_PANEL_TARGET_ID,
            profile: 'embedded',
            busy: true,
          },
        ]}
      />,
    );
    act(() =>
      panelHttpAuthListener?.({
        id: 'locked-auth',
        guestId: 7,
        host: 'private.example',
        port: 443,
        realm: '',
        scheme: 'basic',
      }),
    );
    const password = await screen.findByLabelText('Password');
    password.focus();
    expect(fireEvent.keyDown(password, { key: 's' })).toBe(true);
    fireEvent.change(password, { target: { value: 'secret' } });
    act(() => container.querySelector('webview')?.dispatchEvent(new Event('page-title-updated')));
    expect(document.activeElement).toBe(password);
    act(() => panelHttpAuthDismissedListener?.({ id: 'locked-auth', guestId: 7 }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('defers hidden-panel authentication and cancels pending requests on unmount', () => {
    const view = render(<BrowserPanelHarness isOpen={false} draftKey="hidden-auth" />);
    act(() =>
      panelHttpAuthListener?.({
        id: 'hidden-auth',
        guestId: 7,
        host: 'private.example',
        port: 443,
        realm: '',
        scheme: 'basic',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<BrowserPanelHarness isOpen draftKey="hidden-auth" />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.unmount();
    expect(respondToPanelHttpAuth).toHaveBeenCalledWith({ id: 'hidden-auth', guestId: 7 });
  });

  it('ignores authentication notifications while a guest is detached', () => {
    render(<BrowserPanelHarness draftKey="detached-auth" />);
    defineWebviewMethod('getWebContentsId', () => {
      throw new Error('detached');
    });
    expect(() =>
      act(() =>
        panelHttpAuthListener?.({
          id: 'detached-auth',
          guestId: 7,
          host: 'private.example',
          port: 443,
          realm: '',
          scheme: 'basic',
        }),
      ),
    ).not.toThrow();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens an editable comment box after locking an inspected element', async () => {
    const { container } = render(<BrowserPanelHarness />);
    fireEvent.click(screen.getByLabelText('Add comment'));
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.className).toContain('browser-element-annotation-cursor');
    fireEvent.click(canvas!, { clientX: 24, clientY: 24 });

    expect(await screen.findByRole('textbox', { name: 'Add a comment…' })).toBeTruthy();
    expect(screen.queryByText('a#docs.link')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand HTML element details' })).toBeTruthy();
    const composer = screen.getByTestId('browser-annotation-composer');
    expect(composer.style.top).toBe('54px');
    expect(composer.style.bottom).toBe('');
  });

  it('describes icon-only tools on hover', async () => {
    render(<BrowserPanelHarness />);
    const inspectButton = screen.getByLabelText('Add comment');

    expect(screen.queryByLabelText('Interact with page')).toBeNull();
    expect(inspectButton.className).toContain('bg-transparent');
    expect(inspectButton.className).not.toContain('bg-primary-muted');
    expect(screen.getByTestId('browser-inspect-plus')).toBeTruthy();

    fireEvent.mouseEnter(inspectButton.parentElement!);

    expect((await screen.findByRole('tooltip')).textContent).toBe('Add comment');

    fireEvent.click(inspectButton);

    expect(inspectButton.getAttribute('aria-pressed')).toBe('true');
    expect(inspectButton.getAttribute('aria-label')).toBe('Stop adding comments');
    expect(inspectButton.className).toContain('ring-primary/55');
    expect(inspectButton.className).not.toContain('bg-primary-muted');
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(inspectButton);

    expect(inspectButton.getAttribute('aria-pressed')).toBe('false');
    expect(inspectButton.getAttribute('aria-label')).toBe('Add comment');
    expect(inspectButton.className).not.toContain('ring-primary/55');
  });

  it('keeps annotation tools in the address row without a redundant title bar', () => {
    render(<BrowserPanelHarness />);
    const address = screen.getByLabelText('Browser address');
    const inspectButton = screen.getByLabelText('Add comment');
    const toolGroup = screen.getByTestId('browser-annotation-tool-group');

    expect(inspectButton.closest('form')).toBe(address.closest('form'));
    expect(toolGroup.className).toContain('border-border/70');
    expect(toolGroup.querySelectorAll('button')).toHaveLength(5);
    expect(toolGroup.querySelector('.h-px, .w-px')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Browser' })).toBeNull();
    expect(screen.getByLabelText('Close browser panel')).toBeTruthy();
  });

  it('opens a browser-style overflow menu and wires supported page actions', async () => {
    const onRequestBrowserSettings = vi.fn();
    const { container } = render(
      <BrowserPanelHarness onRequestBrowserSettings={onRequestBrowserSettings} />,
    );
    fireEvent(container.querySelector('webview')!, new Event('dom-ready'));

    fireEvent.click(screen.getByLabelText('More browser options'));
    const menu = screen.getByRole('menu', { name: 'Browser menu' });
    expect(menu).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Find in page' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Print' })).toBeTruthy();
    expect(screen.getByText('Zoom')).toBeTruthy();
    expect(
      screen
        .getByRole('menuitem', { name: 'Import cookies and passwords' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'History' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('menuitem', { name: 'Downloads' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.queryByRole('menuitem', { name: 'Passwords and autofill' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(setZoomFactor).toHaveBeenCalledWith(1.1);
    expect(screen.getByText('110%')).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Find in page' }));
    const findInput = screen.getByLabelText('Find in page');
    fireEvent.change(findInput, { target: { value: 'docs' } });
    await waitFor(() => expect(findInPage).toHaveBeenCalledWith('docs', expect.any(Object)));
    fireEvent.click(screen.getByLabelText('Close find'));
    expect(stopFind).toHaveBeenCalledWith('clearSelection');

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show device toolbar' }));
    expect(openDevTools).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(onRequestBrowserSettings).toHaveBeenCalledWith('history');

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Downloads' }));
    expect(onRequestBrowserSettings).toHaveBeenCalledWith('downloads');

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browser settings' }));
    expect(onRequestBrowserSettings).toHaveBeenLastCalledWith();
  });

  it('opens a guarded Chrome data import dialog from the overflow menu', async () => {
    const { container } = render(<BrowserPanelHarness />);
    fireEvent(container.querySelector('webview')!, new Event('dom-ready'));

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import cookies and passwords' }));

    expect(screen.getByRole('dialog', { name: 'Import from browser' })).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText('Import source') as HTMLSelectElement).value).toBe('Default'),
    );
    expect(
      screen.getByRole('switch', { name: 'Saved passwords' }).getAttribute('aria-checked'),
    ).toBe('true');
    const cookieSwitch = screen.getByRole('switch', { name: 'Cookies' });
    expect(cookieSwitch.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByText(
        'Sign-in cookies from recent Chrome versions are usually protected, so this is off by default',
      ),
    ).toBeTruthy();
    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton.hasAttribute('disabled')).toBe(true);

    fireEvent.click(cookieSwitch);
    fireEvent.click(
      screen.getByLabelText(
        'I understand and allow the app to read and import the selected Chrome data locally',
      ),
    );
    expect(importButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(importButton);
    await waitFor(() => expect(importData).toHaveBeenCalledOnce());
    expect(importData).toHaveBeenCalledWith({
      sourceId: 'Default',
      passwords: true,
      cookies: true,
      history: true,
      approved: true,
    });
    expect(reload).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Import from browser' })).toBeNull(),
    );
    expect(screen.getByRole('status').textContent).toContain(
      'Imported: 2 passwords, 3 cookies, and 4 history entries.',
    );
    fireEvent.click(screen.getByLabelText('Dismiss browser notification'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('recovers when Chrome profile discovery rejects', async () => {
    listImportSources.mockRejectedValueOnce(new Error('native path SHOULD_NOT_RENDER'));
    render(<BrowserPanelHarness />);

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import cookies and passwords' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Unable to read the Chrome profile',
    );
    expect(screen.queryByText(/SHOULD_NOT_RENDER/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true);
  });

  it('requires confirmation in trusted host UI before filling a saved credential', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;
    const offer = new Event('ipc-message');
    Object.assign(offer, { channel: 'justdo-browser-credentials:offer', args: [] });

    fireEvent(webview, offer);

    expect(
      await screen.findByText('Use the sign-in information saved for this site?'),
    ).toBeTruthy();
    expect(guestSend).not.toHaveBeenCalledWith('justdo-browser-credentials:fill');
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
    expect(guestSend).toHaveBeenCalledWith('justdo-browser-credentials:fill');
    expect(screen.queryByText('Use the sign-in information saved for this site?')).toBeNull();
  });

  it('clears selected browser data through the privileged browser service', async () => {
    const { container } = render(<BrowserPanelHarness />);
    fireEvent(container.querySelector('webview')!, new Event('dom-ready'));

    fireEvent.click(screen.getByLabelText('More browser options'));
    const clearMenuItem = screen.getByRole('menuitem', { name: 'Clear browsing data' });
    expect(clearMenuItem.hasAttribute('disabled')).toBe(false);
    fireEvent.click(clearMenuItem);

    expect(screen.getByRole('dialog', { name: 'Clear browsing data' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('12 entries, most recently from example.com')).toBeTruthy(),
    );
    expect(screen.getByText('Sites currently storing cookies: 3')).toBeTruthy();
    expect(screen.getByText(/Chromium can only clear all cookies/)).toBeTruthy();
    expect(screen.queryByLabelText('Site settings')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete data' }));
    await waitFor(() => expect(clearBrowsingData).toHaveBeenCalledOnce());
    expect(clearBrowsingData).toHaveBeenCalledWith({
      range: 'hour',
      selection: {
        history: true,
        cookiesAndSiteData: true,
        cache: true,
        downloads: true,
        autofill: false,
      },
    });
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Selected browsing data cleared');
  });

  it('states clearly when protected Chrome cookies did not transfer sign-in state', async () => {
    importData.mockResolvedValueOnce({
      success: true,
      imported: { passwords: 4, cookies: 0, history: 4897 },
      skippedAppBound: { passwords: 0, cookies: 3120 },
    });
    render(<BrowserPanelHarness />);

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import cookies and passwords' }));
    await waitFor(() => expect(screen.getByLabelText('Import source')).toBeTruthy());
    fireEvent.click(screen.getByRole('switch', { name: 'Cookies' }));
    fireEvent.click(
      screen.getByLabelText(
        'I understand and allow the app to read and import the selected Chrome data locally',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain(
      'Imported: 4 passwords, 0 cookies, and 4897 history entries.',
    );
    expect(notice.textContent).toContain('Chrome sign-in state was not transferred.');
    expect(notice.textContent).toContain(
      '3120 cookies protected by Chrome app-bound encryption could not be transferred.',
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps import failures bounded and does not render native command details', async () => {
    importData.mockResolvedValueOnce({
      success: false,
      errorCode: 'decrypt-failed',
      error: 'Command failed with encrypted payload SHOULD_NOT_RENDER',
    });
    render(<BrowserPanelHarness />);

    fireEvent.click(screen.getByLabelText('More browser options'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import cookies and passwords' }));
    const dialog = screen.getByRole('dialog', { name: 'Import from browser' });
    await waitFor(() => expect(screen.getByLabelText('Import source')).toBeTruthy());
    fireEvent.click(
      screen.getByLabelText(
        'I understand and allow the app to read and import the selected Chrome data locally',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Unable to decrypt Chrome data. Make sure Chrome belongs to the current Windows user.',
    );
    expect(screen.queryByText(/SHOULD_NOT_RENDER/)).toBeNull();
    expect(dialog.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(dialog.querySelector('.overflow-y-auto')).toBeTruthy();
  });

  it('combines drawing modes into a remembered annotation tool picker', () => {
    render(<BrowserPanelHarness />);
    const penTool = screen.getByLabelText('Draw annotation');
    expect(penTool).toBeTruthy();
    expect(screen.queryByLabelText('Rectangle annotation')).toBeNull();

    fireEvent.click(penTool);
    expect(penTool.getAttribute('aria-pressed')).toBe('true');
    expect(penTool.getAttribute('aria-label')).toBe('Stop drawing');
    expect(penTool.className).toContain('ring-primary/55');

    fireEvent.click(penTool);
    expect(penTool.getAttribute('aria-pressed')).toBe('false');
    expect(penTool.getAttribute('aria-label')).toBe('Draw annotation');

    fireEvent.click(screen.getByLabelText('Switch annotation tool'));
    const rectangleOption = screen.getByRole('menuitemradio', {
      name: 'Rectangle annotation',
    });
    fireEvent.click(rectangleOption);

    const rectangleTool = screen.getByLabelText('Stop rectangle annotation');
    expect(rectangleTool.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('menu', { name: 'Choose annotation tool' })).toBeNull();
  });

  it('shows the page favicon next to its tab title', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const webview = container.querySelector('webview')!;
    const titleEvent = new Event('page-title-updated');
    Object.assign(titleEvent, { title: 'Example Docs' });
    webview.dispatchEvent(titleEvent);
    const faviconEvent = new Event('page-favicon-updated');
    Object.assign(faviconEvent, { favicons: ['https://example.com/favicon.ico'] });
    webview.dispatchEvent(faviconEvent);

    const tab = container.querySelector('[data-browser-tab-id]')!;
    await waitFor(() =>
      expect(tab.querySelector('img')?.getAttribute('src')).toBe('https://example.com/favicon.ico'),
    );
    expect(tab.textContent).toContain('Example Docs');
  });

  it('publishes page tabs to the shared display bar when embedded', async () => {
    const onTabsChange = vi.fn();
    render(<BrowserPanelHarness embedded onTabsChange={onTabsChange} />);

    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const lastCall = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1];
    expect(lastCall?.[0].length).toBeGreaterThan(0);
    expect(screen.queryByRole('tablist', { name: 'Browser tabs' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Browser address' })).toBeTruthy();
  });

  it('shows and copies the source path for a local HTML preview', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    render(
      <BrowserPanelHarness
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );
    const previewUrl = 'http://127.0.0.1:43128/token/report.html';
    const sourceFilePath = 'C:\\reports\\report.html';

    act(() => panelHandle?.openTab(previewUrl, { sourceFilePath }));

    expect(
      (screen.getByRole('textbox', { name: 'Browser address' }) as HTMLInputElement).value,
    ).toBe(sourceFilePath);
    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const latestCall = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1];
    const tabs = latestCall?.[0] as BrowserPanelTab[];
    act(() => panelHandle?.openTabContextMenu(tabs[tabs.length - 1]!.targetId, 40, 40));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file path' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sourceFilePath));
  });

  it('preserves the source path when reopening a closed local HTML tab', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    const { container } = render(
      <BrowserPanelHarness
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );
    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    let tabs = onTabsChange.mock.calls[
      onTabsChange.mock.calls.length - 1
    ]?.[0] as BrowserPanelTab[];
    act(() => tabs.forEach(tab => panelHandle?.closeTab(tab.targetId)));
    act(() => panelHandle?.openTab());
    act(() =>
      panelHandle?.openTab('http://127.0.0.1:43128/token/report.html', {
        sourceFilePath: 'C:\\reports\\report.html',
        sourcePreviewUrl: 'http://127.0.0.1:43128/token/report.html',
        sourceRootPath: 'C:\\reports',
        sourcePreviewRootUrl: 'http://127.0.0.1:43128/token/',
      }),
    );
    await waitFor(() => {
      const latest = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0];
      expect(latest).toHaveLength(2);
    });
    tabs = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0] as BrowserPanelTab[];
    act(() => panelHandle?.closeTab(tabs[1]!.targetId));
    const command = new Event('ipc-message');
    Object.assign(command, { channel: 'justdo-browser-command', args: ['reopen-tab'] });
    fireEvent(container.querySelector('webview')!, command);

    await waitFor(() =>
      expect((screen.getByLabelText('Browser address') as HTMLInputElement).value).toBe(
        'C:\\reports\\report.html',
      ),
    );
  });

  it('opens the original tab menu from the shared display bar when embedded', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    render(
      <BrowserPanelHarness
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );

    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const latestTabs = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0];
    const targetId = latestTabs?.[0]?.targetId;
    expect(targetId).toBeTruthy();
    act(() => panelHandle?.openTabContextMenu(targetId, 40, 40));

    expect(screen.getByRole('menu', { name: 'Tab menu' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Rename tab' })).toBeTruthy();
  });

  it('delegates shared display-bar close actions to the full tab strip', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    const close = vi.fn();
    const closeOthers = vi.fn();
    const closeRight = vi.fn();
    const restoreFocus = vi.fn();
    render(
      <BrowserPanelHarness
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );

    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const latestTabs = onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0];
    const targetId = latestTabs?.[0]?.targetId;
    const closeActions = {
      canCloseOthers: true,
      canCloseRight: true,
      close,
      closeOthers,
      closeRight,
      restoreFocus,
    };

    act(() => panelHandle?.openTabContextMenu(targetId, 40, 40, closeActions));
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Tab menu' }), { key: 'Tab' });
    expect(screen.queryByRole('menu', { name: 'Tab menu' })).toBeNull();
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledTimes(1));

    act(() => panelHandle?.openTabContextMenu(targetId, 40, 40, closeActions));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the right' }));
    expect(closeRight).toHaveBeenCalledTimes(1);

    act(() => panelHandle?.openTabContextMenu(targetId, 40, 40, closeActions));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close other tabs' }));
    expect(closeOthers).toHaveBeenCalledTimes(1);

    act(() => panelHandle?.openTabContextMenu(targetId, 40, 40, closeActions));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tab' }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('offers tab management actions from the tab context menu', async () => {
    const { container } = render(<BrowserPanelHarness />);
    const tab = container.querySelector('[data-browser-tab-id]')!;
    const initialTabCount = container.querySelectorAll('webview').length;

    fireEvent.contextMenu(tab, { clientX: 40, clientY: 40 });
    expect(screen.getByRole('menu', { name: 'Tab menu' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate tab' }));
    await waitFor(() =>
      expect(container.querySelectorAll('webview')).toHaveLength(initialTabCount + 1),
    );

    fireEvent.contextMenu(tab, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const renameInput = screen.getByLabelText('Rename tab');
    fireEvent.change(renameInput, { target: { value: 'Research' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    expect(tab.textContent).toContain('Research');

    fireEvent.contextMenu(tab, { clientX: 40, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute tab' }));
    expect(setAudioMuted).toHaveBeenCalledWith(true);
  });

  it('keeps the browser empty after closing every tab and remounting the panel', async () => {
    let panelHandle: BrowserPanelHandle | null = null;
    const onTabsChange = vi.fn();
    const firstView = render(
      <BrowserPanelHarness
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={onTabsChange}
      />,
    );

    await waitFor(() => expect(onTabsChange).toHaveBeenCalled());
    const publishedTabs = (onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0] ??
      []) as BrowserPanelTab[];
    expect(publishedTabs.length).toBeGreaterThan(0);
    act(() => publishedTabs.forEach(tab => panelHandle?.closeTab(tab.targetId)));
    await waitFor(() =>
      expect(onTabsChange.mock.calls[onTabsChange.mock.calls.length - 1]?.[0]).toEqual([]),
    );
    expect(firstView.container.querySelectorAll('webview')).toHaveLength(0);

    firstView.unmount();
    const remountTabsChange = vi.fn();
    const secondView = render(<BrowserPanelHarness embedded onTabsChange={remountTabsChange} />);
    await waitFor(() => expect(remountTabsChange).toHaveBeenCalledWith([]));
    expect(secondView.container.querySelectorAll('webview')).toHaveLength(0);
  });

  it('isolates retained tabs by session and moves them when a session is promoted', async () => {
    const homeKey = `home-${crypto.randomUUID()}`;
    const sessionKey = `session-${crypto.randomUUID()}`;
    let panelHandle: BrowserPanelHandle | null = null;
    const homeTabsChange = vi.fn();
    const homeView = render(
      <BrowserPanelHarness
        draftKey={homeKey}
        embedded
        panelRef={instance => {
          panelHandle = instance;
        }}
        onTabsChange={homeTabsChange}
      />,
    );

    act(() => panelHandle?.openTab('https://example.com/session-tab'));
    await waitFor(() => {
      const tabs = homeTabsChange.mock.calls[homeTabsChange.mock.calls.length - 1]?.[0] as
        BrowserPanelTab[] | undefined;
      expect(tabs).toHaveLength(1);
    });
    homeView.unmount();

    const unrelatedTabsChange = vi.fn();
    const unrelatedView = render(
      <BrowserPanelHarness
        draftKey={`other-${crypto.randomUUID()}`}
        embedded
        onTabsChange={unrelatedTabsChange}
      />,
    );
    await waitFor(() => expect(unrelatedTabsChange).toHaveBeenCalledWith([]));
    unrelatedView.unmount();

    promoteBrowserPanelTabs(homeKey, sessionKey);
    const promotedTabsChange = vi.fn();
    render(
      <BrowserPanelHarness draftKey={sessionKey} embedded onTabsChange={promotedTabsChange} />,
    );
    await waitFor(() => {
      const tabs = promotedTabsChange.mock.calls[promotedTabsChange.mock.calls.length - 1]?.[0] as
        BrowserPanelTab[] | undefined;
      expect(tabs?.[0]?.url).toBe('https://example.com/session-tab');
    });
  });
});
