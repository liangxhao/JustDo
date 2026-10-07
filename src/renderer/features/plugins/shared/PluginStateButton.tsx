import {
  ArrowPathIcon,
  CheckCircleIcon,
  LockClosedIcon,
  MinusCircleIcon,
} from '@heroicons/react/24/outline';
import React from 'react';

import { i18nService } from '@/services/i18n';
import Tooltip from '@/shared/components/ui/Tooltip';

interface PluginStateButtonProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onToggle: () => void;
}

interface PluginLockedIndicatorProps {
  checked: boolean;
  label: string;
}

export const PluginLockedIndicator: React.FC<PluginLockedIndicatorProps> = ({ checked, label }) => {
  const statusLabel = `${i18nService.t(checked ? 'pluginStatusEnabled' : 'pluginStatusDisabled')} · ${label}`;
  return (
    <Tooltip
      content={statusLabel}
      position="bottom"
      className="pointer-events-auto flex h-6 w-6 shrink-0"
    >
      <span
        role="img"
        aria-label={statusLabel}
        className={`relative flex h-6 w-6 items-center justify-center ${
          checked ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
        }`}
      >
        {checked ? (
          <CheckCircleIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        ) : (
          <MinusCircleIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        )}
        <LockClosedIcon className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-sm bg-surface text-secondary" />
      </span>
    </Tooltip>
  );
};

const PluginStateButton: React.FC<PluginStateButtonProps> = ({
  checked,
  label,
  disabled = false,
  busy = false,
  onToggle,
}) => (
  <Tooltip content={label} position="bottom">
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-label={label}
      disabled={disabled}
      onMouseUp={event => event.currentTarget.blur()}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
        disabled
          ? 'cursor-not-allowed text-secondary opacity-40'
          : checked
            ? 'cursor-pointer text-emerald-600 hover:bg-surface-raised dark:text-emerald-400'
            : 'cursor-pointer text-amber-600 hover:bg-surface-raised dark:text-amber-400'
      }`}
    >
      {busy ? (
        <ArrowPathIcon className="h-4 w-4 animate-spin text-primary" />
      ) : checked ? (
        <CheckCircleIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      ) : (
        <MinusCircleIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      )}
    </button>
  </Tooltip>
);

export default PluginStateButton;
