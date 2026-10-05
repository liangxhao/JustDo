import { PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid';

import { i18nService } from '@/services/i18n';

interface RunControlButtonProps {
  isRunning: boolean;
  isStopping: boolean;
  canSubmit: boolean;
  canQueue?: boolean;
  size: 'normal' | 'large';
  sendTitle: string;
  sendLabel?: string;
  sendText?: string;
  onStop?: () => void;
  onSend: () => void;
}

/** Editing may be blocked by a question or compaction; cancellation remains available. */
export const RunControlButton = ({
  isRunning,
  isStopping,
  canSubmit,
  canQueue = false,
  size,
  sendTitle,
  sendLabel,
  sendText,
  onStop,
  onSend,
}: RunControlButtonProps) => {
  const queueControl = isRunning && !isStopping && canQueue && canSubmit;
  const stoppingControl = isStopping || (isRunning && !queueControl);
  const disabled = stoppingControl ? isStopping || !onStop : !canSubmit;
  const label =
    !stoppingControl && !queueControl && sendLabel
      ? sendLabel
      : i18nService.t(
          stoppingControl
            ? isStopping
              ? 'coworkStopping'
              : 'coworkStopTask'
            : queueControl
              ? 'coworkQueueMessage'
              : 'coworkSendMessage',
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
      title={stoppingControl || queueControl ? label : sendTitle}
      className={`inline-flex items-center justify-center gap-1.5 p-2 ${sendText && !stoppingControl && !queueControl ? 'px-3' : ''} ${shapeClass} ${colorClass} text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${disabled ? 'opacity-50' : ''}`}
    >
      {stoppingControl ? (
        <StopIcon className={iconClass} />
      ) : (
        <PaperAirplaneIcon className={iconClass} />
      )}
      {!stoppingControl && !queueControl && sendText && (
        <span className="whitespace-nowrap text-xs font-medium">{sendText}</span>
      )}
    </button>
  );
};
