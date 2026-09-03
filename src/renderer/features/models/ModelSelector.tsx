import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { Model } from '@/features/models/modelSlice';
import {
  getModelIdentityKey,
  isSameModelIdentity,
  setSelectedModel,
} from '@/features/models/modelSlice';
import { i18nService } from '@/services/i18n';
import { RootState } from '@/store';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down';
  /**
   * Controlled mode: the currently selected Model (or `null` for "default").
   * When provided, the component does NOT read/write Redux global state.
   */
  value?: Model | null;
  /** Controlled mode callback. `null` means the user picked "default". */
  onChange?: (model: Model | null) => void;
  /** Show a "default" option at the top of the dropdown (controlled mode only). */
  defaultLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Optional agent-scoped models enriched from the OpenClaw runtime catalog. */
  models?: Model[];
  /** Refresh runtime facts when the picker is opened. */
  onOpen?: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'down',
  value,
  onChange,
  defaultLabel,
  disabled = false,
  loading = false,
  models,
  onOpen,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const controlled = onChange !== undefined;
  const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const selectedModel = controlled ? (value ?? null) : globalSelectedModel;
  const globalAvailableModels = useSelector((state: RootState) => state.model.availableModels);
  const availableModels = models ?? globalAvailableModels;

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const handleModelSelect = (model: Model | null) => {
    if (disabled) return;
    if (controlled) {
      onChange(model);
    } else if (model) {
      dispatch(setSelectedModel(model));
    }
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (!isOpen) onOpen?.();
    setIsOpen(!isOpen);
  };

  // 如果没有可用模型，显示提示
  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl bg-surface text-secondary text-sm">
        {i18nService.t('modelSelectorNoModels')}
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1';

  const serverModels = availableModels.filter(m => m.isServerModel);
  const userModels = availableModels.filter(m => !m.isServerModel);
  const hasBothGroups = serverModels.length > 0 && userModels.length > 0;

  const isSelected = (model: Model): boolean => {
    if (!selectedModel) return false;
    return isSameModelIdentity(model, selectedModel);
  };

  const formatContextLength = (value: number): string => {
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
  };

  const getUnavailableLabel = (model: Model): string => {
    switch (model.unavailableReason) {
      case 'missing-auth':
        return i18nService.t('modelUnavailableMissingAuth');
      case 'auth-failed':
        return i18nService.t('modelUnavailableAuthFailed');
      case 'cooldown':
        return model.unavailableUntil && model.unavailableUntil > Date.now()
          ? i18nService
              .t('modelUnavailableCooldownUntil')
              .replace('{time}', new Date(model.unavailableUntil).toLocaleString())
          : i18nService.t('modelUnavailableCooldown');
      default:
        return i18nService.t('modelUnavailable');
    }
  };

  const renderModelItem = (model: Model) => {
    const unavailable = model.available === false;
    const details = [
      model.provider,
      model.contextLength ? formatContextLength(model.contextLength) : undefined,
    ].filter(Boolean);
    return (
      <button
        type="button"
        key={getModelIdentityKey(model)}
        onClick={() => {
          if (!unavailable) handleModelSelect(model);
        }}
        aria-disabled={unavailable}
        title={unavailable ? getUnavailableLabel(model) : undefined}
        className={`w-full px-4 py-2.5 text-left text-foreground flex items-center justify-between transition-colors ${
          unavailable ? 'cursor-not-allowed opacity-55' : 'hover:bg-surface-raised'
        } ${isSelected(model) ? 'bg-surface-raised/50' : ''}`}
      >
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm">{model.name}</span>
            {model.supportsImage && (
              <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-md bg-primary/10 text-primary whitespace-nowrap">
                {i18nService.t('imageInput')}
              </span>
            )}
            {model.reasoning && (
              <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-md bg-primary/10 text-primary whitespace-nowrap">
                {i18nService.t('modelReasoning')}
              </span>
            )}
            {model.supportsTools === false && (
              <span className="text-[10px] leading-none px-1.5 py-0.5 rounded-md bg-warning/10 text-warning whitespace-nowrap">
                {i18nService.t('modelNoTools')}
              </span>
            )}
          </div>
          {(unavailable || details.length > 0) && (
            <span className="truncate text-xs text-secondary">
              {unavailable ? getUnavailableLabel(model) : details.join(' · ')}
            </span>
          )}
        </div>
        {isSelected(model) && <CheckIcon className="h-4 w-4 shrink-0 text-primary" />}
      </button>
    );
  };

  const renderGroupHeader = (label: string) => (
    <div className="px-4 py-1.5 text-xs font-medium text-secondary uppercase tracking-wider">
      {label}
    </div>
  );

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-busy={loading}
        aria-expanded={isOpen}
        className={`flex items-center space-x-2 px-3 py-1.5 rounded-xl hover:bg-surface-raised text-foreground transition-colors cursor-pointer ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="font-medium text-sm">{selectedModel?.name ?? defaultLabel ?? ''}</span>
        {selectedModel?.available === false && (
          <ExclamationTriangleIcon
            className="h-4 w-4 text-warning"
            aria-label={getUnavailableLabel(selectedModel)}
            title={getUnavailableLabel(selectedModel)}
          />
        )}
        {loading ? (
          <ArrowPathIcon className="h-4 w-4 animate-spin text-secondary" />
        ) : (
          <ChevronDownIcon className="h-4 w-4 text-secondary" />
        )}
      </button>

      {isOpen && (
        <div
          className={`absolute ${dropdownPositionClass} w-60 bg-surface rounded-xl popover-enter shadow-popover z-50 border-border border overflow-hidden`}
        >
          <div className="max-h-64 overflow-y-auto">
            {defaultLabel && (
              <button
                type="button"
                onClick={() => handleModelSelect(null)}
                className={`w-full px-4 py-2.5 text-left text-foreground hover:bg-surface-raised flex items-center justify-between transition-colors ${
                  !selectedModel ? 'bg-surface-raised/50' : ''
                }`}
              >
                <span className="text-sm">{defaultLabel}</span>
                {!selectedModel && <CheckIcon className="h-4 w-4 text-primary" />}
              </button>
            )}
            {hasBothGroups ? (
              <>
                {renderGroupHeader(i18nService.t('modelGroupServer'))}
                {serverModels.map(renderModelItem)}
                <div className="my-1 border-t border-border" />
                {renderGroupHeader(i18nService.t('modelGroupUser'))}
                {userModels.map(renderModelItem)}
              </>
            ) : (
              availableModels.map(renderModelItem)
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
