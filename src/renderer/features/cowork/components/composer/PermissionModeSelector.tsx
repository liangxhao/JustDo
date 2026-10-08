import {
  ArrowPathIcon,
  CheckIcon,
  ChevronUpIcon,
  ClipboardDocumentListIcon,
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
  runActive?: boolean;
}

type PermissionOption = {
  kind: 'permission';
  value: PermissionModeValue;
  label: string;
  description: string;
};

type PlanOption = {
  kind: 'plan';
  value: 'plan';
  label: string;
  description: string;
};

type SelectorOption = PermissionOption | PlanOption;

const PermissionModeSelector: React.FC<PermissionModeSelectorProps> = ({
  disabled = false,
  runActive = false,
}) => {
  const defaultPermissionMode = useSelector(
    (state: RootState) => state.cowork.config.permissionMode,
  );
  const currentSession = useSelector(selectCurrentSession);
  const permissionMode = currentSession?.permissionMode ?? defaultPermissionMode;
  const newSessionPlanMode = useSelector((state: RootState) => state.cowork.newSessionPlanMode);
  const sessionPlanMode = useSelector((state: RootState) =>
    currentSession ? state.cowork.planModeBySession[currentSession.id] : undefined,
  );
  const planEnabled = currentSession ? (sessionPlanMode ?? false) : newSessionPlanMode;
  const selectorDisabled = disabled && !planEnabled;
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(selectorDisabled);
  disabledRef.current = selectorDisabled;
  const runActiveRef = useRef(runActive);
  runActiveRef.current = runActive;

  const options: SelectorOption[] = [
    {
      kind: 'permission',
      value: PermissionMode.Ask,
      label: i18nService.t('permissionModeAsk'),
      description: i18nService.t('permissionModeAskDescription'),
    },
    {
      kind: 'permission',
      value: PermissionMode.Auto,
      label: i18nService.t('permissionModeAuto'),
      description: i18nService.t('permissionModeAutoDescription'),
    },
    {
      kind: 'plan',
      value: 'plan',
      label: i18nService.t('planModeTitle'),
      description: i18nService.t('planModeDescription'),
    },
    {
      kind: 'permission',
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
    if (!selectorDisabled) return;
    setIsOpen(false);
    setConfirmingFullAccess(false);
  }, [selectorDisabled]);

  const handleSelect = async (option: SelectorOption): Promise<void> => {
    if (selectorDisabled || isSaving) return;
    if (option.kind === 'plan') {
      if (runActive || planEnabled) {
        setIsOpen(false);
        return;
      }
      setIsSaving(true);
      setError(null);
      setIsOpen(false);
      try {
        const success = await coworkService.setPlanMode(currentSession?.id, true);
        if (!success) {
          setError(i18nService.t('planModeSaveFailed'));
          if (!disabledRef.current && !runActiveRef.current) setIsOpen(true);
        }
      } catch {
        setError(i18nService.t('planModeSaveFailed'));
        if (!disabledRef.current && !runActiveRef.current) setIsOpen(true);
      } finally {
        setIsSaving(false);
      }
      return;
    }

    const nextMode = option.value;
    if (!planEnabled && nextMode === permissionMode) {
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
      if (planEnabled) {
        const success = await coworkService.setPlanMode(currentSession?.id, false);
        if (!success) {
          setError(i18nService.t('planModeSaveFailed'));
          if (!disabledRef.current && !runActiveRef.current) setIsOpen(true);
          return;
        }
      }
      if (nextMode !== permissionMode) {
        const result = await coworkService.updatePermissionMode(nextMode);
        if (!result.success) {
          if (planEnabled) await coworkService.setPlanMode(currentSession?.id, true);
          setError(result.error || i18nService.t('permissionModeSaveFailed'));
          if (!disabledRef.current) setIsOpen(true);
          return;
        }
      }
    } catch {
      if (planEnabled) await coworkService.setPlanMode(currentSession?.id, true);
      setError(i18nService.t('permissionModeSaveFailed'));
      if (!disabledRef.current) setIsOpen(true);
    } finally {
      setIsSaving(false);
    }
  };

  const isFull = !planEnabled && permissionMode === PermissionMode.Full;
  const CurrentModeIcon = planEnabled ? ClipboardDocumentListIcon : MODE_ICONS[permissionMode];
  const currentLabel = planEnabled
    ? i18nService.t('planModeTitle')
    : options.find(
        (option): option is PermissionOption =>
          option.kind === 'permission' && option.value === permissionMode,
      )?.label;
  const fullAccessOption = options.find(
    (option): option is PermissionOption =>
      option.kind === 'permission' && option.value === PermissionMode.Full,
  )!;

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={selectorDisabled || isSaving}
        onClick={() => {
          setError(null);
          setConfirmingFullAccess(false);
          setIsOpen(open => !open);
        }}
        className={`flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-wait disabled:opacity-70 ${
          planEnabled
            ? 'bg-primary/12 text-primary hover:bg-primary/18'
            : isFull
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
                  onClick={() => void handleSelect(fullAccessOption)}
                  className="rounded-md bg-warning px-2.5 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                >
                  {i18nService.t('permissionModeFullConfirmAction')}
                </button>
              </div>
            </div>
          ) : (
            options.map(option => {
              const isPlan = option.kind === 'plan';
              const selected = isPlan
                ? planEnabled
                : !planEnabled && option.value === permissionMode;
              const optionDisabled = isSaving || (runActive && isPlan);
              const OptionIcon = isPlan ? ClipboardDocumentListIcon : MODE_ICONS[option.value];
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={optionDisabled}
                  title={isPlan && runActive ? i18nService.t('planModeRunningHint') : undefined}
                  onClick={() => void handleSelect(option)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                    selected ? 'bg-primary/8' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="flex h-4 w-4 flex-shrink-0 self-start items-center justify-center">
                    <OptionIcon
                      className={`h-3.5 w-3.5 ${
                        !isPlan && option.value === PermissionMode.Full
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
                        !isPlan && option.value === PermissionMode.Full
                          ? 'text-warning'
                          : 'text-foreground'
                      }`}
                    >
                      {option.label}
                    </span>
                    <span
                      className={`block whitespace-nowrap text-[10px] leading-3.5 ${
                        !isPlan && option.value === PermissionMode.Full
                          ? 'text-warning'
                          : 'text-secondary'
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
