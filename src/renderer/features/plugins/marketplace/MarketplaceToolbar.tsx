import { useContext } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import { MarketplaceToolbarSlot } from './MarketplaceToolbarSlot';
import { MarketplaceFilter, type PluginMarketplaceController } from './usePluginMarketplace';

export default function MarketplaceToolbar({
  controller,
  hasLocalMatches = true,
}: {
  controller: PluginMarketplaceController;
  hasLocalMatches?: boolean;
}) {
  const slot = useContext(MarketplaceToolbarSlot);
  const controls = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {Object.values(MarketplaceFilter).map(filter => (
        <button
          type="button"
          key={filter}
          aria-pressed={controller.filter === filter}
          onClick={() => controller.setFilter(filter)}
          className={`rounded-full border px-3 py-1 text-xs ${controller.filter === filter ? 'border-primary text-primary' : 'border-border text-secondary'}`}
        >
          {i18nService.t(`marketplaceFilter.${filter}`)}
          {filter === MarketplaceFilter.UPDATES && controller.updateById.size > 0
            ? ` · ${controller.updateById.size}`
            : ''}
        </button>
      ))}
      {controller.source?.supportsUpdates && (
        <button
          type="button"
          disabled={controller.checking}
          onClick={controller.checkUpdates}
          className="ml-auto text-xs text-secondary hover:text-primary disabled:opacity-60"
        >
          {i18nService.t(controller.checking ? 'marketplaceChecking' : 'marketplaceCheckUpdates')}
        </button>
      )}
    </div>
  );
  return (
    <div className="mb-4 space-y-2 empty:hidden">
      {slot ? createPortal(controls, slot) : controls}
      {controller.filter !== MarketplaceFilter.ALL && controller.sourceError && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {controller.sourceError}
          <button type="button" onClick={controller.retry} className="ml-2 underline">
            {i18nService.t('marketplaceRetry')}
          </button>
        </p>
      )}
      {controller.filter === MarketplaceFilter.UPDATES &&
        controller.source === null &&
        !controller.sourceError && (
          <p className="text-sm text-secondary">{i18nService.t('marketplaceNotConfigured')}</p>
        )}
      {controller.updateError && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          {controller.updateError}
          <button type="button" onClick={controller.checkUpdates} className="ml-2 underline">
            {i18nService.t('marketplaceRetry')}
          </button>
        </p>
      )}
      {controller.filter === MarketplaceFilter.UPDATES &&
        controller.source &&
        controller.identityReady &&
        !controller.checking &&
        !controller.updateById.size &&
        !controller.recentlyUpdated.size &&
        !controller.updateError && (
          <p className="text-sm text-secondary">{i18nService.t('marketplaceNoKnownUpdates')}</p>
        )}
      {controller.filter === MarketplaceFilter.INSTALLED &&
        controller.query &&
        !hasLocalMatches && (
          <p className="text-sm text-secondary">{i18nService.t('marketplaceSearchEmpty')}</p>
        )}
      {controller.query && (
        <h3 className="text-sm font-medium">{i18nService.t('marketplaceResultsTitle')}</h3>
      )}
    </div>
  );
}
