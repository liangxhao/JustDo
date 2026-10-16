import { normalizeBrowserTabLimit } from '@shared/browser/browserTabLimit';
import { useSyncExternalStore } from 'react';

import { configService } from '@/services/config';

export const getBrowserTabLimit = (): number =>
  normalizeBrowserTabLimit(configService.getConfig().browserTabLimit);

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('config-updated', onChange);
  return () => window.removeEventListener('config-updated', onChange);
};

export const useBrowserTabLimit = (): number => useSyncExternalStore(subscribe, getBrowserTabLimit);
