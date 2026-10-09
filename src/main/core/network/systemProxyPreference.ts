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

const dynamicBrowserSessions = new Map<string, Electron.Session>();
let currentBrowserProxySettings = defaultBrowserProxySettings;

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
): Promise<void> => {
  const proxyMode = settings.mode;
  if (proxyMode === ProxyMode.SYSTEM) {
    await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.SYSTEM })));
  } else if (proxyMode === ProxyMode.CUSTOM) {
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
      await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.DIRECT })));
    }
  } else {
    await Promise.all(targetSessions.map(target => target.setProxy({ mode: ProxyMode.DIRECT })));
  }
  await Promise.all(targetSessions.map(target => target.closeAllConnections()));
};

export const registerBrowserProxySession = async (
  targetSession: Electron.Session,
): Promise<void> => {
  const key = targetSession.storagePath;
  if (!key || dynamicBrowserSessions.has(key)) return;
  dynamicBrowserSessions.set(key, targetSession);
  const operation = browserProxyApplyQueue.then(() =>
    applyProxyToSessions([targetSession], currentBrowserProxySettings),
  );
  browserProxyApplyQueue = operation.catch(error => {
    console.error('[SystemProxy] Failed to apply proxy mode to browser profile:', error);
  });
  await browserProxyApplyQueue;
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
  const operation = browserProxyApplyQueue.then(async () => {
    if (generation !== browserProxyGeneration) return false;
    currentBrowserProxySettings = settings;
    const targetSessions = [
      ...new Set([
        session.fromPartition(BROWSER_PANEL_PARTITION),
        session.fromPartition(BROWSER_IMPORTED_PROFILE_PARTITION),
        ...dynamicBrowserSessions.values(),
      ]),
    ];
    try {
      await applyProxyToSessions(targetSessions, settings);
    } catch (error) {
      console.error('[SystemProxy] Failed to apply browser proxy mode:', error);
    }
    return generation === browserProxyGeneration;
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
