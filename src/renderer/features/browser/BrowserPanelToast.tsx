import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

export const BrowserNoticeTone = {
  Success: 'success',
  Info: 'info',
  Warning: 'warning',
  Error: 'error',
} as const;

export type BrowserNoticeTone = (typeof BrowserNoticeTone)[keyof typeof BrowserNoticeTone];

const toneStyles = {
  [BrowserNoticeTone.Success]: {
    Icon: CheckCircleIcon,
    accent: 'border-l-emerald-400',
    iconSurface: 'bg-emerald-400/15 text-emerald-300',
  },
  [BrowserNoticeTone.Info]: {
    Icon: InformationCircleIcon,
    accent: 'border-l-sky-400',
    iconSurface: 'bg-sky-400/15 text-sky-300',
  },
  [BrowserNoticeTone.Warning]: {
    Icon: ExclamationTriangleIcon,
    accent: 'border-l-amber-400',
    iconSurface: 'bg-amber-400/15 text-amber-300',
  },
  [BrowserNoticeTone.Error]: {
    Icon: ExclamationCircleIcon,
    accent: 'border-l-rose-400',
    iconSurface: 'bg-rose-400/15 text-rose-300',
  },
};

export function BrowserPanelToast({
  message,
  onDismiss,
  tone,
}: {
  message: string;
  onDismiss: () => void;
  tone: BrowserNoticeTone;
}) {
  const { Icon, accent, iconSurface } = toneStyles[tone];

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-50 flex justify-end">
      <div
        role={tone === BrowserNoticeTone.Error ? 'alert' : 'status'}
        className={`pointer-events-auto flex min-w-0 max-w-sm items-start gap-3 rounded-xl border border-l-4 border-white/20 bg-neutral-900 py-2.5 pl-2.5 pr-2 text-white shadow-xl shadow-black/35 animate-scale-in ${accent}`}
      >
        <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${iconSurface}`}>
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <span className="min-w-0 self-center text-sm font-medium leading-5 [overflow-wrap:anywhere]">
          {message}
        </span>
        <button
          type="button"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label={i18nService.t('browserPanelDismissNotice')}
          onClick={onDismiss}
        >
          <XMarkIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
