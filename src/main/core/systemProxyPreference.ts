import { session } from 'electron';

import {
  type CustomProxyConfig,
  defaultCustomProxyConfig,
  ProxyMode,
  ProxyProtocol,
  type ProxySettings,
} from '../../shared/proxy';
import type { OutboundHeaderProxy } from './outboundHeaderProxy';
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

const normalizeCustomProxy = (custom?: Partial<CustomProxyConfig>): CustomProxyConfig => {
  const protocol = Object.values(ProxyProtocol).includes(custom?.protocol as ProxyProtocol)
    ? (custom?.protocol as ProxyProtocol)
    : defaultCustomProxyConfig.protocol;

  return {
    protocol,
    host: custom?.host?.trim() ?? '',
    port: custom?.port?.trim() ?? '',
    username: custom?.username?.trim() ?? '',
    password: custom?.password ?? '',
  };
};

const buildCustomProxyUrl = (custom: CustomProxyConfig): string | null => {
  const host = custom.host.trim();
  const port = custom.port.trim();
  if (!host || !port) {
    return null;
  }

  const username = custom.username?.trim();
  const password = custom.password ?? '';
  const credentials = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    : '';

  return `${custom.protocol}://${credentials}${host}:${port}`;
};

const removeProxyCredentials = (proxyUrl: string): string => {
  try {
    const url = new URL(proxyUrl);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return proxyUrl;
  }
};

export const getProxyPreferenceSignature = (config?: SystemProxySettings): string => {
  const mode = resolveProxyMode(config);
  const custom = normalizeCustomProxy(config?.proxy?.custom);
  return JSON.stringify({
    mode,
    custom: mode === ProxyMode.CUSTOM ? custom : undefined,
  });
};

const applySystemProxyPreferenceNow = async (
  config: SystemProxySettings | boolean | undefined,
  outboundHeaderProxy: OutboundHeaderProxy,
): Promise<void> => {
  const settings = typeof config === 'boolean' ? { useSystemProxy: config } : config;
  const proxyMode = resolveProxyMode(settings);
  const useSystemProxy = proxyMode === ProxyMode.SYSTEM;

  try {
    if (useSystemProxy) {
      await session.defaultSession.setProxy({ mode: ProxyMode.SYSTEM });
    } else if (proxyMode === ProxyMode.CUSTOM) {
      const customProxyUrl = buildCustomProxyUrl(normalizeCustomProxy(settings?.proxy?.custom));
      if (customProxyUrl) {
        await session.defaultSession.setProxy({
          mode: 'fixed_servers',
          proxyRules: removeProxyCredentials(customProxyUrl),
          proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
        });
      } else {
        await session.defaultSession.setProxy({ mode: ProxyMode.DIRECT });
      }
    } else {
      await session.defaultSession.setProxy({ mode: ProxyMode.DIRECT });
    }
  } catch (error) {
    console.error('[SystemProxy] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (proxyMode === ProxyMode.CUSTOM) {
    const customProxyUrl = buildCustomProxyUrl(normalizeCustomProxy(settings?.proxy?.custom));
    setFixedProxyUrl(customProxyUrl);
    applySystemProxyEnv(customProxyUrl);
    outboundHeaderProxy.reapplyProcessEnvironment();

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
    outboundHeaderProxy.reapplyProcessEnvironment();
    console.log('[SystemProxy] Disabled; using direct mode.');
    return;
  }

  setFixedProxyUrl(null);
  const proxyUrl = await resolveSystemProxyUrl('https://proxy-check.invalid');
  applySystemProxyEnv(proxyUrl);
  outboundHeaderProxy.reapplyProcessEnvironment();

  if (proxyUrl) {
    console.log('[SystemProxy] Enabled for process environment:', proxyUrl);
  } else {
    console.warn('[SystemProxy] Enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};

let proxyPreferenceGeneration = 0;
let proxyPreferenceApplyQueue: Promise<void> = Promise.resolve();

/**
 * Applies proxy changes in order and reports whether this request is still the
 * latest preference. Callers should only perform follow-up work (such as a
 * Gateway restart) when the returned value is true.
 */
export const applySystemProxyPreference = (
  config: SystemProxySettings | boolean | undefined,
  outboundHeaderProxy: OutboundHeaderProxy,
): Promise<boolean> => {
  const generation = ++proxyPreferenceGeneration;
  const operation = proxyPreferenceApplyQueue.then(async () => {
    if (generation !== proxyPreferenceGeneration) {
      return false;
    }
    await applySystemProxyPreferenceNow(config, outboundHeaderProxy);
    return generation === proxyPreferenceGeneration;
  });

  proxyPreferenceApplyQueue = operation.then(
    (): void => undefined,
    (): void => undefined,
  );
  return operation;
};
