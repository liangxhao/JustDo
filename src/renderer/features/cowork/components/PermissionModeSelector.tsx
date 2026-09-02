import {
  ArrowPathIcon,
  CheckIcon,
  ChevronUpIcon,
  CommandLineIcon,
  ExclamationCircleIcon,
  HandRaisedIcon,
} from '@heroicons/react/24/outline';
import {
  PermissionMode,
  type PermissionMode as PermissionModeValue,
} from '@shared/openclaw/approvals';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { selectCurrentSession } from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

const MODE_ICONS: Record<
  PermissionModeValue,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  [PermissionMode.Ask]: HandRaisedIcon,
  [PermissionMode.Auto]: CommandLineIcon,
  [PermissionMode.Full]: ExclamationCircleIcon,
};

interface PermissionModeSelectorProps {
  disabled?: boolean;
}

const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({ disabled = false }) => {
  const defaultPermissionMode = useSelector(
    (state: RootState) => state.cowork.config.permissionMode,
  );
  const currentSession = useSelector(selectCurrentSession);
  const permissionMode = currentSession?.permissionMode ?? defaultPermissionMode;
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const options = [
    {
      value: PermissionMode.Ask,
      label: i18nService.t('permissionModeAsk'),
      description: i18nService.t('permissionModeAskDescription'),
    },
    {
      value: PermissionMode.Auto,
      label: i18nService.t('permissionModeAuto'),
      description: i18nService.t('permissionModeAutoDescription'),
    },
    {
      value: PermissionMode.Full,
      label: i18nService.t('permissionModeFull'),
      description: i18nService.t('permissionModeFullDescription'),
    },
  ];

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!disabled) return;
    setIsOpen(false);
    setConfirmingFullAccess(false);
  }, [disabled]);

  const handleSelect = async (nextMode: PermissionModeValue): Promise<void> => {
    if (disabled) return;
    if (nextMode === permissionMode) {
      setIsOpen(false);
      return;
    }
    if (nextMode === PermissionMode.Full && !confirmingFullAccess) {
      setConfirmingFullAccess(true);
      setError(null);
      return;
    }
    setIsSaving(true);
    setError(null);
    setConfirmingFullAccess(false);
    setIsOpen(false);
    try {
      const result = await coworkService.updatePermissionMode(nextMode);
      if (!result.success) {
        setError(result.error || i18nService.t('permissionModeSaveFailed'));
        if (!disabledRef.current) setIsOpen(true);
        return;
      }
    } catch {
      setError(i18nService.t('permissionModeSaveFailed'));
      if (!disabledRef.current) setIsOpen(true);
    } finally {
      setIsSaving(false);
    }
  };

  const isFull = permissionMode === PermissionMode.Full;
  const CurrentModeIcon = MODE_ICONS[permissionMode];
  const currentLabel = options.find(option => option.value === permissionMode)?.label;

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled || isSaving}
        onClick={() => {
          setError(null);
          setConfirmingFullAccess(false);
          setIsOpen(open => !open);
        }}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-wait disabled:opacity-70 ${
          isFull
            ? 'bg-warning/10 text-warning hover:bg-warning/20'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        }`}
        aria-label={i18nService.t('permissionModeTitle')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <CurrentModeIcon className="h-3.5 w-3.5" />
        <span>{currentLabel}</span>
        {isSaving ? (
          <ArrowPathIcon className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <ChevronUpIcon
            className={`h-2.5 w-2.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {isOpen && (
        <div
          className="absolute bottom-full left-0 z-50 mb-1.5 w-max min-w-52 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border/80 bg-surface p-1 shadow-lg"
          role="listbox"
          aria-label={i18nService.t('permissionModeTitle')}
        >
          {confirmingFullAccess ? (
            <div className="w-64 p-2">
              <div className="flex items-start gap-2">
                <ExclamationCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-warning">
                    {i18nService.t('permissionModeFullConfirmTitle')}
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-secondary">
                    {i18nService.t('permissionModeFullConfirmDescription')}
                  </div>
                </div>
              </div>
              {error && <div className="mt-2 text-[11px] leading-4 text-danger">{error}</div>}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setConfirmingFullAccess(false)}
                  className="rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-surface-raised disabled:opacity-60"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleSelect(PermissionMode.Full)}
                  className="rounded-md bg-warning px-2.5 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {i18nService.t('permissionModeFullConfirmAction')}
                </button>
              </div>
            </div>
          ) : (
            options.map(option => {
              const selected = option.value === permissionMode;
              const OptionIcon = MODE_ICONS[option.value];
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={isSaving}
                  onClick={() => void handleSelect(option.value)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                    selected ? 'bg-primary/8' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="flex h-4 w-4 flex-shrink-0 self-start items-center justify-center">
                    <OptionIcon
                      className={`h-3.5 w-3.5 ${
                        option.value === PermissionMode.Full
                          ? 'text-warning'
                          : selected
                            ? 'text-primary'
                            : 'text-secondary'
                      }`}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block whitespace-nowrap text-[11px] font-medium leading-4 ${
                        option.value === PermissionMode.Full ? 'text-warning' : 'text-foreground'
                      }`}
                    >
                      {option.label}
                    </span>
                    <span
                      className={`block whitespace-nowrap text-[10px] leading-3.5 ${
                        option.value === PermissionMode.Full ? 'text-warning' : 'text-secondary'
                      }`}
                    >
                      {option.description}
                    </span>
                  </span>
                  <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                    {selected && <CheckIcon className="h-3.5 w-3.5 text-primary" />}
                  </span>
                </button>
              );
            })
          )}
          {!confirmingFullAccess && error && (
            <div className="border-t border-border px-2.5 pb-1 pt-2 text-[11px] leading-4 text-danger">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PermissionModeSelector;
