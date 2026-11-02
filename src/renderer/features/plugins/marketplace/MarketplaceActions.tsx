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
      : operation?.unconfirmed
        ? 'marketplaceStatusPending'
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
        operation?.unconfirmed ||
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
      ) : operation?.unconfirmed || (completed && !local) ? (
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
