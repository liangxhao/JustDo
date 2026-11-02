import { ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

import { PluginOperationStatusContent } from './PluginOperationStatusSlot';

export const PluginActivityTone = {
  PROGRESS: 'progress',
  WARNING: 'warning',
  ERROR: 'error',
} as const;

export default function PluginActivityStatus({
  message,
  title,
  tone = PluginActivityTone.PROGRESS,
}: {
  message: string;
  title?: string;
  tone?: (typeof PluginActivityTone)[keyof typeof PluginActivityTone];
}) {
  return (
    <PluginOperationStatusContent>
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-xs shadow-lg animate-fade-in-up"
      >
        {tone === PluginActivityTone.PROGRESS ? (
          <ArrowPathIcon
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary"
          />
        ) : (
          <ExclamationTriangleIcon
            aria-hidden="true"
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              tone === PluginActivityTone.ERROR
                ? 'text-red-600 dark:text-red-400'
                : 'text-amber-700 dark:text-amber-300'
            }`}
          />
        )}
        <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
          {title && <p className="mb-0.5 font-medium text-foreground">{title}</p>}
          <p className="whitespace-pre-wrap text-secondary">{message}</p>
        </div>
      </div>
    </PluginOperationStatusContent>
  );
}
