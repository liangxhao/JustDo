import { ArrowPathIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

import CacheBroomIcon from './CacheBroomIcon';
import type { BrowserCacheController } from './useBrowserCacheCleanup';

export default function BrowserCacheControls({ cache, disabled }: {
  cache: BrowserCacheController;
  disabled: boolean;
}) {
  if (!cache.available) return null;
  const label = i18nService.t(cache.busy ? 'storageDirectoryClearingCache' : 'storageDirectoryClearCache');
  return (
    <button type="button" onClick={() => void cache.clear()}
      disabled={!cache.busy && disabled} aria-label={label} title={label} aria-busy={cache.busy}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-transparent text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-40">
      {cache.busy ? <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
        : <CacheBroomIcon className="h-4 w-4" />}
    </button>
  );
}
