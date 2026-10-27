import { session } from 'electron';

import {
  BROWSER_IMPORTED_PROFILE_PARTITION,
  BROWSER_PANEL_PARTITION,
} from '../../../shared/browser/browser';
import {
  buildCustomProxyUrl,
  defaultBrowserProxySettings,
  normalizeProxySettings,
  ProxyMode,
  type ProxySettings,
} from '../../../shared/network/proxy';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setFixedProxyUrl,
  setSystemProxyEnabled,
} from './systemProxy';

export type SystemProxySettings = {
  useSystemProxy?: boolean;
  proxy?: Partial<ProxySettings>;
  browserProxy?: Partial<ProxySettings>;
};

export const BrowserProxyStatus = {
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed',
} as const;

export interface BrowserProxySessionState {
  generation: number;
  status: (typeof BrowserProxyStatus)[keyof typeof BrowserProxyStatus];
}

type BrowserSessionRegistration = { operation?: Promise<void> };
const dynamicBrowserSessions = new Map<Electron.Session, BrowserSessionRegistration>();
const browserSessionStates = new WeakMap<Electron.Session, BrowserProxySessionState>();
const browserSessionObservers = new WeakMap<
  Electron.Session,
  Set<(state: BrowserProxySessionState) => void>
>();
let currentBrowserProxySettings = defaultBrowserProxySettings;
const browserProxyChangeListeners = new Set<() => void>();

export const getBrowserProxyMode = (): ProxyMode => currentBrowserProxySettings.mode;

/** Network widgets must stop before an existing proxy route is replaced. */
export const onBrowserProxyWillChange = (listener: () => void): (() => void) => {
  browserProxyChangeListeners.add(listener);
  return () => browserProxyChangeListeners.delete(listener);
};

export const getBrowserProxySessionState = (
  targetSession: Electron.Session,
): BrowserProxySessionState => ({
  ...(browserSessionStates.get(targetSession) ?? {
    generation: browserProxyGeneration,
    status: BrowserProxyStatus.PENDING,
  }),
});

const updateBrowserSessionState = (
  targetSession: Electron.Session,
  state: BrowserProxySessionState,
): void => {
  browserSessionStates.set(targetSession, state);
  for (const observer of browserSessionObservers.get(targetSession) ?? []) {
    try {
      observer({ ...state });
    } catch {
      console.error('[SystemProxy] Browser proxy state observer failed.');
    }
  }
};

export const observeBrowserProxySession = (
  targetSession: Electron.Session,
  listener: (state: BrowserProxySessionState) => void,
): (() => void) => {
  let observers = browserSessionObservers.get(targetSession);
  if (!observers) {
    observers = new Set();
    browserSessionObservers.set(targetSession, observers);
  }
  observers.add(listener);
  listener(getBrowserProxySessionState(targetSession));
  return () => {
    observers.delete(listener);
    if (!observers.size) browserSessionObservers.delete(targetSession);
  };
};

export const unregisterBrowserProxySession = (targetSession: Electron.Session): void => {
  dynamicBrowserSessions.delete(targetSession);
  updateBrowserSessionState(targetSession, {
    generation: browserProxyGeneration,
    status: BrowserProxyStatus.PENDING,
  });
  browserSessionStates.delete(targetSession);
  browserSessionObservers.delete(targetSession);
};

export const getBrowserProxyCredentials = (): {
  host: string;
  port: number;
  username: string;
  password: string;
} | null => {
  const settings = currentBrowserProxySettings;
  const proxyUrl = settings.mode === ProxyMode.CUSTOM ? buildCustomProxyUrl(settings.custom) : null;
  if (!proxyUrl || !settings.custom.username?.trim()) return null;
  const parsed = new URL(proxyUrl);
  return {
    host: parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase(),
    port: Number(settings.custom.port),
    username: settings.custom.username.trim(),
    password: settings.custom.password ?? '',
  };
};

export const isSystemProxyEnabled = (config?: SystemProxySettings): boolean => {
  return resolveProxyMode(config) === ProxyMode.SYSTEM;
};

const resolveProxyMode = (config?: SystemProxySettings): ProxyMode => {
  if (config?.proxy?.mode === ProxyMode.SYSTEM || config?.useSystemProxy === true) {
    return ProxyMode.SYSTEM;
  }
  if (config?.proxy?.mode === ProxyMode.CUSTOM) {
    return ProxyMode.CUSTOM;
  }
  return ProxyMode.DIRECT;
};

const removeProxyCredentials = (proxyUrl: string): string | null => {
  try {
    const url = new URL(proxyUrl);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

const applyProxyToSessions = async (
  targetSessions: Electron.Session[],
  settings: ProxySettings,
  strictCustom = false,
): Promise<void> => {
  const proxyMode = settings.mode;
  if (proxyMode === ProxyMode.SYSTEM) {
    await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.SYSTEM })));
  } else if (proxyMode === ProxyMode.CUSTOM) {
    if (
      strictCustom &&
      (!/^\d+$/u.test(settings.custom.port) ||
        /[\s/@\\?#]/u.test(settings.custom.host) ||
        !settings.custom.host)
    )
      throw new Error('Invalid browser proxy configuration.');
    const customProxyUrl = buildCustomProxyUrl(settings.custom);
    const proxyRules = customProxyUrl ? removeProxyCredentials(customProxyUrl) : null;
    if (proxyRules) {
      await Promise.all(
        targetSessions.map(target =>
          target.setProxy({
            mode: 'fixed_servers',
            proxyRules,
            proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
          }),
        ),
      );
    } else {
      if (strictCustom) throw new Error('Invalid browser proxy configuration.');
      await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.DIRECT })));
    }
  } else {
    await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.DIRECT })));
  }
  await Promise.all(targetSessions.map(target => target.closeAllConnections()));
};

const applyBrowserSession = async (
  targetSession: Electron.Session,
  generation: number,
  settings: ProxySettings,
  registration?: BrowserSessionRegistration,
): Promise<boolean> => {
  const current = () =>
    generation === browserProxyGeneration &&
    (!registration || dynamicBrowserSessions.get(targetSession) === registration);
  try {
    await applyProxyToSessions([targetSession], settings, true);
    if (current())
      updateBrowserSessionState(targetSession, { generation, status: BrowserProxyStatus.READY });
    return current();
  } catch {
    if (current())
      updateBrowserSessionState(targetSession, { generation, status: BrowserProxyStatus.FAILED });
    console.error('[SystemProxy] Failed to prepare browser session proxy.');
    return false;
  }
};

export const registerBrowserProxySession = async (
  targetSession: Electron.Session,
): Promise<void> => {
  // Identity supports memory-only sessions without sharing browser profile storage.
  let registration = dynamicBrowserSessions.get(targetSession);
  if (!registration) {
    registration = {};
    dynamicBrowserSessions.set(targetSession, registration);
  }
  const currentRegistration = registration;
  const state = getBrowserProxySessionState(targetSession);
  if (
    !registration.operation &&
    (state.status !== BrowserProxyStatus.READY || state.generation !== browserProxyGeneration)
  ) {
    updateBrowserSessionState(targetSession, {
      generation: browserProxyGeneration,
      status: BrowserProxyStatus.PENDING,
    });
    const operation = browserProxyApplyQueue.then(async () => {
      if (dynamicBrowserSessions.get(targetSession) !== currentRegistration) return;
      const current = getBrowserProxySessionState(targetSession);
      if (
        current.status === BrowserProxyStatus.READY &&
        current.generation === browserProxyGeneration
      )
        return;
      await applyBrowserSession(
        targetSession,
        browserProxyGeneration,
        currentBrowserProxySettings,
        currentRegistration,
      );
    });
    registration.operation = operation;
    browserProxyApplyQueue = operation.catch(() => {});
    void operation
      .finally(() => {
        if (currentRegistration.operation === operation) currentRegistration.operation = undefined;
      })
      .catch(() => {});
  }
  // A newer settings change may be queued while an older attempt completes.
  // Only the stable queue's current per-session result establishes readiness.
  while (dynamicBrowserSessions.get(targetSession) === currentRegistration) {
    const queued = browserProxyApplyQueue;
    await queued;
    if (queued !== browserProxyApplyQueue) continue;
    const current = getBrowserProxySessionState(targetSession);
    if (
      current.status === BrowserProxyStatus.READY &&
      current.generation === browserProxyGeneration
    )
      return;
    throw new Error('Browser proxy configuration failed.');
  }
  throw new Error('Browser proxy session was released.');
};

export const getProxyPreferenceSignature = (config?: SystemProxySettings): string => {
  const mode = resolveProxyMode(config);
  const custom = normalizeProxySettings(config?.proxy).custom;
  return JSON.stringify({
    mode,
    custom: mode === ProxyMode.CUSTOM ? custom : undefined,
  });
};

const applySystemProxyPreferenceNow = async (
  config: SystemProxySettings | boolean | undefined,
): Promise<void> => {
  const settings = typeof config === 'boolean' ? { useSystemProxy: config } : config;
  const proxyMode = resolveProxyMode(settings);
  const useSystemProxy = proxyMode === ProxyMode.SYSTEM;
  const normalizedSettings = normalizeProxySettings({ ...settings?.proxy, mode: proxyMode });

  try {
    await applyProxyToSessions([session.defaultSession], normalizedSettings);
  } catch (error) {
    console.error('[SystemProxy] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (proxyMode === ProxyMode.CUSTOM) {
    const customProxyUrl = buildCustomProxyUrl(normalizedSettings.custom);
    setFixedProxyUrl(customProxyUrl);
    applySystemProxyEnv(customProxyUrl);

    if (customProxyUrl) {
      console.log('[SystemProxy] Custom proxy enabled for process environment.');
    } else {
      console.warn('[SystemProxy] Custom proxy selected, but host or port is empty.');
    }
    return;
  }

  if (proxyMode === ProxyMode.DIRECT) {
    setFixedProxyUrl(null);
    restoreOriginalProxyEnv();
    console.log('[SystemProxy] Disabled; using direct mode.');
    return;
  }

  setFixedProxyUrl(null);
  const proxyUrl = await resolveSystemProxyUrl('https://proxy-check.invalid');
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log('[SystemProxy] Enabled for process environment:', proxyUrl);
  } else {
    console.warn('[SystemProxy] Enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};

let proxyPreferenceGeneration = 0;
let proxyPreferenceApplyQueue: Promise<void> = Promise.resolve();
let browserProxyGeneration = 0;
let browserProxyApplyQueue: Promise<void> = Promise.resolve();

export const getBrowserProxyPreferenceSignature = (config?: SystemProxySettings): string => {
  const settings = normalizeProxySettings(config?.browserProxy, ProxyMode.SYSTEM);
  return JSON.stringify({
    mode: settings.mode,
    custom: settings.mode === ProxyMode.CUSTOM ? settings.custom : undefined,
  });
};

/** Browser changes only touch guest sessions; they never change the Gateway environment. */
export const applyBrowserProxyPreference = (config?: SystemProxySettings): Promise<boolean> => {
  const generation = ++browserProxyGeneration;
  const settings = normalizeProxySettings(config?.browserProxy, ProxyMode.SYSTEM);
  currentBrowserProxySettings = settings;
  const targetSessions = [
    ...new Set([
      session.fromPartition(BROWSER_PANEL_PARTITION),
      session.fromPartition(BROWSER_IMPORTED_PROFILE_PARTITION),
      ...dynamicBrowserSessions.keys(),
    ]),
  ];
  const registrations = new Map(
    targetSessions.map(target => [target, dynamicBrowserSessions.get(target)]),
  );
  for (const target of targetSessions) {
    updateBrowserSessionState(target, { generation, status: BrowserProxyStatus.PENDING });
    // Revoke existing sockets promptly, including WebSockets. The queued apply
    // also verifies closing connections before publishing a successful result.
    void Promise.resolve()
      .then(() => target.closeAllConnections())
      .catch(() => {});
  }
  const operation = browserProxyApplyQueue.then(async () => {
    if (generation !== browserProxyGeneration) return false;
    // Network Widget leases are retired before their route changes. Webpage
    // embeds retain their guest and observe the per-session readiness instead.
    for (const listener of [...browserProxyChangeListeners]) listener();
    const results = await Promise.all(
      targetSessions.map(target => {
        const registration = registrations.get(target);
        if (registration && dynamicBrowserSessions.get(target) !== registration) return true;
        return applyBrowserSession(target, generation, settings, registration);
      }),
    );
    return generation === browserProxyGeneration && results.every(Boolean);
  });
  browserProxyApplyQueue = operation.then(
    (): void => undefined,
    (): void => undefined,
  );
  return operation;
};

/**
 * Applies proxy changes in order and reports whether this request is still the
 * latest preference. Callers should only perform follow-up work (such as a
 * Gateway restart) when the returned value is true.
 */
export const applySystemProxyPreference = (
  config: SystemProxySettings | boolean | undefined,
): Promise<boolean> => {
  const generation = ++proxyPreferenceGeneration;
  const operation = proxyPreferenceApplyQueue.then(async () => {
    if (generation !== proxyPreferenceGeneration) {
      return false;
    }
    await applySystemProxyPreferenceNow(config);
    return generation === proxyPreferenceGeneration;
  });

  proxyPreferenceApplyQueue = operation.then(
    (): void => undefined,
    (): void => undefined,
  );
  return operation;
};
