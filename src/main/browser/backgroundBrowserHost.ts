import { BrowserWindow, session } from 'electron';

import {
  type BrowserAgentTabRegistration,
  browserPartitionForProfile,
} from '../../shared/browser/browser';
import {
  getBrowserProxyCredentials,
  registerBrowserProxySession,
} from '../core/network/systemProxyPreference';
import {
  isAllowedBrowserPanelNavigationUrl,
  isBrowserPdfStreamNavigation,
} from '../core/window/browserPanelSecurity';
import { registerBackgroundBrowserGuest } from './backgroundBrowserGuestRegistry';
import { ensureBrowserSessionPolicy } from './browserSessionPolicy';
import { acquireBackgroundBrowserStorage } from './data/backgroundBrowserStorage';
import { cancelBrowserAgentDownloadsForWebContents } from './downloads/browserAgentDownloadCoordinator';

export type BackgroundBrowserPage = Omit<BrowserAgentTabRegistration, 'webContentsId'> & {
  scopeId: string;
  signal?: AbortSignal;
};

type OwnedPage = Omit<BackgroundBrowserPage, 'signal'> & {
  window: BrowserWindow;
  guest: Electron.WebContents;
  registration?: ReturnType<typeof registerBackgroundBrowserGuest>;
  destroyed: Promise<void>;
  closing: boolean;
  failure?: string;
};

type PendingCreation = {
  sessionId: string;
  controller: AbortController;
  finished: Promise<void>;
};

const whileCreating = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Background browser creation was cancelled.'),
      );
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });

/** Owns task pages; authentication, workers and connections belong to the profile. */
export class BackgroundBrowserHost {
  private readonly pages = new Map<number, OwnedPage>();
  private readonly pending = new Map<string, PendingCreation>();
  private readonly scopeGenerations = new Map<string, number>();
  private generation = 0;

  async create(request: BackgroundBrowserPage): Promise<Electron.WebContents> {
    request.signal?.throwIfAborted();
    const key = JSON.stringify([
      request.scopeId,
      request.sessionId,
      request.profile,
      request.targetId,
    ]);
    if (
      this.pending.has(key) ||
      [...this.pages.values()].some(
        page =>
          page.scopeId === request.scopeId &&
          page.sessionId === request.sessionId &&
          page.profile === request.profile &&
          page.targetId === request.targetId,
      )
    )
      throw new Error('The background browser page is already being created or open.');
    const controller = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;
    const partition = browserPartitionForProfile(request.profile);
    // This counts pending and live background pages for user-requested data clear.
    // Different runs may use the profile concurrently; their pages stay separate.
    const releaseStorage = acquireBackgroundBrowserStorage(partition);
    let finishPending!: () => void;
    const pending: PendingCreation = {
      sessionId: request.sessionId,
      controller,
      finished: new Promise<void>(resolve => {
        finishPending = resolve;
      }),
    };
    const generation = this.generation;
    const scopeGeneration = this.scopeGenerations.get(request.sessionId) ?? 0;
    this.pending.set(key, pending);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (
        generation !== this.generation ||
        scopeGeneration !== (this.scopeGenerations.get(request.sessionId) ?? 0)
      ) {
        throw new Error('The background browser scope has been closed.');
      }
    };
    let window: BrowserWindow | undefined;
    let ownedPage: OwnedPage | undefined;
    try {
      const browserSession = session.fromPartition(partition);
      // The same policy owner serves sidebar and background pages. Installing
      // task-wide Session handlers here would overwrite sidebar permissions.
      ensureBrowserSessionPolicy(browserSession);
      await whileCreating(registerBrowserProxySession(browserSession), signal);
      assertCurrent();
      window = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        width: 1280,
        height: 800,
        useContentSize: true,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          session: browserSession,
          preload: undefined,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          backgroundThrottling: false,
          offscreen: true,
          plugins: true,
          spellcheck: false,
          disableDialogs: false,
          navigateOnDragDrop: false,
        },
      });
      const guest = window.webContents;
      let finishDestroyed!: () => void;
      const page: OwnedPage = {
        scopeId: request.scopeId,
        sessionId: request.sessionId,
        profile: request.profile,
        targetId: request.targetId,
        window,
        guest,
        closing: false,
        destroyed: new Promise<void>(resolve => {
          finishDestroyed = resolve;
        }),
      };
      ownedPage = page;
      this.pages.set(guest.id, page);
      const revoke = () => {
        if (this.pages.get(guest.id) !== page) return;
        page.registration?.release();
        this.pages.delete(guest.id);
        cancelBrowserAgentDownloadsForWebContents(guest.id);
        releaseStorage();
        finishDestroyed();
      };
      guest.once('destroyed', revoke);
      window.once('closed', () => {
        if (guest.isDestroyed()) revoke();
      });
      guest.once('render-process-gone', () => this.close(guest.id));
      page.registration = registerBackgroundBrowserGuest(guest);
      this.configurePage(guest);
      const closeOnAbort = () => this.close(guest.id);
      signal.addEventListener('abort', closeOnAbort, { once: true });
      try {
        assertCurrent();
        await whileCreating(guest.loadURL('about:blank'), signal);
        assertCurrent();
        if (!this.has(guest.id)) throw new Error('The background browser page was closed.');
        return guest;
      } finally {
        signal.removeEventListener('abort', closeOnAbort);
      }
    } catch (error) {
      if (ownedPage) this.close(ownedPage.guest.id);
      else {
        if (window && !window.isDestroyed()) window.destroy();
        releaseStorage();
      }
      throw error;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      finishPending();
    }
  }

  owns(tab: BrowserAgentTabRegistration, guest: Electron.WebContents): boolean {
    const page = this.pages.get(tab.webContentsId);
    return Boolean(
      page &&
      !page.closing &&
      page.guest === guest &&
      !guest.isDestroyed() &&
      !page.window.isDestroyed() &&
      page.window.webContents === guest &&
      page.sessionId === tab.sessionId &&
      page.profile === tab.profile &&
      page.targetId === tab.targetId,
    );
  }

  has(webContentsId: number): boolean {
    const page = this.pages.get(webContentsId);
    return Boolean(
      page && !page.closing && !page.window.isDestroyed() && !page.guest.isDestroyed(),
    );
  }

  getFailure(webContentsId: number): string | null {
    return this.pages.get(webContentsId)?.failure ?? null;
  }

  close(webContentsId: number): void {
    const page = this.pages.get(webContentsId);
    if (!page || page.closing) return;
    page.closing = true;
    page.registration?.revoke();
    cancelBrowserAgentDownloadsForWebContents(webContentsId);
    // Destroy only this owned page. Shared profile workers/connections and the
    // sidebar's login storage remain outside the task's cancellation boundary.
    if (!page.window.isDestroyed()) page.window.destroy();
  }

  closeScope(sessionId: string): void {
    this.scopeGenerations.set(sessionId, (this.scopeGenerations.get(sessionId) ?? 0) + 1);
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort();
    }
    for (const page of [...this.pages.values()]) {
      if (page.sessionId === sessionId) this.close(page.guest.id);
    }
  }

  stop(): void {
    this.generation += 1;
    for (const pending of this.pending.values()) pending.controller.abort();
    for (const id of [...this.pages.keys()]) this.close(id);
  }

  /** Waits only for owned creation/destruction, never for shared site workers. */
  async waitForDrain(): Promise<void> {
    while (true) {
      const waiting = [
        ...[...this.pending.values()].map(pending => pending.finished),
        ...[...this.pages.values()].filter(page => page.closing).map(page => page.destroyed),
      ];
      if (!waiting.length) return;
      await Promise.all(waiting);
    }
  }

  private configurePage(guest: Electron.WebContents): void {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('will-attach-webview', event => event.preventDefault());
    guest.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      const page = this.pages.get(guest.id);
      if (page && !inPlace && mainFrame) page.failure = undefined;
    });
    guest.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserPanelNavigationUrl(url)) event.preventDefault();
    });
    guest.on('will-redirect', (event, url) => {
      if (!isAllowedBrowserPanelNavigationUrl(url)) event.preventDefault();
    });
    guest.on('will-frame-navigate', event => {
      if (
        !isAllowedBrowserPanelNavigationUrl(event.url) &&
        !isBrowserPdfStreamNavigation(event.url, event.isMainFrame, event.frame?.parent?.url)
      )
        event.preventDefault();
    });
    guest.on('login', (event, _details, info, callback) => {
      event.preventDefault();
      const credentials = getBrowserProxyCredentials();
      if (
        info.isProxy &&
        credentials &&
        info.host.toLowerCase() === credentials.host.toLowerCase() &&
        info.port === credentials.port
      )
        callback(credentials.username, credentials.password);
      else {
        const page = this.pages.get(guest.id);
        if (page)
          page.failure = info.isProxy
            ? 'Background browser proxy authentication is unavailable.'
            : 'Background browser HTTP authentication requires an interactive session.';
        callback();
      }
    });
  }
}
