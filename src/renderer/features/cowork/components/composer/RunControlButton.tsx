import { ArrowUpIcon } from '@heroicons/react/24/outline';
import { StopIcon } from '@heroicons/react/24/solid';

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
  const showSendText = !stoppingControl && !queueControl && Boolean(sendText);
  const shapeClass = showSendText
    ? `rounded-lg px-3 ${size === 'large' ? 'py-2' : 'py-1.5'}`
    : 'h-7 w-7 rounded-full';

  return (
    <button
      type="button"
      onClick={stoppingControl ? onStop : onSend}
      disabled={disabled}
      aria-busy={isStopping || undefined}
      aria-label={label}
      title={stoppingControl || queueControl ? label : sendTitle}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 ${shapeClass} bg-primary hover:bg-primary-hover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${disabled ? 'opacity-50' : ''}`}
    >
      {stoppingControl ? <StopIcon className="h-4 w-4" /> : <ArrowUpIcon className="h-4 w-4" />}
      {showSendText && <span className="whitespace-nowrap text-xs font-medium">{sendText}</span>}
    </button>
  );
};
