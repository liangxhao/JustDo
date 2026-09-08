import { ArrowPathIcon, CheckIcon, ChevronDownIcon, PhotoIcon } from '@heroicons/react/24/outline';
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
  disabled?: boolean;
  loading?: boolean;
  /** Optional agent-scoped models enriched from the OpenClaw runtime catalog. */
  models?: Model[];
  /** Refresh runtime facts when the picker is opened. */
  onOpen?: () => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'down',
  dropdownAlign = 'left',
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

  const isSelected = (model: Model): boolean => {
    if (!selectedModel) return false;
    return isSameModelIdentity(model, selectedModel);
  };

  const renderModelItem = (model: Model) => {
    const label = model.provider ? `${model.provider}/${model.name}` : model.name;
    const selected = isSelected(model);
    return (
      <button
        type="button"
        key={getModelIdentityKey(model)}
        onClick={() => handleModelSelect(model)}
        aria-current={selected ? 'true' : undefined}
        className={`group flex h-9 w-max min-w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors ${
          selected ? 'bg-surface-raised' : 'hover:bg-surface-raised'
        }`}
      >
        <span
          className="max-w-[min(24rem,calc(100vw-7rem))] flex-1 truncate whitespace-nowrap leading-none"
          title={label}
        >
          {model.provider && <span className="text-secondary">{model.provider}</span>}
          {model.provider && <span className="text-muted">/</span>}
          <span className="text-foreground">{model.name}</span>
        </span>
        {model.supportsImage && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center text-primary"
            aria-label={i18nService.t('imageInput')}
            title={i18nService.t('imageInput')}
          >
            <PhotoIcon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        {selected && <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div ref={containerRef} className="relative cursor-pointer">
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-busy={loading}
        aria-expanded={isOpen}
        className={`flex h-8 max-w-56 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-foreground transition-colors hover:bg-surface-raised ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        <span className="truncate text-sm">{selectedModel?.name ?? defaultLabel ?? ''}</span>
        {loading ? (
          <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-secondary" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
        )}
      </button>

      {isOpen && (
        <div
          className={`absolute ${dropdownPositionClass} ${dropdownAlign === 'right' ? 'right-0' : 'left-0'} z-50 w-max min-w-48 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-surface p-2 shadow-popover popover-enter`}
        >
          <div className="max-h-64 overflow-y-auto">
            {defaultLabel && (
              <div className="mb-1 border-b border-border-subtle pb-1">
                <button
                  type="button"
                  onClick={() => handleModelSelect(null)}
                  aria-current={!selectedModel ? 'true' : undefined}
                  className={`flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-foreground transition-colors hover:bg-surface-raised ${
                    !selectedModel ? 'bg-surface-raised' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{defaultLabel}</span>
                  {!selectedModel && (
                    <CheckIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  )}
                </button>
              </div>
            )}
            {availableModels.map(renderModelItem)}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelector;
