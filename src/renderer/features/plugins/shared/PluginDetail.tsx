import { XMarkIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

import { i18nService } from '@/services/i18n';

export const PLUGIN_DETAIL_MODAL_CLASS_NAME =
  'mx-4 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl';
export const PLUGIN_DETAIL_BODY_CLASS_NAME =
  'min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-6 pb-2 [overflow-wrap:anywhere]';
export const PLUGIN_DETAIL_FOOTER_CLASS_NAME =
  'flex shrink-0 flex-wrap items-center gap-3 px-6 py-4';

export const PluginDetailHeader = ({
  title,
  icon,
  artworkTone,
  version,
  onClose,
  busy = false,
}: {
  title: string;
  icon: ReactNode;
  artworkTone: string;
  version?: string;
  onClose?: () => void;
  busy?: boolean;
}) => (
  <div className="flex shrink-0 items-start gap-3 px-6 pb-5 pt-6">
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${artworkTone}`}
    >
      {icon}
    </div>
    <div className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <h2 className="text-base font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
        {title}
      </h2>
      {version && <span className="text-[11px] text-secondary">v{version}</span>}
    </div>
    {onClose && (
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="mt-1 shrink-0 rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        aria-label={i18nService.t('close')}
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
    )}
  </div>
);
