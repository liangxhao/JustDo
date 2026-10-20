import { StopIcon } from '@heroicons/react/24/outline';
import type { AgentResult } from '../state';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '../ui';

/** Native receipts keep owning execution state; an acknowledgement only ends the button's wait. */
export default function CollaborationStopButton({
  stop,
  label,
  disabled = false,
}: {
  stop: () => Promise<AgentResult<void>>;
  label: string;
  disabled?: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const handleStop = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setStopping(true);
    try {
      const result = await stop();
      if (!result.success) throw new Error('collaborationStopFailed');
    } catch {
      if (mounted.current)
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: { message: i18nService.t('collaborationStopFailed'), tone: 'error' },
          }),
        );
    } finally {
      pending.current = false;
      if (mounted.current) setStopping(false);
    }
  };
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-busy={stopping}
      disabled={disabled || stopping}
      onClick={() => void handleStop()}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
    >
      {stopping ? (
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        <StopIcon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
