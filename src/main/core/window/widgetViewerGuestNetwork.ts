import { randomUUID } from 'node:crypto';

import { ipcMain, session } from 'electron';

import { ProxyMode } from '../../../shared/network/proxy';
import {
  WIDGET_NETWORK_CHECK_MS,
  WIDGET_NETWORK_LEASE_MS,
  WIDGET_NETWORK_PARTITION_PREFIX,
  type WidgetNetworkBinding,
  type WidgetNetworkCheckRequest,
  type WidgetNetworkClose,
  type WidgetNetworkCreate,
  type WidgetNetworkInstance,
  WidgetNetworkIpc,
  type WidgetNetworkRenew,
  type WidgetNetworkRevoked,
} from '../../../shared/widgets/network';
import { widgetViewerMount } from '../../../shared/widgets/viewer';
import {
  getBrowserProxyMode,
  onBrowserProxyWillChange,
  registerBrowserProxySession,
  unregisterBrowserProxySession,
} from '../network/systemProxyPreference';
import { buildApplicationContentSecurityPolicy } from './renderer/applicationContentSecurityPolicy';
import {
  classifyNetworkRequest,
  createNetworkPolicy,
  normalizedNetworkBinding,
  type RequestRole,
  sanitizedWidgetRequestHeaders,
  strictProxyRoute,
  validNetworkMount,
  type WidgetNetworkPolicy,
} from './widgetViewerGuestNetworkPolicy';

type Check = { nonce: string; started: number; frame: Electron.WebFrameMain; instanceId?: string };
type Entry = WidgetNetworkInstance & {
  owner: Electron.WebContents;
  ownerFrame: Electron.WebFrameMain;
  binding: WidgetNetworkBinding;
  policy: WidgetNetworkPolicy;
  session: Electron.Session;
  guest?: Electron.WebContents;
  host?: Electron.WebContents;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  prepared: boolean;
  disposeHost?: () => void;
};
const controllers = new Map<number, WidgetNetworkGuests>();
const instances = new Map<string, Entry>();
let ipcInstalled = false;
const unavailable = (): never => {
  throw new Error('Widget network unavailable');
};

function installIpc(): void {
  if (ipcInstalled) return;
  ipcInstalled = true;
  const dispatch = (event: Electron.IpcMainInvokeEvent): WidgetNetworkGuests => {
    const controller = controllers.get(event.sender.id);
    if (!controller || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      return unavailable();
    return controller;
  };
  ipcMain.handle(WidgetNetworkIpc.BeginCheck, (event, value: WidgetNetworkCheckRequest) =>
    dispatch(event).beginCheck(value),
  );
  ipcMain.handle(WidgetNetworkIpc.Create, (event, value: WidgetNetworkCreate) =>
    dispatch(event).create(value),
  );
  ipcMain.handle(WidgetNetworkIpc.Renew, (event, value: WidgetNetworkRenew) =>
    dispatch(event).renew(value),
  );
  ipcMain.handle(WidgetNetworkIpc.Close, (event, value: WidgetNetworkClose) =>
    dispatch(event).close(value),
  );
}

/** Each entry has its own ephemeral session; the author never owns this controller. */
export class WidgetNetworkGuests {
  private checks = new Map<string, Check>();
  private stopProxyChanges: () => void;
  constructor(
    private owner: Electron.WebContents,
    private preload: string,
    private development?: { isDev: boolean; devServerPort: number },
  ) {
    installIpc();
    controllers.set(owner.id, this);
    this.stopProxyChanges = onBrowserProxyWillChange(() => this.revokeAll('proxy'));
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.revokeAll('owner');
    });
    owner.on('render-process-gone', () => this.revokeAll('owner'));
    owner.once('destroyed', () => {
      this.revokeAll('owner');
      this.stopProxyChanges();
      if (controllers.get(owner.id) === this) controllers.delete(owner.id);
    });
  }

  beginCheck(value: WidgetNetworkCheckRequest) {
    if (!value || !validNetworkMount(value.mountId)) return unavailable();
    if (value.instanceId) this.owned({ mountId: value.mountId, instanceId: value.instanceId });
    for (const [mount, check] of this.checks)
      if (performance.now() - check.started >= WIDGET_NETWORK_CHECK_MS) this.checks.delete(mount);
    const check: Check = {
      nonce: randomUUID(),
      started: performance.now(),
      frame: this.owner.mainFrame,
      instanceId: value.instanceId,
    };
    this.checks.set(value.mountId, check);
    return { nonce: check.nonce, validForMs: WIDGET_NETWORK_CHECK_MS };
  }

  private check(value: { mountId: string; nonce: string }, instanceId?: string): Check {
    const check = value && this.checks.get(value.mountId);
    if (
      !check ||
      check.nonce !== value.nonce ||
      check.instanceId !== instanceId ||
      check.frame !== this.owner.mainFrame ||
      performance.now() - check.started >= WIDGET_NETWORK_CHECK_MS ||
      this.owner.isDestroyed()
    )
      return unavailable();
    this.checks.delete(value.mountId);
    return check;
  }

  async create(value: WidgetNetworkCreate): Promise<WidgetNetworkInstance> {
    const check = this.check(value);
    if (
      [...instances.values()].some(
        entry => entry.owner === this.owner && entry.mountId === value.mountId,
      )
    )
      return unavailable();
    if (getBrowserProxyMode() === ProxyMode.DIRECT)
      throw new Error('Widget network requires a proxy');
    const binding = normalizedNetworkBinding(value.binding);
    const policy = createNetworkPolicy(value, this.owner.getURL(), !!this.development?.isDev);
    const instanceId = randomUUID();
    const partition = WIDGET_NETWORK_PARTITION_PREFIX + instanceId;
    const networkSession = session.fromPartition(partition, { cache: false });
    const entry: Entry = {
      instanceId,
      partition,
      mountId: value.mountId,
      owner: this.owner,
      ownerFrame: this.owner.mainFrame,
      binding,
      policy,
      session: networkSession,
      expires: check.started + WIDGET_NETWORK_LEASE_MS,
      ready: Promise.resolve(),
      prepared: false,
      timer: setTimeout(() => {}, 0),
    };
    instances.set(instanceId, entry);
    this.arm(entry);
    try {
      this.configureSession(entry);
      entry.ready = registerBrowserProxySession(networkSession);
      await this.bounded(entry, entry.ready);
      // Resolving every granted origin catches DIRECT and PAC fallback before
      // initialization. Each subsequent business request resolves its own URL too.
      await Promise.all(
        binding.netOrigins.map(async origin => {
          if (!strictProxyRoute(await this.proxyRoute(entry, origin + '/')))
            throw new Error('Widget network proxy route unavailable');
        }),
      );
      this.assertActive(entry);
      return { instanceId, partition, mountId: value.mountId };
    } catch {
      this.revoke(entry, 'proxy');
      throw new Error('Widget network proxy unavailable');
    }
  }

  renew(value: WidgetNetworkRenew): void {
    const entry = this.owned(value);
    const check = this.check(value, entry.instanceId);
    const binding = normalizedNetworkBinding(value.binding);
    if (
      JSON.stringify(binding) !== JSON.stringify(entry.binding) ||
      getBrowserProxyMode() === ProxyMode.DIRECT
    ) {
      this.revoke(entry, 'owner');
      return unavailable();
    }
    entry.expires = check.started + WIDGET_NETWORK_LEASE_MS;
    this.arm(entry);
  }

  close(value: WidgetNetworkClose): void {
    // Idempotent close cannot target another owner's or another mount's entry.
    const entry = value && instances.get(value.instanceId);
    if (!entry) return;
    this.revoke(this.owned(value), 'closed');
  }

  private owned(value: WidgetNetworkClose): Entry {
    const entry = value && instances.get(value.instanceId);
    if (!entry || entry.owner !== this.owner || entry.mountId !== value.mountId)
      return unavailable();
    this.assertActive(entry);
    return entry;
  }

  private assertActive(entry: Entry): void {
    if (
      instances.get(entry.instanceId) !== entry ||
      entry.owner.isDestroyed() ||
      entry.ownerFrame !== entry.owner.mainFrame ||
      performance.now() >= entry.expires
    ) {
      if (instances.get(entry.instanceId) === entry) this.revoke(entry, 'expired');
      return unavailable();
    }
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.revoke(entry, 'expired'),
      Math.max(0, entry.expires - performance.now()),
    );
    entry.timer.unref?.();
  }

  private bounded<T>(entry: Entry, pending: Promise<T>): Promise<T> {
    this.assertActive(entry);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Widget network proxy timeout')),
        Math.max(0, Math.min(WIDGET_NETWORK_CHECK_MS, entry.expires - performance.now())),
      );
      timer.unref?.();
      void pending.then(
        route => {
          clearTimeout(timer);
          resolve(route);
        },
        () => {
          clearTimeout(timer);
          reject(new Error('Widget network proxy unavailable'));
        },
      );
    });
  }

  private proxyRoute(entry: Entry, url: string): Promise<string> {
    return this.bounded(entry, entry.session.resolveProxy(url));
  }

  private revokeAll(reason: WidgetNetworkRevoked['reason']): void {
    this.checks.clear();
    for (const entry of [...instances.values()])
      if (entry.owner === this.owner) this.revoke(entry, reason);
  }

  private revoke(entry: Entry, reason: WidgetNetworkRevoked['reason']): void {
    if (instances.get(entry.instanceId) !== entry) return;
    instances.delete(entry.instanceId);
    this.checks.delete(entry.mountId);
    clearTimeout(entry.timer);
    entry.disposeHost?.();
    unregisterBrowserProxySession(entry.session);
    if (entry.guest && !entry.guest.isDestroyed()) entry.guest.close();
    // Keep deny-all handlers installed on a retired partition. Removing them
    // would briefly restore unrestricted defaults during asynchronous teardown.
    void Promise.allSettled([
      entry.session.closeAllConnections(),
      entry.session.clearStorageData(),
      entry.session.clearCache(),
      entry.session.clearAuthCache(),
    ]);
    if (!this.owner.isDestroyed()) {
      try {
        this.owner.send(WidgetNetworkIpc.Revoked, {
          instanceId: entry.instanceId,
          mountId: entry.mountId,
          reason,
        } satisfies WidgetNetworkRevoked);
      } catch {
        /* A crashed owner cannot receive notifications. */
      }
    }
  }

  prepare(
    event: Electron.Event,
    preferences: Electron.WebPreferences,
    params: Record<string, string>,
    host: Electron.WebContents,
  ): boolean {
    if (!params.partition?.startsWith(WIDGET_NETWORK_PARTITION_PREFIX)) return false;
    const entry = [...instances.values()].find(
      entry => entry.partition === params.partition && entry.owner === this.owner,
    );
    try {
      if (
        !entry ||
        entry.prepared ||
        params.src !== entry.policy.viewerUrl ||
        !widgetViewerMount(params.src, host.getURL()) ||
        new URL(host.getURL()).origin !== entry.policy.applicationOrigin
      )
        return unavailable();
      this.assertActive(entry);
      entry.prepared = true;
      entry.host = host;
      const revokeHost = () => this.revoke(entry, 'owner');
      host.once('destroyed', revokeHost);
      entry.disposeHost = () => host.removeListener('destroyed', revokeHost);
      Object.assign(preferences, {
        partition: entry.partition,
        session: entry.session,
        preload: this.preload,
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
    } catch {
      event.preventDefault();
    }
    return true;
  }

  attach(guest: Electron.WebContents, host: Electron.WebContents): boolean {
    const entry = [...instances.values()].find(
      entry => entry.session === guest.session && entry.host === host && entry.owner === this.owner,
    );
    if (!entry) return false;
    try {
      this.assertActive(entry);
      if (entry.guest) return unavailable();
      entry.guest = guest;
      guest.once('destroyed', () => this.revoke(entry, 'guest'));
    } catch {
      if (!guest.isDestroyed()) guest.close();
    }
    return true;
  }

  /** Existing minimal preload readiness additionally proves the installed lease. */
  ready(guest: Electron.WebContents): Promise<void> | undefined {
    const entry = [...instances.values()].find(
      entry => entry.guest === guest && entry.owner === this.owner,
    );
    if (!entry) return;
    this.assertActive(entry);
    return entry.ready.then(() => this.assertActive(entry));
  }

  private role(
    entry: Entry,
    details: { webContentsId?: number; frame?: Electron.WebFrameMain },
  ): RequestRole {
    const guest = entry.guest;
    if (!guest || guest.isDestroyed() || details.webContentsId !== guest.id) return 'unknown';
    const frame = details.frame;
    if (frame === guest.mainFrame) return 'viewer';
    if (frame?.parent === guest.mainFrame) return 'sandbox';
    if (
      frame?.url === 'about:srcdoc' &&
      frame.parent?.url === entry.policy.sandboxUrl &&
      frame.parent.parent === guest.mainFrame
    )
      return 'widget';
    return 'unknown';
  }

  private configureSession(entry: Entry): void {
    const target = entry.session;
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    target.on('will-download', event => event.preventDefault());
    const classify = (details: {
      url: string;
      method: string;
      resourceType: string;
      webContentsId?: number;
      frame?: Electron.WebFrameMain;
      uploadData?: readonly unknown[];
    }) => {
      try {
        this.assertActive(entry);
      } catch {
        return 'denied' as const;
      }
      return classifyNetworkRequest(entry.policy, details, this.role(entry, details));
    };
    target.webRequest.onBeforeRequest((details, callback) => {
      const kind = classify(details);
      if (kind === 'denied') {
        callback({ cancel: true });
        return;
      }
      if (kind === 'transport') {
        callback({ cancel: false });
        return;
      }
      void this.proxyRoute(entry, details.url).then(
        route => {
          let allowed = strictProxyRoute(route) && getBrowserProxyMode() !== ProxyMode.DIRECT;
          try {
            this.assertActive(entry);
          } catch {
            allowed = false;
          }
          callback({ cancel: !allowed });
        },
        () => callback({ cancel: true }),
      );
    });
    target.webRequest.onBeforeSendHeaders((details, callback) => {
      const kind = classify(details);
      const headers = sanitizedWidgetRequestHeaders(details.requestHeaders, kind === 'preflight');
      callback(kind === 'denied' || !headers ? { cancel: true } : { requestHeaders: headers });
    });
    target.webRequest.onHeadersReceived((details, callback) => {
      const kind = classify(details);
      if (kind === 'denied') {
        callback({ cancel: true });
        return;
      }
      const responseHeaders = Object.fromEntries(
        Object.entries(details.responseHeaders ?? {}).filter(
          ([key]) => !['set-cookie', 'set-cookie2'].includes(key.toLowerCase()),
        ),
      );
      // Preserve native sandbox CSP. Only the trusted development viewer receives
      // the application policy, in this same single response handler.
      if (this.development?.isDev && new URL(details.url).origin === entry.policy.applicationOrigin)
        responseHeaders['Content-Security-Policy'] = [
          buildApplicationContentSecurityPolicy({
            isDev: true,
            devServerPort: this.development.devServerPort,
          }),
        ];
      const location = Object.entries(responseHeaders).find(
        ([key]) => key.toLowerCase() === 'location',
      )?.[1]?.[0];
      if (location) {
        try {
          const destination = new URL(location, details.url);
          if (
            kind === 'resource'
              ? classify({ ...details, url: destination.href }) !== 'resource'
              : kind !== 'business' ||
                destination.origin !== new URL(details.url).origin ||
                destination.username ||
                destination.password ||
                destination.hash
          ) {
            callback({ cancel: true });
            return;
          }
        } catch {
          callback({ cancel: true });
          return;
        }
      }
      callback({ responseHeaders });
    });
  }
}
