import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { isBuiltinModelsProvider } from '@/app/config';
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
  dropdownAlign?: 'left' | 'right';
  /**
   * Controlled mode: the currently selected Model (or `null` for "default").
   * When provided, the component does NOT read/write Redux global state.
   */
  value?: Model | null;
  /** Controlled mode callback. `null` means the user picked "default". */
  onChange?: (model: Model | null) => void;
  /** Show a "default" option at the top of the dropdown (controlled mode only). */
  defaultLabel?: string;
  /** Label for an unresolved selection; does not add a selectable default option. */
  emptyLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Optional agent-scoped models enriched from the OpenClaw runtime catalog. */
  models?: Model[];
  /** Refresh runtime facts when the picker is opened. */
  onOpen?: () => void;
}

const modelOptionClass =
  'flex h-8 w-full items-center gap-2 rounded-lg pr-2.5 text-left text-[13px] text-foreground transition-colors';

function groupModelsByProvider(models: Model[]) {
  const groups = new Map<Model['providerKey'], Model[]>();
  for (const model of models) {
    const group = groups.get(model.providerKey);
    if (group) group.push(model);
    else groups.set(model.providerKey, [model]);
  }
  return [...groups];
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'down',
  dropdownAlign = 'left',
  value,
  onChange,
  defaultLabel,
  emptyLabel,
  disabled = false,
  loading = false,
  models,
  onOpen,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const optionsId = React.useId();

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
    triggerRef.current?.focus();
  };

  const handleToggle = () => {
    if (!isOpen) onOpen?.();
    setIsOpen(!isOpen);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.stopPropagation();
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  // 如果没有可用模型，显示提示
  if (availableModels.length === 0) {
    return (
      <div
        role="status"
        className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-secondary"
        title={i18nService.t('modelSelectorNoModels')}
      >
        <ExclamationTriangleIcon className="h-3.5 w-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate text-xs">
          {i18nService.t('modelSelectorNotConfigured')}
        </span>
      </div>
    );
  }

  const dropdownPositionClass = dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1';
  const selectedLabel =
    selectedModel?.name || defaultLabel || emptyLabel || i18nService.t('modelSelectorChooseModel');

  const renderModelItem = (model: Model) => {
    const selected = selectedModel !== null && isSameModelIdentity(model, selectedModel);
    return (
      <button
        type="button"
        key={getModelIdentityKey(model)}
        onClick={() => handleModelSelect(model)}
        aria-current={selected ? 'true' : undefined}
        className={`${modelOptionClass} pl-5 ${
          selected ? 'bg-primary-muted font-medium' : 'hover:bg-surface-raised'
        }`}
      >
        <span className="min-w-0 max-w-96 flex-1 truncate" title={model.name}>
          {model.name}
        </span>
        {model.supportsImage && (
          <span
            role="img"
            className="shrink-0 text-secondary"
            aria-label={i18nService.t('imageInput')}
            title={i18nService.t('imageInput')}
          >
            <PhotoIcon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        <span className="h-4 w-4 shrink-0 text-primary" aria-hidden="true">
          {selected && <CheckIcon className="h-4 w-4" />}
        </span>
      </button>
    );
  };

  return (
    <div ref={containerRef} onKeyDown={handleKeyDown} className="relative w-full min-w-0 max-w-56">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-busy={loading}
        aria-expanded={isOpen}
        aria-controls={isOpen ? optionsId : undefined}
        title={selectedLabel}
        className={`flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-foreground transition-colors hover:bg-surface-raised ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="min-w-0 truncate text-sm" dir="rtl">
          <bdi>{selectedLabel}</bdi>
        </span>
        {loading ? (
          <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-secondary" />
        ) : (
          <ChevronDownIcon
            className={`h-3.5 w-3.5 shrink-0 text-secondary ${isOpen ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {isOpen && (
        <div
          id={optionsId}
          className={`absolute ${dropdownPositionClass} ${dropdownAlign === 'right' ? 'right-0' : 'left-0'} z-50 w-max min-w-[min(16rem,calc(100vw-4rem))] max-w-[calc(100vw-4rem)] overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-popover popover-enter`}
        >
          <div className="max-h-64 overflow-y-auto">
            {defaultLabel && (
              <button
                type="button"
                onClick={() => handleModelSelect(null)}
                aria-current={!selectedModel ? 'true' : undefined}
                className={`${modelOptionClass} pl-2.5 ${
                  !selectedModel ? 'bg-primary-muted font-medium' : 'hover:bg-surface-raised'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{defaultLabel}</span>
                {!selectedModel && (
                  <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                )}
              </button>
            )}
            {groupModelsByProvider(availableModels).map(([providerKey, groupModels]) => {
              const label =
                providerKey && isBuiltinModelsProvider(providerKey)
                  ? i18nService.t('builtinModelsProvider')
                  : groupModels[0].provider;
              return (
                <div
                  key={providerKey}
                  role="group"
                  aria-label={label}
                  className="before:mx-2.5 before:my-1.5 before:block before:border-t before:border-border-subtle first:before:hidden"
                >
                  <div
                    className="mb-0.5 truncate rounded-md bg-surface-raised px-2.5 py-1 text-xs font-semibold text-secondary"
                    title={label}
                  >
                    {label}
                  </div>
                  {groupModels.map(renderModelItem)}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
