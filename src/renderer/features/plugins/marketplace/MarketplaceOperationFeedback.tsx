import { PluginOperationStatusContent } from '@/features/plugins/shared/PluginOperationStatusSlot';
import { i18nService } from '@/services/i18n';

import type { PluginMarketplaceController } from './usePluginMarketplace';

export default function MarketplaceOperationFeedback({
  controller,
}: {
  controller: PluginMarketplaceController;
}) {
  const entries = Object.entries(controller.operations).flatMap(([key, operation]) => {
    if (operation.busy) return [];
    const warning =
      (operation.unconfirmed
        ? i18nService.t('marketplaceStatusPending')
        : operation.committed && operation.error
          ? operation.error
          : operation.committed && !controller.isInstalledKey(key)
            ? i18nService.t('marketplaceStatusPending')
            : '') || operation.warning;
    const supplementalWarning = operation.warning !== warning ? operation.warning : undefined;
    const message =
      operation.restartRequired || (!warning && controller.isInstalledKey(key))
        ? operation.message
        : undefined;
    return message || warning ? [{ key, operation, warning, message, supplementalWarning }] : [];
  });
  if (!entries.length) return null;
  return (
    <PluginOperationStatusContent>
      {entries.map(({ key, operation, warning, message, supplementalWarning }) => (
        <div
          key={key}
          className="space-y-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs shadow-lg"
        >
          <p className="font-medium text-foreground">
            {operation.label || i18nService.t('plugins')}
          </p>
          {message && (
            <p
              role="status"
              className={
                operation.restartRequired
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-emerald-700 dark:text-emerald-300'
              }
            >
              {message}
            </p>
          )}
          {warning && (
            <div
              role="status"
              className="whitespace-pre-wrap break-words text-amber-700 dark:text-amber-300 [overflow-wrap:anywhere]"
            >
              <p className="max-h-32 overflow-y-auto">{warning}</p>
              {supplementalWarning && <p>{supplementalWarning}</p>}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => void controller.refreshInventory(key)}
              >
                {i18nService.t('marketplaceRefreshStatus')}
              </button>
            </div>
          )}
        </div>
      ))}
    </PluginOperationStatusContent>
  );
}
