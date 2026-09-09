import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';

export type ToastTone = 'error' | 'info' | 'success' | 'warning';

export interface ToastContent {
  message: string;
  title?: string;
  tone?: ToastTone;
  duration?: number;
}

interface ToastProps extends ToastContent {
  onClose?: () => void;
}

const TONE_STYLES: Record<ToastTone, { accent: string; icon: string; iconSurface: string }> = {
  error: {
    accent: 'bg-red-500',
    icon: 'text-red-600 dark:text-red-300',
    iconSurface: 'bg-red-50 dark:bg-red-950/70',
  },
  info: {
    accent: 'bg-primary',
    icon: 'text-primary',
    iconSurface: 'bg-primary-muted',
  },
  success: {
    accent: 'bg-emerald-500',
    icon: 'text-emerald-600 dark:text-emerald-300',
    iconSurface: 'bg-emerald-50 dark:bg-emerald-950/70',
  },
  warning: {
    accent: 'bg-amber-500',
    icon: 'text-amber-600 dark:text-amber-300',
    iconSurface: 'bg-amber-50 dark:bg-amber-950/70',
  },
};

const Toast: React.FC<ToastProps> = ({ message, onClose, title, tone = 'info' }) => {
  const styles = TONE_STYLES[tone];
  const Icon =
    tone === 'warning'
      ? ExclamationTriangleIcon
      : tone === 'error'
        ? ExclamationCircleIcon
        : tone === 'success'
          ? CheckCircleIcon
          : InformationCircleIcon;

  return (
    <div className="pointer-events-none fixed left-4 right-4 top-14 z-[10000] flex justify-center sm:left-auto sm:right-5 sm:justify-end">
      <div
        className="pointer-events-auto relative w-full max-w-[420px] overflow-hidden rounded-xl border border-border/80 bg-surface/95 text-foreground shadow-[0_18px_48px_rgba(15,23,42,0.20)] backdrop-blur-xl animate-scale-in dark:shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
        role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}
        aria-live={tone === 'error' || tone === 'warning' ? 'assertive' : 'polite'}
      >
        <div className={`absolute inset-y-0 left-0 w-1 ${styles.accent}`} aria-hidden="true" />
        <div className="flex items-start gap-3 py-3.5 pl-4 pr-3">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${styles.iconSurface}`}
          >
            <Icon className={`h-5 w-5 ${styles.icon}`} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {title && <div className="text-sm font-semibold leading-5">{title}</div>}
            <div
              className={`${title ? 'mt-0.5 text-secondary' : 'text-foreground'} text-sm leading-5`}
            >
              {message}
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="-mr-0.5 -mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-surface-raised hover:text-foreground"
              aria-label={i18nService.t('dismiss')}
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Toast;
