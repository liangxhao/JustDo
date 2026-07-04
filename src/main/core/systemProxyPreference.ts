import { session } from 'electron';

import type { OutboundHeaderProxy } from '../libs/infra/outboundHeaderProxy';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from '../libs/infra/systemProxy';

export type SystemProxySettings = {
  useSystemProxy?: boolean;
};

export const isSystemProxyEnabled = (config?: SystemProxySettings): boolean => {
  return config?.useSystemProxy === true;
};

export const applySystemProxyPreference = async (
  useSystemProxy: boolean,
  outboundHeaderProxy: OutboundHeaderProxy,
): Promise<void> => {
  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[SystemProxy] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    outboundHeaderProxy.reapplyProcessEnvironment();
    console.log('[SystemProxy] Disabled; using direct mode.');
    return;
  }

  const proxyUrl = await resolveSystemProxyUrl('https://proxy-check.invalid');
  applySystemProxyEnv(proxyUrl);
  outboundHeaderProxy.reapplyProcessEnvironment();

  if (proxyUrl) {
    console.log('[SystemProxy] Enabled for process environment:', proxyUrl);
  } else {
    console.warn('[SystemProxy] Enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};
