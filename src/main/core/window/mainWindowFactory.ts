import { randomUUID } from 'crypto';
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
} from 'electron';
import fs from 'fs';
import path from 'path';

import { MediaCaptureIpc, MediaCaptureSurface } from '../../../shared/app/mediaCapture';
import {
  BROWSER_GUEST_COMMAND_CHANNEL,
  BROWSER_IMPORTED_PROFILE_PARTITION,
  BROWSER_PANEL_PARTITION,
  type BrowserDownloadSettings,
  BrowserIpc,
  browserProfileFromPartition,
  DEFAULT_BROWSER_PANEL_SHORTCUTS,
  normalizeBrowserPanelHttpAuthResponse,
  normalizeBrowserPanelShortcutSettings,
  resolveBrowserGuestShortcut,
  resolveBrowserPanelShortcutAction,
} from '../../../shared/browser/browser';
import type { WorkspaceWindowBounds } from '../../../shared/cowork/workspaceWindow';
import {
  recordBrowserDownload,
  updateBrowserDownload,
} from '../../browser/data/browserDataImportService';
import { sanitizeBrowserUrl } from '../../browser/data/browserDataSanitizers';
import {
  cancelAllBrowserAgentDownloads,
  claimBrowserAgentDownload,
} from '../../browser/downloads/browserAgentDownloadCoordinator';
import {
  resolveAvailableBrowserDownloadPath,
  resolveBrowserDownloadDirectory,
} from '../../browser/downloads/browserDownloadPath';
import { trackBrowserFavicon } from '../../browser/history/browserFavicon';
import { trackBrowserHistory } from '../../browser/history/browserHistoryTracking';
import {
  isAllowedLocalHtmlPreviewResource,
  isLocalHtmlPreviewUrl,
  isSameLocalHtmlPreviewScope,
} from '../../browser/preview/localHtmlPreviewServer';
import {
  importFileOriginRendererPreferences,
  type RendererPreferenceStore,
} from '../app/rendererPreferencesImporter';
import { t } from '../i18n';
import { registerBrowserProxySession } from '../network/systemProxyPreference';
import { BrowserHttpAuthRequests, BrowserPermissionState } from './browserPanelRequestState';
import {
  browserPermissionKeys,
  isAllowedBrowserPanelUrl,
  isAllowedExternalBrowserUrl,
  isAllowedMainWindowNavigation,
  isBlockedBrowserMetadataHost,
  isBrowserPdfStreamNavigation,
  shouldAllowBrowserPanelPermission,
  shouldOpenMainWindowLinkExternally,
  shouldPromptBrowserPanelPermission,
} from './browserPanelSecurity';
import {
  shouldAllowAudioMediaCheck,
  shouldAllowAudioMediaRequest,
  shouldAllowSystemAudioCapture,
} from './mediaPermission';
import { loadPackagedRenderer } from './renderer/packagedRendererLoader';
import { getWindowChromeOptions } from './windowChrome';
import { registerWindowDiagnostics } from './windowDiagnostics';
import { WorkspaceWindowManager } from './workspaceWindowManager';

type MainWindowFactoryOptions = {
  appName: string;
  browserGuestPreloadPath: string;
  devServerUrl: string;
  getBackgroundColor: () => string;
  getIconPath: () => string | undefined;
  getRendererPreferenceStore: () => RendererPreferenceStore;
  getBrowserDownloadSettings: () => BrowserDownloadSettings;
  getProxyCredentials: () => {
    host: string;
    password: string;
    port: number;
    username: string;
  } | null;
  getTitleBarOverlay: () => Electron.TitleBarOverlay;
  showSystemMenu: (window: BrowserWindow, position?: { x: number; y: number }) => void;
  isDev: boolean;
  isMac: boolean;
  isQuitting: () => boolean;
  isWindows: boolean;
  onDidFinishLoad: (window: BrowserWindow) => void;
  onReadyToShow: (window: BrowserWindow) => void;
  onWindowStateChanged: (window: BrowserWindow) => void;
  preloadPath: string;
  scheduleReload: (reason: string) => void;
  readWorkspaceWindowBounds: () => unknown;
  saveWorkspaceWindowBounds: (bounds: WorkspaceWindowBounds) => void;
};

const DEV_LOAD_MAX_RETRIES = 3;
const LOAD_RETRY_DELAY_MS = 3_000;
const LOAD_TIMEOUT_MS = 30_000;
const CHAT_TIMELINE_TRACE_PREFIX = '[ChatTimelineTrace] ';
const CHAT_TIMELINE_TRACE_MAX_BYTES = 64 * 1024;
const SYSTEM_AUDIO_CAPTURE_AUTHORIZATION_TTL_MS = 5_000;
const BROWSER_HTTP_AUTH_TIMEOUT_MS = 120_000;

const isSameCaptureFrame = (
  left: Electron.WebFrameMain | undefined | null,
  right: Electron.WebFrameMain | undefined,
): boolean => {
  try {
    return (
      !!left && !!right && left.processId === right.processId && left.routingId === right.routingId
    );
  } catch {
    return false;
  }
};

export const createMainWindow = (options: MainWindowFactoryOptions): BrowserWindow => {
  let workspaceManager: WorkspaceWindowManager | undefined;
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: options.appName,
    icon: options.getIconPath(),
    ...getWindowChromeOptions(options.isMac, options.isWindows, options.getTitleBarOverlay()),
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      preload: options.preloadPath,
      backgroundThrottling: false,
      devTools: options.isDev,
      spellcheck: false,
      enableWebSQL: false,
      autoplayPolicy: 'document-user-activation-required',
      disableDialogs: true,
      navigateOnDragDrop: false,
    },
    backgroundColor: options.getBackgroundColor(),
    show: false,
    autoHideMenuBar: true,
    enableLargerThanScreen: false,
  });

  registerWindowDiagnostics(mainWindow.webContents, 'MainWindow');
  if (options.isMac && options.isDev) {
    const iconPath = path.join(__dirname, '../resources/icons/png/512x512.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  mainWindow.setMenu(null);
  mainWindow.setMinimumSize(800, 600);
  let systemAudioCaptureAuthorizedUntil = 0;
  let systemAudioCaptureFrame: Electron.WebFrameMain | undefined;
  ipcMain.removeHandler(MediaCaptureIpc.ArmSystemAudio);
  ipcMain.handle(
    MediaCaptureIpc.ArmSystemAudio,
    (event, surface: unknown = MediaCaptureSurface.Main) => {
      if (
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      ) {
        throw new Error('System audio capture can only be armed by the main application frame.');
      }
      if (surface !== MediaCaptureSurface.Main && surface !== MediaCaptureSurface.Workspace)
        throw new Error('Unknown capture surface.');
      systemAudioCaptureFrame =
        surface === MediaCaptureSurface.Workspace
          ? workspaceManager?.captureFrame()
          : mainWindow.webContents.mainFrame;
      if (!systemAudioCaptureFrame) throw new Error('Capture surface is unavailable.');
      systemAudioCaptureAuthorizedUntil = Date.now() + SYSTEM_AUDIO_CAPTURE_AUTHORIZATION_TTL_MS;
    },
  );
  mainWindow.once('closed', () => {
    ipcMain.removeHandler(MediaCaptureIpc.ArmSystemAudio);
    systemAudioCaptureAuthorizedUntil = 0;
    systemAudioCaptureFrame = undefined;
  });
  const windowSession = mainWindow.webContents.session;
  const browserPanelSession = session.fromPartition(BROWSER_PANEL_PARTITION);
  const importedBrowserSession = session.fromPartition(BROWSER_IMPORTED_PROFILE_PARTITION);
  const browserPanelSessions = new Map<string, Electron.Session>([
    [BROWSER_PANEL_PARTITION, browserPanelSession],
    [BROWSER_IMPORTED_PROFILE_PARTITION, importedBrowserSession],
  ]);
  const browserPermissions = new BrowserPermissionState();
  const pendingBrowserHttpAuth = new BrowserHttpAuthRequests(
    BROWSER_HTTP_AUTH_TIMEOUT_MS,
    event => {
      if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(BrowserIpc.PanelHttpAuthDismissed, event);
      }
    },
  );
  let browserPermissionPromptQueue = Promise.resolve();
  type BrowserPermissionRequestDetails = {
    mediaTypes?: Array<'video' | 'audio'>;
    requestingUrl?: string;
    securityOrigin?: string;
  };
  const normalizeBrowserPermissionOrigin = (value: string | undefined): string | null => {
    try {
      if (!value) return null;
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  };
  const browserPermissionOrigin = (
    webContents: Electron.WebContents,
    details: BrowserPermissionRequestDetails,
  ): string | null =>
    normalizeBrowserPermissionOrigin(
      details.securityOrigin || details.requestingUrl || webContents.getURL(),
    );
  const browserPermissionMediaType = (
    permission: string,
    details: BrowserPermissionRequestDetails,
  ): string => {
    if (permission !== 'media') return '';
    return [...(details.mediaTypes ?? [])].sort().join(',');
  };
  const browserPermissionLabel = (permission: string, mediaType: string): string => {
    if (permission === 'geolocation') return t('browserPermissionLocation');
    if (permission === 'notifications') return t('browserPermissionNotifications');
    if (mediaType === 'audio,video') return t('browserPermissionCameraAndMicrophone');
    if (mediaType === 'video') return t('browserPermissionCamera');
    return t('browserPermissionMicrophone');
  };
  const configureBrowserSessionPermissions = (browserSession: Electron.Session): void => {
    browserSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        if (shouldAllowBrowserPanelPermission(permission, Boolean(webContents?.isFocused()))) {
          return true;
        }
        if (
          !webContents ||
          !shouldPromptBrowserPanelPermission(permission, webContents.isFocused())
        ) {
          return false;
        }
        const origin = normalizeBrowserPermissionOrigin(requestingOrigin);
        return Boolean(
          origin &&
          browserPermissions.has(webContents.id, origin, permission, [
            details.mediaType ?? 'unknown',
          ]),
        );
      },
    );
    browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (shouldAllowBrowserPanelPermission(permission, webContents.isFocused())) {
        callback(true);
        return;
      }
      if (!shouldPromptBrowserPanelPermission(permission, webContents.isFocused())) {
        callback(false);
        return;
      }
      const requestDetails = details as BrowserPermissionRequestDetails;
      const origin = browserPermissionOrigin(webContents, requestDetails);
      if (!origin) {
        callback(false);
        return;
      }
      const keys = browserPermissionKeys(origin, permission, requestDetails.mediaTypes);
      if (!keys.length) {
        callback(false);
        return;
      }
      if (browserPermissions.has(webContents.id, origin, permission, requestDetails.mediaTypes)) {
        callback(true);
        return;
      }
      const mediaType = browserPermissionMediaType(permission, requestDetails);
      const generationIsCurrent = browserPermissions.capture(webContents.id);
      const isCurrentDocument = (): boolean => !webContents.isDestroyed() && generationIsCurrent();
      const requestPermission = async (): Promise<void> => {
        try {
          if (!isCurrentDocument() || !webContents.isFocused()) {
            callback(false);
            return;
          }
          const result = await dialog.showMessageBox(
            workspaceManager?.presentationWindow(webContents.hostWebContents?.id) ?? mainWindow,
            {
              type: 'question',
              title: t('browserPermissionTitle'),
              message: t('browserPermissionMessage', {
                site: new URL(origin).host,
                permission: browserPermissionLabel(permission, mediaType),
              }),
              detail: origin,
              buttons: [t('browserPermissionAllow'), t('browserPermissionDeny')],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            },
          );
          const stillSamePage = isCurrentDocument();
          const granted = result.response === 0 && stillSamePage;
          if (granted) {
            browserPermissions.grant(webContents.id, origin, permission, requestDetails.mediaTypes);
          }
          callback(granted);
        } catch {
          callback(false);
        }
      };
      browserPermissionPromptQueue = browserPermissionPromptQueue.then(
        requestPermission,
        requestPermission,
      );
    });
  };
  const localPreviewScopesByGuestId = new Map<number, string>();
  let browserPanelShortcuts = DEFAULT_BROWSER_PANEL_SHORTCUTS;
  const handleBrowserPanelShortcuts = (event: Electron.IpcMainEvent, value: unknown) => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return;
    const normalized = normalizeBrowserPanelShortcutSettings(value);
    if (normalized) browserPanelShortcuts = normalized;
  };
  ipcMain.on(BrowserIpc.PanelSetShortcuts, handleBrowserPanelShortcuts);
  const handleBrowserHttpAuthResponse = (event: Electron.IpcMainEvent, value: unknown) => {
    if (
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      return;
    }
    const response = normalizeBrowserPanelHttpAuthResponse(value);
    if (!response) return;
    if (!pendingBrowserHttpAuth.belongsTo(response.id, response.guestId)) return;
    pendingBrowserHttpAuth.resolve(
      response.id,
      response.username === undefined || response.password === undefined
        ? undefined
        : { username: response.username, password: response.password },
    );
  };
  ipcMain.on(BrowserIpc.PanelHttpAuthResponse, handleBrowserHttpAuthResponse);
  mainWindow.once('closed', () => {
    ipcMain.off(BrowserIpc.PanelSetShortcuts, handleBrowserPanelShortcuts);
    ipcMain.off(BrowserIpc.PanelHttpAuthResponse, handleBrowserHttpAuthResponse);
    pendingBrowserHttpAuth.dispose();
  });
  for (const browserSession of browserPanelSessions.values()) {
    configureBrowserSessionPermissions(browserSession);
  }
  windowSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (
      webContents !== mainWindow.webContents &&
      !workspaceManager?.ownsHost(webContents?.id ?? -1)
    )
      return false;
    if (permission !== 'media') return true;
    return shouldAllowAudioMediaCheck(true, details);
  });
  windowSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (webContents !== mainWindow.webContents && !workspaceManager?.ownsHost(webContents.id)) {
      callback(false);
      return;
    }
    if (permission !== 'media') {
      callback(true);
      return;
    }
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const allowed = shouldAllowAudioMediaRequest(true, mediaTypes);
    callback(allowed);
  });
  windowSession.setDisplayMediaRequestHandler((request, callback) => {
    const isMainFrame =
      isSameCaptureFrame(request.frame, mainWindow.webContents.mainFrame) ||
      isSameCaptureFrame(request.frame, workspaceManager?.captureFrame());
    const authorizedByRenderer =
      isMainFrame &&
      isSameCaptureFrame(request.frame, systemAudioCaptureFrame) &&
      Date.now() <= systemAudioCaptureAuthorizedUntil;
    if (isSameCaptureFrame(request.frame, systemAudioCaptureFrame)) {
      systemAudioCaptureAuthorizedUntil = 0;
      systemAudioCaptureFrame = undefined;
    }
    const allowed = shouldAllowSystemAudioCapture({
      audioRequested: request.audioRequested,
      authorizedByRenderer,
      isMainFrame,
      videoRequested: request.videoRequested,
      isWindows: process.platform === 'win32',
    });
    if (!allowed) {
      callback({});
      return;
    }
    void desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then(sources => {
        const primarySource = sources[0];
        if (!primarySource || mainWindow.isDestroyed()) {
          console.warn('[SystemAudioCapture] No usable desktop source is available.');
          callback({});
          return;
        }
        callback({ video: primarySource, audio: 'loopback' });
      })
      .catch(error => {
        console.warn(
          '[SystemAudioCapture] Failed to enumerate desktop sources:',
          error instanceof Error ? error.message : String(error),
        );
        callback({});
      });
  });
  const mainNavigationOptions = {
    devServerUrl: options.devServerUrl,
    isDev: options.isDev,
    applicationUrl: undefined as string | undefined,
  };
  const openExternalLink = (url: string): void => {
    if (shouldOpenMainWindowLinkExternally(url, mainNavigationOptions))
      void shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(details => {
    const allowedWorkspace = workspaceManager?.handleOpen(details);
    if (allowedWorkspace) return allowedWorkspace;
    openExternalLink(details.url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    if (!isAllowedMainWindowNavigation(event.url, mainNavigationOptions)) event.preventDefault();
  });
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame && !isAllowedMainWindowNavigation(event.url, mainNavigationOptions)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', event => {
    if (event.isMainFrame && !isAllowedMainWindowNavigation(event.url, mainNavigationOptions)) {
      event.preventDefault();
    }
  });
  const configureBrowserHost = (host: Electron.WebContents): void => {
    host.on('will-attach-webview', (event, webPreferences, params) => {
      webPreferences.preload = options.browserGuestPreloadPath;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;
      webPreferences.webviewTag = false;
      webPreferences.plugins = true;
      webPreferences.spellcheck = true;
      // The Agent dialog action observes and resolves dialogs through the exact
      // guest WebContents debugger. Keep browser-page dialogs enabled while the
      // application renderer itself remains protected above.
      webPreferences.disableDialogs = false;
      webPreferences.navigateOnDragDrop = false;

      if (!browserProfileFromPartition(params.partition) || !isAllowedBrowserPanelUrl(params.src)) {
        event.preventDefault();
        return;
      }
      if (!browserPanelSessions.has(params.partition)) {
        const browserSession = session.fromPartition(params.partition);
        browserPanelSessions.set(params.partition, browserSession);
        void registerBrowserProxySession(browserSession);
        configureBrowserSessionPermissions(browserSession);
        installBrowserRequestGuard(browserSession);
        installBrowserPdfDetection(browserSession);
        browserSession.on('will-download', handleBrowserDownload);
      }
    });
    host.on('did-attach-webview', (_event, guestContents) => {
      let localPreviewScopeUrl = isLocalHtmlPreviewUrl(guestContents.getURL())
        ? guestContents.getURL()
        : null;
      const bindLocalPreviewScope = (url: string): void => {
        if (localPreviewScopeUrl || !isLocalHtmlPreviewUrl(url)) return;
        localPreviewScopeUrl = url;
        localPreviewScopesByGuestId.set(guestContents.id, url);
      };
      if (localPreviewScopeUrl) {
        localPreviewScopesByGuestId.set(guestContents.id, localPreviewScopeUrl);
      }
      const canNavigateWithinPreviewScope = (url: string): boolean => {
        return !localPreviewScopeUrl || isSameLocalHtmlPreviewScope(localPreviewScopeUrl, url);
      };
      let externalProtocolPromptPending = false;
      const requestExternalProtocol = (url: string): void => {
        if (externalProtocolPromptPending || !isAllowedExternalBrowserUrl(url)) return;
        externalProtocolPromptPending = true;
        void dialog
          .showMessageBox(workspaceManager?.presentationWindow(host.id) ?? mainWindow, {
            type: 'question',
            title: t('browserExternalProtocolTitle'),
            message: t('browserExternalProtocolMessage'),
            detail: url.slice(0, 2_048),
            buttons: [t('browserExternalProtocolConfirm'), t('browserExternalProtocolCancel')],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          })
          .then(async result => {
            if (result.response === 0 && !mainWindow.isDestroyed()) await shell.openExternal(url);
          })
          .catch(() => {
            if (!mainWindow.isDestroyed()) {
              void dialog
                .showMessageBox(mainWindow, {
                  type: 'error',
                  title: t('browserExternalProtocolTitle'),
                  message: t('browserExternalProtocolFailed'),
                })
                .catch((): void => {});
            }
          })
          .finally(() => {
            externalProtocolPromptPending = false;
          });
      };
      guestContents.setWindowOpenHandler(details => {
        const { url } = details;
        if (isAllowedExternalBrowserUrl(url)) {
          requestExternalProtocol(url);
          return { action: 'deny' };
        }
        if (!canNavigateWithinPreviewScope(url)) return { action: 'deny' };
        if (details.postBody) {
          mainWindow.webContents.send(BrowserIpc.PanelOpenTab, {
            url,
            openerGuestId: guestContents.id,
            errorCode: 'post-navigation-blocked',
          });
          return { action: 'deny' };
        }
        if (isAllowedBrowserPanelUrl(url)) {
          mainWindow.webContents.send(BrowserIpc.PanelOpenTab, {
            url: url || 'about:blank',
            openerGuestId: guestContents.id,
          });
        }
        return { action: 'deny' };
      });
      guestContents.on('before-input-event', (event, input) => {
        const shortcutAction =
          input.type === 'keyDown' && !input.isAutoRepeat
            ? resolveBrowserPanelShortcutAction(
                {
                  key: input.key,
                  altKey: input.alt,
                  ctrlKey: input.control,
                  shiftKey: input.shift,
                  metaKey: input.meta,
                },
                browserPanelShortcuts,
              )
            : null;
        if (shortcutAction) {
          event.preventDefault();
          mainWindow.webContents.send(BrowserIpc.PanelShortcutAction, shortcutAction);
          return;
        }
        const command = resolveBrowserGuestShortcut(input);
        if (!command) return;
        event.preventDefault();
        guestContents.send(BROWSER_GUEST_COMMAND_CHANNEL, command);
      });
      guestContents.on('will-navigate', (event, url) => {
        bindLocalPreviewScope(url);
        if (isAllowedExternalBrowserUrl(url)) {
          event.preventDefault();
          requestExternalProtocol(url);
          return;
        }
        if (!isAllowedBrowserPanelUrl(url) || !canNavigateWithinPreviewScope(url)) {
          event.preventDefault();
        }
      });
      guestContents.on('will-frame-navigate', event => {
        if (isBrowserPdfStreamNavigation(event.url, event.isMainFrame, event.frame?.parent?.url)) {
          return;
        }
        if (event.isMainFrame) bindLocalPreviewScope(event.url);
        if (!isAllowedBrowserPanelUrl(event.url) || !canNavigateWithinPreviewScope(event.url)) {
          event.preventDefault();
        }
      });
      guestContents.on('will-redirect', (event, url) => {
        if (!isAllowedBrowserPanelUrl(url) || !canNavigateWithinPreviewScope(url)) {
          event.preventDefault();
        }
      });
      const recordFaviconData = trackBrowserHistory(guestContents, () => !localPreviewScopeUrl);
      trackBrowserFavicon(
        guestContents,
        (event, cacheSignal) => {
          if (!mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send(BrowserIpc.PanelFaviconUpdated, event);
          }
          if (event.faviconUrl) {
            try {
              recordFaviconData(event.faviconUrl, cacheSignal);
            } catch {
              console.warn('[BrowserFavicon] Could not persist the loaded icon.');
            }
          }
        },
        url =>
          !localPreviewScopeUrl || isAllowedLocalHtmlPreviewResource(localPreviewScopeUrl, url),
      );
      guestContents.on('context-menu', (_contextEvent, params) => {
        const template: Electron.MenuItemConstructorOptions[] = [];
        if (params.linkURL && isAllowedBrowserPanelUrl(params.linkURL)) {
          template.push(
            {
              label: t('browserContextOpenLinkNewTab'),
              click: () => {
                if (!canNavigateWithinPreviewScope(params.linkURL)) return;
                mainWindow.webContents.send(BrowserIpc.PanelOpenTab, {
                  url: params.linkURL,
                  openerGuestId: guestContents.id,
                });
              },
            },
            {
              label: t('browserContextCopyLink'),
              click: () => clipboard.writeText(params.linkURL),
            },
            { type: 'separator' },
          );
        }
        if (params.isEditable) {
          template.push(
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
            { type: 'separator' },
          );
        } else if (params.selectionText) {
          template.push({ role: 'copy' }, { type: 'separator' });
        }
        if (
          params.mediaType === 'image' &&
          params.srcURL &&
          isAllowedBrowserPanelUrl(params.srcURL)
        ) {
          template.push(
            {
              label: t('browserContextSaveImage'),
              click: () => guestContents.downloadURL(params.srcURL),
            },
            { type: 'separator' },
          );
        }
        template.push(
          {
            label: t('browserContextBack'),
            enabled: guestContents.navigationHistory.canGoBack(),
            click: () => guestContents.navigationHistory.goBack(),
          },
          {
            label: t('browserContextForward'),
            enabled: guestContents.navigationHistory.canGoForward(),
            click: () => guestContents.navigationHistory.goForward(),
          },
          { label: t('browserContextReload'), click: () => guestContents.reload() },
        );
        Menu.buildFromTemplate(template).popup({
          window: workspaceManager?.presentationWindow(host.id) ?? mainWindow,
        });
      });
      guestContents.once('destroyed', () => {
        localPreviewScopesByGuestId.delete(guestContents.id);
        browserPermissions.destroy(guestContents.id);
        pendingBrowserHttpAuth.cancelGuest(guestContents.id);
      });
      guestContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace) return;
        browserPermissions.invalidate(guestContents.id);
        if (isMainFrame) {
          pendingBrowserHttpAuth.cancelGuest(guestContents.id);
        }
      });
      guestContents.on('login', (event, _details, authInfo, callback) => {
        const credentials = options.getProxyCredentials();
        const matchesConfiguredProxy =
          authInfo.isProxy &&
          credentials &&
          authInfo.host.toLowerCase() === credentials.host.toLowerCase() &&
          authInfo.port === credentials.port;
        if (matchesConfiguredProxy) {
          event.preventDefault();
          callback(credentials.username, credentials.password);
          return;
        }
        if (authInfo.isProxy || mainWindow.isDestroyed() || guestContents.isDestroyed()) {
          callback();
          return;
        }
        event.preventDefault();
        const id = randomUUID();
        pendingBrowserHttpAuth.add(id, guestContents.id, callback);
        mainWindow.webContents.send(BrowserIpc.PanelHttpAuthRequest, {
          id,
          guestId: guestContents.id,
          host: authInfo.host,
          port: authInfo.port,
          realm: authInfo.realm,
          scheme: authInfo.scheme,
        });
      });
    });
  };
  const installBrowserRequestGuard = (browserSession: Electron.Session) =>
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const localPreviewScopeUrl = localPreviewScopesByGuestId.get(details.webContentsId);
      const blockPreviewRequest = Boolean(
        localPreviewScopeUrl &&
        !isAllowedLocalHtmlPreviewResource(localPreviewScopeUrl, details.url),
      );
      const isMainFrame = details.resourceType === 'mainFrame';
      const blockGuestMainFrame = isMainFrame && !isAllowedBrowserPanelUrl(details.url);
      if (blockPreviewRequest || blockGuestMainFrame) {
        callback({ cancel: true });
        return;
      }
      let requestUrl: URL;
      try {
        requestUrl = new URL(details.url);
      } catch {
        callback(isMainFrame ? { cancel: true } : {});
        return;
      }
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(requestUrl.protocol)) {
        callback({});
        return;
      }
      const hostname = requestUrl.hostname;
      if (!hostname || isBlockedBrowserMetadataHost(hostname)) {
        callback({ cancel: true });
        return;
      }
      // Resolve through this exact partition so Chromium's subsequent connection
      // shares the same host-resolver cache entry instead of racing a separate
      // default-session lookup.
      void browserSession
        .resolveHost(hostname)
        .then(result => {
          const addresses = result.endpoints.map(endpoint => endpoint.address);
          const allowRequest =
            addresses.length > 0 &&
            addresses.every(address => !isBlockedBrowserMetadataHost(address));
          callback(allowRequest ? {} : { cancel: true });
        })
        .catch(() => callback({ cancel: true }));
    });
  const installBrowserPdfDetection = (browserSession: Electron.Session) =>
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      const contentType = Object.entries(details.responseHeaders ?? {}).find(
        ([name]) => name.toLowerCase() === 'content-type',
      )?.[1];
      if (
        details.resourceType === 'mainFrame' &&
        details.webContentsId &&
        contentType?.some(value => value.toLowerCase().includes('application/pdf'))
      ) {
        mainWindow.webContents.send(BrowserIpc.PanelPdfDetected, {
          url: details.url,
          guestId: details.webContentsId,
        });
      }
      callback({});
    });
  browserPanelSessions.forEach(browserSession => {
    installBrowserRequestGuard(browserSession);
    installBrowserPdfDetection(browserSession);
  });
  const pendingDownloads = new Set<Electron.DownloadItem>();
  const reservedDownloadPaths = new Set<string>();
  const downloadDefaultDirectories = new WeakMap<Electron.DownloadItem, string>();
  const downloadIds = new WeakMap<Electron.DownloadItem, string>();
  const downloadUpdateTimers = new Map<Electron.DownloadItem, NodeJS.Timeout>();
  const pendingDownloadStates = new WeakMap<Electron.DownloadItem, 'progressing' | 'interrupted'>();
  const persistDownloadUpdate = (
    item: Electron.DownloadItem,
    state: 'queued' | 'progressing' | 'completed' | 'cancelled' | 'interrupted',
    savePath?: string,
  ): void => {
    const id = downloadIds.get(item);
    if (!id) return;
    try {
      updateBrowserDownload(id, {
        state,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        savePath,
      });
    } catch (error) {
      console.warn(
        '[BrowserPanel] Failed to persist download state:',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const scheduleDownloadUpdate = (
    item: Electron.DownloadItem,
    state: 'progressing' | 'interrupted',
  ): void => {
    pendingDownloadStates.set(item, state);
    if (downloadUpdateTimers.has(item)) return;
    const timer = setTimeout(() => {
      downloadUpdateTimers.delete(item);
      persistDownloadUpdate(item, pendingDownloadStates.get(item) ?? 'progressing');
    }, 300);
    timer.unref();
    downloadUpdateTimers.set(item, timer);
  };
  let downloadConfirmationQueue = Promise.resolve();
  const confirmBrowserDownload = async (item: Electron.DownloadItem): Promise<void> => {
    if (!pendingDownloads.has(item) || mainWindow.isDestroyed()) return;
    const suggestedName = path.basename(item.getFilename()) || 'download';
    const defaultDirectory = downloadDefaultDirectories.get(item) ?? app.getPath('downloads');
    try {
      const result = await dialog.showSaveDialog(workspaceManager?.focusedWindow() ?? mainWindow, {
        defaultPath: path.join(defaultDirectory, suggestedName),
      });
      if (
        result.canceled ||
        !result.filePath ||
        mainWindow.isDestroyed() ||
        item.getState() !== 'progressing'
      ) {
        item.cancel();
        return;
      }
      item.setSavePath(result.filePath);
      persistDownloadUpdate(item, 'progressing', result.filePath);
      item.resume();
    } catch (error) {
      item.cancel();
      console.warn(
        '[BrowserPanel] Failed to choose a download destination:',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      pendingDownloads.delete(item);
    }
  };
  const handleBrowserDownload = (
    _event: Electron.Event,
    item: Electron.DownloadItem,
    originWebContents?: Electron.WebContents,
  ): void => {
    const id = randomUUID();
    const now = Date.now();
    const settings = options.getBrowserDownloadSettings();
    const downloadDirectory = resolveBrowserDownloadDirectory(
      settings.directory,
      app.getPath('downloads'),
    );
    const downloadSession = originWebContents?.session ?? browserPanelSession;
    const agentClaim = claimBrowserAgentDownload(downloadSession, item, originWebContents);
    if (agentClaim?.cancelled) {
      item.cancel();
      return;
    }
    const askWhereToSave = agentClaim ? false : settings.askWhereToSave;
    const automaticSavePath =
      agentClaim?.savePath ??
      (askWhereToSave
        ? undefined
        : resolveAvailableBrowserDownloadPath(
            downloadDirectory,
            item.getFilename(),
            candidate => reservedDownloadPaths.has(candidate) || fs.existsSync(candidate),
          ));
    downloadIds.set(item, id);
    downloadDefaultDirectories.set(item, downloadDirectory);
    if (automaticSavePath) reservedDownloadPaths.add(automaticSavePath);
    try {
      recordBrowserDownload(
        {
          id,
          fileName: path.basename(item.getFilename()) || 'download',
          sourceUrl: sanitizeBrowserUrl(item.getURL()),
          state: askWhereToSave ? 'queued' : 'progressing',
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          startedAt: now,
          updatedAt: now,
        },
        automaticSavePath,
      );
    } catch (error) {
      console.warn(
        '[BrowserPanel] Failed to record download:',
        error instanceof Error ? error.message : String(error),
      );
    }
    item.on('updated', (_downloadEvent, state) => {
      scheduleDownloadUpdate(item, state === 'interrupted' ? 'interrupted' : 'progressing');
    });
    item.once('done', (_downloadEvent, state) => {
      const timer = downloadUpdateTimers.get(item);
      if (timer) clearTimeout(timer);
      downloadUpdateTimers.delete(item);
      persistDownloadUpdate(item, state);
      pendingDownloads.delete(item);
      if (automaticSavePath) reservedDownloadPaths.delete(automaticSavePath);
      agentClaim?.settle(item, state);
    });
    if (askWhereToSave) {
      item.pause();
      pendingDownloads.add(item);
      downloadConfirmationQueue = downloadConfirmationQueue.then(
        () => confirmBrowserDownload(item),
        () => confirmBrowserDownload(item),
      );
    } else if (automaticSavePath) {
      try {
        item.setSavePath(automaticSavePath);
      } catch (error) {
        reservedDownloadPaths.delete(automaticSavePath);
        item.cancel();
        persistDownloadUpdate(item, 'cancelled');
        console.warn(
          '[BrowserPanel] Failed to apply the automatic download destination:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };
  browserPanelSessions.forEach(browserSession =>
    browserSession.on('will-download', handleBrowserDownload),
  );
  mainWindow.once('closed', () => {
    browserPanelSessions.forEach(browserSession =>
      browserSession.off('will-download', handleBrowserDownload),
    );
    downloadUpdateTimers.forEach(timer => clearTimeout(timer));
    downloadUpdateTimers.clear();
    pendingDownloads.forEach(item => item.cancel());
    pendingDownloads.clear();
    cancelAllBrowserAgentDownloads();
    reservedDownloadPaths.clear();
  });
  if (options.isDev && process.env.JUSTDO_DEBUG_CHAT_TIMELINE === 'true') {
    mainWindow.webContents.on('console-message', details => {
      if (
        details.message.startsWith(CHAT_TIMELINE_TRACE_PREFIX) &&
        Buffer.byteLength(details.message, 'utf8') <= CHAT_TIMELINE_TRACE_MAX_BYTES
      ) {
        console.info(details.message);
      }
    });
  }

  const prepareWorkspaceWindow = (applicationUrl: string): void => {
    workspaceManager ??= new WorkspaceWindowManager(mainWindow, {
      url: new URL('workspace.html', applicationUrl).toString(),
      icon: options.getIconPath(),
      getBackgroundColor: options.getBackgroundColor,
      getTitleBarOverlay: options.getTitleBarOverlay,
      isMac: options.isMac,
      isWindows: options.isWindows,
      showSystemMenu: options.showSystemMenu,
      isQuitting: options.isQuitting,
      configureHost: configureBrowserHost,
      openExternal: openExternalLink,
      readBounds: options.readWorkspaceWindowBounds,
      saveBounds: options.saveWorkspaceWindowBounds,
    });
  };
  if (options.isDev) prepareWorkspaceWindow(options.devServerUrl);

  const loadTimeout = options.isDev
    ? undefined
    : setTimeout(() => {
        if (!mainWindow.isDestroyed() && mainWindow.webContents.isLoadingMainFrame()) {
          console.log('[MainWindow] Load timed out, attempting to reload.');
          options.scheduleReload('load-timeout');
        }
      }, LOAD_TIMEOUT_MS);

  mainWindow.webContents.once('did-finish-load', () => {
    if (loadTimeout) {
      clearTimeout(loadTimeout);
    }
  });
  mainWindow.once('closed', () => {
    if (loadTimeout) clearTimeout(loadTimeout);
  });
  mainWindow.webContents.on('did-finish-load', () => options.onDidFinishLoad(mainWindow));

  mainWindow.on('close', event => {
    if (!options.isQuitting() && !options.isDev) {
      event.preventDefault();
      workspaceManager?.hideWithOwner();
      mainWindow.hide();
    }
  });

  if (options.isDev) {
    let retryCount = 0;
    const tryLoadUrl = (): void => {
      void mainWindow.loadURL(options.devServerUrl).catch(error => {
        console.error('[MainWindow] Failed to load development URL:', error);
        retryCount += 1;
        if (retryCount < DEV_LOAD_MAX_RETRIES) {
          setTimeout(tryLoadUrl, LOAD_RETRY_DELAY_MS);
          return;
        }
        console.error('[MainWindow] Failed to load development URL after maximum retries.');
        if (!mainWindow.isDestroyed()) {
          void mainWindow
            .loadFile(path.join(__dirname, '../resources/error.html'))
            .catch(error => console.error('[MainWindow] Failed to load the error page:', error));
        }
      });
    };
    tryLoadUrl();

    mainWindow.webContents.on('before-input-event', (_event, input) => {
      const isDevtoolsShortcut =
        input.key === 'F12' ||
        ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');

      if (isDevtoolsShortcut) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  } else {
    void loadPackagedRenderer(
      mainWindow,
      app,
      path.join(__dirname, '../dist'),
      url => {
        mainNavigationOptions.applicationUrl = url;
        if (url) prepareWorkspaceWindow(url);
      },
      () =>
        importFileOriginRendererPreferences({
          resourcePath: path.join(__dirname, '../resources/renderer-preferences.html'),
          session: mainWindow.webContents.session,
          store: options.getRendererPreferenceStore(),
          isCurrent: () => !mainWindow.isDestroyed() && !options.isQuitting(),
        }),
    ).catch(error => {
      console.error('[MainWindow] Failed to load packaged renderer:', error);
    });
  }

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _url, isMainFrame) => {
      if (options.isDev && isMainFrame && errorCode !== -3) {
        setTimeout(() => options.scheduleReload('did-fail-load'), LOAD_RETRY_DELAY_MS);
      }
    },
  );

  const forwardWindowState = (): void => options.onWindowStateChanged(mainWindow);
  mainWindow.on('maximize', forwardWindowState);
  mainWindow.on('unmaximize', forwardWindowState);
  mainWindow.on('enter-full-screen', forwardWindowState);
  mainWindow.on('leave-full-screen', forwardWindowState);
  mainWindow.on('focus', forwardWindowState);
  mainWindow.on('blur', forwardWindowState);

  mainWindow.once('ready-to-show', () => options.onReadyToShow(mainWindow));
  configureBrowserHost(mainWindow.webContents);
  return mainWindow;
};
