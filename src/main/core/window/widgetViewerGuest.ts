import { ipcMain, session } from 'electron';

import {
  WIDGET_VIEWER_PARTITION,
  WidgetViewerIpc,
  widgetViewerMount,
} from '../../../shared/widgets/viewer';
import { registerBrowserProxySession } from '../network/systemProxyPreference';
import { registerContentSecurityPolicy } from './contentSecurityPolicy';

type ProxyCredentials = { host: string; port: number; username: string; password: string };
const guests = new Map<
  number,
  { guest: Electron.WebContents; host: Electron.WebContents; mount: string; ready: Promise<void> }
>();
const configuredSessions = new WeakSet<Electron.Session>();
let handlerInstalled = false;

export function createWidgetViewerGuests(
  preload: string,
  getCredentials: () => ProxyCredentials | null,
  developmentCsp?: { isDev: boolean; devServerPort: number },
) {
  const viewerSession = session.fromPartition(WIDGET_VIEWER_PARTITION, { cache: false });
  const prepareProxy = () => {
    const ready = registerBrowserProxySession(viewerSession);
    // Each admission observes its own attempt; a later Retry can recover from a
    // failed registration instead of inheriting one rejected startup promise.
    void ready.catch(() => {});
    return ready;
  };
  void prepareProxy();
  if (!configuredSessions.has(viewerSession)) {
    configuredSessions.add(viewerSession);
    viewerSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    viewerSession.setPermissionCheckHandler(() => false);
    viewerSession.on('will-download', event => event.preventDefault());
    if (developmentCsp?.isDev) registerContentSecurityPolicy(developmentCsp, viewerSession);
  }
  const hosts = new Map<
    Electron.WebContents,
    { children: Set<Electron.WebContents>; dispose: () => void }
  >();
  if (!handlerInstalled) {
    handlerInstalled = true;
    ipcMain.handle(WidgetViewerIpc.ProxyReady, async event => {
      const binding = guests.get(event.sender.id);
      if (
        !binding ||
        binding.guest !== event.sender ||
        event.senderFrame !== event.sender.mainFrame ||
        binding.host.isDestroyed() ||
        !widgetViewerMount(event.senderFrame.url, binding.host.getURL())
      )
        throw new Error('Widget viewer unavailable');
      const mount = widgetViewerMount(event.senderFrame.url, binding.host.getURL())!;
      if (binding.mount && binding.mount !== mount) throw new Error('Widget viewer superseded');
      binding.mount = mount;
      await binding.ready;
      if (guests.get(event.sender.id) !== binding || binding.host.isDestroyed())
        throw new Error('Widget viewer superseded');
    });
  }
  return {
    prepare(
      event: Electron.Event,
      preferences: Electron.WebPreferences,
      params: Record<string, string>,
      host: Electron.WebContents,
    ): boolean {
      if (params.partition !== WIDGET_VIEWER_PARTITION) return false;
      if (!widgetViewerMount(params.src, host.getURL())) {
        event.preventDefault();
        return true;
      }
      Object.assign(preferences, {
        partition: WIDGET_VIEWER_PARTITION,
        session: viewerSession,
        preload,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        plugins: false,
        spellcheck: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      });
      return true;
    },
    attach(guest: Electron.WebContents, host: Electron.WebContents): boolean {
      if (guest.session !== viewerSession) return false;
      guests.set(guest.id, { guest, host, mount: '', ready: prepareProxy() });
      // getURL may still be empty at did-attach; admission was checked before attach.
      const revoke = () => {
        guests.delete(guest.id);
      };
      guest.setWindowOpenHandler(() => ({ action: 'deny' }));
      guest.on('will-navigate', event => event.preventDefault());
      guest.on('will-redirect', event => {
        if (event.isMainFrame) event.preventDefault();
      });
      guest.on('will-frame-navigate', event => {
        if (event.isMainFrame) event.preventDefault();
      });
      guest.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
        if (!mainFrame) return;
        const mount = widgetViewerMount(url, host.getURL());
        const binding = guests.get(guest.id);
        if (inPlace || !mount || !binding || binding.mount) {
          revoke();
          guest.stop();
          return;
        }
        binding.mount = mount;
      });
      guest.on('login', (event, _details, info, callback) => {
        event.preventDefault();
        const credentials = getCredentials();
        if (
          info.isProxy &&
          credentials &&
          info.host.toLowerCase() === credentials.host.toLowerCase() &&
          info.port === credentials.port
        )
          callback(credentials.username, credentials.password);
        else callback();
      });
      let owner = hosts.get(host);
      if (!owner) {
        const children = new Set<Electron.WebContents>();
        const destroy = () => {
          for (const child of [...children]) {
            guests.delete(child.id);
            if (!child.isDestroyed()) child.close();
          }
        };
        const onNavigation = (
          _event: Electron.Event,
          _url: string,
          inPlace: boolean,
          mainFrame: boolean,
        ) => {
          if (mainFrame && !inPlace) destroy();
        };
        const dispose = () => {
          host.removeListener('destroyed', destroy);
          host.removeListener('did-start-navigation', onNavigation);
          hosts.delete(host);
        };
        owner = { children, dispose };
        hosts.set(host, owner);
        host.once('destroyed', destroy);
        host.on('did-start-navigation', onNavigation);
      }
      owner.children.add(guest);
      guest.once('destroyed', () => {
        revoke();
        owner.children.delete(guest);
        if (!owner.children.size) owner.dispose();
      });
      return true;
    },
  };
}
