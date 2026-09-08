import { PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid';

import { i18nService } from '@/services/i18n';

interface RunControlButtonProps {
  isRunning: boolean;
  isStopping: boolean;
  canSubmit: boolean;
  size: 'normal' | 'large';
  sendTitle: string;
  onStop?: () => void;
  onSend: () => void;
}

/** Editing may be blocked by a question or compaction; cancellation remains available. */
export const RunControlButton = ({
  isRunning,
  isStopping,
  canSubmit,
  size,
  sendTitle,
  onStop,
  onSend,
}: RunControlButtonProps) => {
  const stoppingControl = isRunning || isStopping;
  const disabled = stoppingControl ? isStopping || !onStop : !canSubmit;
  const label = i18nService.t(
    stoppingControl ? (isStopping ? 'coworkStopping' : 'coworkStopTask') : 'coworkSendMessage',
  );
  const iconClass = size === 'large' ? 'h-5 w-5' : 'h-4 w-4';
  const shapeClass = size === 'large' ? 'rounded-xl' : 'flex-shrink-0 rounded-lg';
  const colorClass = stoppingControl
    ? 'bg-red-500 hover:bg-red-600'
    : 'bg-primary hover:bg-primary-hover';

  return (
    <button
      type="button"
      onClick={stoppingControl ? onStop : onSend}
      disabled={disabled}
      aria-busy={isStopping || undefined}
      aria-label={label}
      title={stoppingControl ? label : sendTitle}
      className={`p-2 ${shapeClass} ${colorClass} text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${disabled ? 'opacity-50' : ''}`}
    >
      {stoppingControl ? (
        <StopIcon className={iconClass} />
      ) : (
        <PaperAirplaneIcon className={iconClass} />
      )}
    </button>
  );
};
