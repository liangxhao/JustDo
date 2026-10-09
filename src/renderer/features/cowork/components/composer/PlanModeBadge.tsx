import { ArrowPathIcon, LightBulbIcon, XMarkIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

export default function PlanModeBadge({
  disabled = false,
  onRemove,
}: {
  disabled?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span aria-hidden="true" className="h-3.5 w-px bg-border/60" />
      <button
        type="button"
        disabled={disabled}
        aria-label={i18nService.t('planModeExit')}
        title={i18nService.t('planModeExit')}
        aria-busy={disabled}
        onClick={onRemove}
        className="group flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:bg-surface-raised focus-visible:text-foreground focus-visible:outline-none disabled:cursor-wait disabled:opacity-70"
      >
        <span aria-hidden="true" className="relative h-3.5 w-3.5 shrink-0">
          {disabled ? (
            <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <LightBulbIcon className="absolute inset-0 h-3.5 w-3.5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />
              <XMarkIcon className="absolute inset-0 h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </>
          )}
        </span>
        <span>{i18nService.t('planModeBadgeLabel')}</span>
      </button>
    </div>
  );
}
