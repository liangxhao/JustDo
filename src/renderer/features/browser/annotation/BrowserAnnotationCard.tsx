import { ExclamationTriangleIcon, GlobeAltIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { BrowserAnnotationDraft } from '@shared/browser/browser';

import { i18nService } from '@/services/i18n';

export default function BrowserAnnotationCard({
  annotation,
  includesImage,
  textOnlyMessage,
  onRemove,
}: {
  annotation: BrowserAnnotationDraft;
  includesImage: boolean;
  textOnlyMessage?: string;
  onRemove: () => void;
}) {
  return (
    <div className="flex max-w-72 items-center gap-2 rounded-lg border border-border bg-surface-raised px-2 py-1.5">
      <div className="relative h-10 w-12 shrink-0 overflow-hidden rounded bg-background">
        <img src={annotation.dataUrl} alt="" className="h-full w-full object-cover" />
        <GlobeAltIcon className="absolute bottom-0.5 right-0.5 h-3.5 w-3.5 rounded bg-surface/90 p-0.5 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground" title={annotation.title}>
          {annotation.title}
        </div>
        <div className="truncate text-[10px] text-muted">{annotation.displayUrl}</div>
        {annotation.comment && (
          <div className="truncate text-[10px] text-secondary" title={annotation.comment}>
            {annotation.comment}
          </div>
        )}
        {!includesImage && (
          <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
            <ExclamationTriangleIcon className="h-3 w-3" />
            {textOnlyMessage ?? i18nService.t('browserAnnotationTextOnly')}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-1 text-muted hover:bg-surface hover:text-foreground"
        aria-label={i18nService.t('browserAnnotationRemove')}
        title={i18nService.t('browserAnnotationRemove')}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
