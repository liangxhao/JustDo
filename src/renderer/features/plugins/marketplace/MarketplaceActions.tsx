import {
  ArrowPathIcon,
  ArrowUpCircleIcon,
  CheckIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  NoSymbolIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { MarketplaceInstallState, type MarketplacePlugin } from '@shared/plugins/marketplace';

import { i18nService } from '@/services/i18n';

import { marketplaceKey, type PluginMarketplaceController } from './usePluginMarketplace';

export function MarketplaceAction({
  controller,
  item,
  disabled = false,
  installOnly = false,
  showText = false,
}: {
  controller: PluginMarketplaceController;
  item: MarketplacePlugin;
  disabled?: boolean;
  installOnly?: boolean;
  showText?: boolean;
}) {
  const local = controller.localFor(item);
  const operation = controller.operations[marketplaceKey(item)];
  const updating = Boolean(local);
  const alreadyInstalled = installOnly && updating;
  const completed = operation?.committed && (!local || operation.version === item.version);
  const unavailable = item.installState === MarketplaceInstallState.UNAVAILABLE && !updating;
  const label = i18nService.t(
    operation?.busy
      ? updating
        ? 'marketplaceUpdating'
        : 'marketplaceInstalling'
      : completed || alreadyInstalled
        ? local
          ? 'marketplaceInstalled'
          : 'marketplaceStatusPending'
        : controller.conflicts(item)
          ? 'marketplaceLocalConflict'
          : unavailable
            ? 'marketplaceUnavailable'
            : updating
              ? 'marketplaceUpdate'
              : 'marketplaceInstall',
  );
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={operation?.busy || undefined}
      title={
        updating && !installOnly && item.version
          ? `${label} · ${local?.version ?? '—'} → ${item.version}`
          : label
      }
      disabled={
        disabled ||
        controller.readOnly ||
        controller.runtimeUnavailable ||
        operation?.busy ||
        completed ||
        alreadyInstalled ||
        controller.conflicts(item) ||
        unavailable ||
        (updating && !controller.updateById.has(local!.id)) ||
        !controller.identityReady
      }
      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10 disabled:text-secondary disabled:opacity-60"
      onClick={event => {
        event.stopPropagation();
        void controller.install(item);
      }}
    >
      {operation?.busy ? (
        <ArrowPathIcon className="h-4 w-4 animate-spin" />
      ) : completed && !local ? (
        <ClockIcon className="h-4 w-4" />
      ) : completed || alreadyInstalled ? (
        <CheckIcon className="h-4 w-4" />
      ) : controller.conflicts(item) ? (
        <ExclamationTriangleIcon className="h-4 w-4" />
      ) : unavailable ? (
        <NoSymbolIcon className="h-4 w-4" />
      ) : updating ? (
        <ArrowUpCircleIcon className="h-4 w-4" />
      ) : (
        <PlusIcon className="h-4 w-4" />
      )}
      {showText && label}
    </button>
  );
}

export function InstalledMarketplaceAction({
  controller,
  id,
  disabled,
}: {
  controller: PluginMarketplaceController;
  id: string;
  disabled?: boolean;
}) {
  const item = controller.updateById.get(id);
  const operation = controller.operationFor(id);
  if (item) return <MarketplaceAction controller={controller} item={item} disabled={disabled} />;
  const label = i18nService.t('marketplaceUpdating');
  return operation?.busy ? (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 text-primary"
    >
      <ArrowPathIcon className="h-4 w-4 animate-spin" />
    </span>
  ) : null;
}

export function MarketplaceFeedback({
  controller,
  id,
  item,
}: {
  controller: PluginMarketplaceController;
  id?: string;
  item?: MarketplacePlugin;
}) {
  const key = item ? marketplaceKey(item) : undefined;
  const operation = id ? controller.operationFor(id) : key ? controller.operations[key] : undefined;
  if (!operation || operation.busy) return null;
  const warning =
    operation.warning ||
    (operation.committed && operation.error
      ? i18nService.t('marketplaceInstallCommittedWithError')
      : item && operation.committed && !controller.localFor(item)
        ? i18nService.t('marketplaceStatusPending')
        : '');
  if (!operation.message && !operation.error && !warning) return null;
  return (
    <div
      className="relative z-10 space-y-1 text-xs [&_button]:pointer-events-auto"
      onClick={event => event.stopPropagation()}
    >
      {operation.message && (
        <p role="status" className="text-emerald-700 dark:text-emerald-300">
          {operation.message}
        </p>
      )}
      {operation.error && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {operation.error}
        </p>
      )}
      {warning && (
        <div role="status" className="text-amber-700 dark:text-amber-300">
          {warning}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              const candidate =
                key ??
                Object.keys(controller.operations).find(
                  candidateKey => controller.operations[candidateKey] === operation,
                );
              if (candidate) void controller.refreshInventory(candidate);
            }}
          >
            {i18nService.t('marketplaceRefreshStatus')}
          </button>
        </div>
      )}
    </div>
  );
}
