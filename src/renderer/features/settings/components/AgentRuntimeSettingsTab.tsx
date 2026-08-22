import {
  ArrowPathIcon,
  ChevronDownIcon,
  CpuChipIcon,
  MinusIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import {
  AGENT_RUNTIME_LIMITS,
  AgentRuntimeDelegationMode,
  type AgentRuntimeSettings,
  AgentRuntimeThinkingLevel,
} from '@shared/openclaw/agentRuntimeSettings';
import React, { useMemo, useState } from 'react';

import type { Model } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

type Props = {
  settings: AgentRuntimeSettings;
  models: Model[];
  isLoading: boolean;
  loadError: string | null;
  onChange: (settings: AgentRuntimeSettings) => void;
  onRetry: () => void;
};

const SettingRow: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className="grid gap-3 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(180px,1fr)_minmax(260px,320px)] sm:items-center sm:gap-6">
    <div className="min-w-0">
      <div className="text-sm font-medium text-foreground">{label}</div>
      {description && <p className="mt-0.5 text-xs leading-4 text-secondary">{description}</p>}
    </div>
    <div className="min-w-0">{children}</div>
  </div>
);

const NumberControl: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}> = ({ label, value, min, max, onChange }) => {
  const setValue = (next: number) => {
    const normalized = Number.isFinite(next) ? Math.round(next) : min;
    onChange(Math.min(max, Math.max(min, normalized)));
  };
  return (
    <div className="ml-auto flex h-9 w-32 items-center overflow-hidden rounded-lg border border-border bg-surface-inset">
      <button
        type="button"
        onClick={() => setValue(value - 1)}
        disabled={value <= min}
        className="flex h-full w-9 items-center justify-center text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-30"
        aria-label={`${label} -`}
      >
        <MinusIcon className="h-3.5 w-3.5" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={event => setValue(Number(event.target.value) || min)}
        className="h-full min-w-0 flex-1 border-x border-border bg-transparent px-1 text-center text-sm font-medium tabular-nums text-foreground outline-none"
        aria-label={label}
      />
      <button
        type="button"
        onClick={() => setValue(value + 1)}
        disabled={value >= max}
        className="flex h-full w-9 items-center justify-center text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-30"
        aria-label={`${label} +`}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

const CollapsibleSection: React.FC<{
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, description, open, onToggle, children }) => (
  <section className="overflow-hidden rounded-xl border border-border bg-surface">
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-3 bg-surface-raised px-4 py-2.5 text-left hover:bg-surface-inset"
      aria-expanded={open}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] leading-4 text-secondary">
          {description}
        </span>
      </span>
      <ChevronDownIcon
        className={`h-4 w-4 shrink-0 text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>
    {open && <div className="border-t border-border">{children}</div>}
  </section>
);

const AgentRuntimeSettingsTab: React.FC<Props> = ({
  settings,
  models,
  isLoading,
  loadError,
  onChange,
  onRetry,
}) => {
  const [agentOpen, setAgentOpen] = useState(true);
  const [subagentOpen, setSubagentOpen] = useState(true);
  const subagents = settings.subagents;
  const updateAskUserQuestion = (update: Partial<AgentRuntimeSettings['askUserQuestion']>) =>
    onChange({
      ...settings,
      askUserQuestion: { ...settings.askUserQuestion, ...update },
    });
  const updateSubagents = (update: Partial<AgentRuntimeSettings['subagents']>) =>
    onChange({ ...settings, subagents: { ...subagents, ...update } });

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options = models.flatMap(model => {
      const value = toOpenClawModelRef(model);
      if (!value || seen.has(value)) return [];
      seen.add(value);
      const provider = model.provider?.trim();
      return [{ value, label: provider ? `${model.name} · ${provider}` : model.name }];
    });
    return [{ value: '', label: i18nService.t('agentRuntimeInheritParentModel') }, ...options];
  }, [models]);
  const selectedModelAvailable =
    !subagents.model || modelOptions.some(option => option.value === subagents.model);
  const displayedModelOptions =
    subagents.model && !selectedModelAvailable
      ? [
          ...modelOptions,
          {
            value: subagents.model,
            label: `${i18nService.t('agentRuntimeUnavailableModel')} · ${subagents.model}`,
          },
        ]
      : modelOptions;

  const thinkingOptions = [
    { value: '', label: i18nService.t('agentRuntimeInheritParentThinking') },
    { value: AgentRuntimeThinkingLevel.Off, label: i18nService.t('agentRuntimeThinkingOff') },
    {
      value: AgentRuntimeThinkingLevel.Minimal,
      label: i18nService.t('agentRuntimeThinkingMinimal'),
    },
    { value: AgentRuntimeThinkingLevel.Low, label: i18nService.t('agentRuntimeThinkingLow') },
    {
      value: AgentRuntimeThinkingLevel.Medium,
      label: i18nService.t('agentRuntimeThinkingMedium'),
    },
    { value: AgentRuntimeThinkingLevel.High, label: i18nService.t('agentRuntimeThinkingHigh') },
    {
      value: AgentRuntimeThinkingLevel.XHigh,
      label: i18nService.t('agentRuntimeThinkingXHigh'),
    },
    {
      value: AgentRuntimeThinkingLevel.Adaptive,
      label: i18nService.t('agentRuntimeThinkingAdaptive'),
    },
    { value: AgentRuntimeThinkingLevel.Max, label: i18nService.t('agentRuntimeThinkingMax') },
    { value: AgentRuntimeThinkingLevel.Ultra, label: i18nService.t('agentRuntimeThinkingUltra') },
  ];
  const timeoutOptions = [
    { value: '900', label: i18nService.t('agentRuntimeTimeout15m') },
    { value: '1800', label: i18nService.t('agentRuntimeTimeout30m') },
    { value: '3600', label: i18nService.t('agentRuntimeTimeout1h') },
    { value: '7200', label: i18nService.t('agentRuntimeTimeout2h') },
    { value: '0', label: i18nService.t('agentRuntimeTimeoutUnlimited') },
    { value: 'custom', label: i18nService.t('agentRuntimeTimeoutCustom') },
  ];
  const usesCustomTimeout = !timeoutOptions
    .filter(option => option.value !== 'custom')
    .some(option => Number(option.value) === subagents.runTimeoutSeconds);
  const customTimeoutMinutes = Math.max(1, Math.round(subagents.runTimeoutSeconds / 60));

  if (isLoading) {
    return (
      <div
        className="overflow-hidden rounded-xl border border-border"
        aria-label={i18nService.t('agentRuntimeLoading')}
      >
        {[0, 1, 2, 3, 4].map(index => (
          <div
            key={index}
            className="h-16 animate-pulse border-t border-border bg-surface-raised first:border-t-0"
          />
        ))}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex min-h-[300px] flex-col items-center justify-center rounded-xl border border-border bg-surface px-8 text-center">
        <CpuChipIcon className="h-9 w-9 text-secondary" />
        <h4 className="mt-3 text-sm font-semibold text-foreground">
          {i18nService.t('agentRuntimeLoadFailed')}
        </h4>
        <p className="mt-1.5 max-w-md text-xs leading-5 text-secondary">{loadError}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-hover"
        >
          <ArrowPathIcon className="h-4 w-4" />
          {i18nService.t('agentRuntimeRetry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-1">
      <CollapsibleSection
        title={i18nService.t('agentRuntimeAgentSectionTitle')}
        description={i18nService.t('agentRuntimeAgentSectionDescription')}
        open={agentOpen}
        onToggle={() => setAgentOpen(value => !value)}
      >
        <SettingRow
          label={i18nService.t('agentRuntimeDelegationTitle')}
          description={i18nService.t('agentRuntimeDelegationDescription')}
        >
          <div className="grid grid-cols-2 rounded-lg bg-surface-raised p-1">
            {[
              [AgentRuntimeDelegationMode.Suggest, i18nService.t('agentRuntimeDelegationSuggest')],
              [AgentRuntimeDelegationMode.Prefer, i18nService.t('agentRuntimeDelegationPrefer')],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() =>
                  updateSubagents({
                    delegationMode: value as AgentRuntimeSettings['subagents']['delegationMode'],
                  })
                }
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${subagents.delegationMode === value ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-foreground'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeAskUserTimeoutTitle')}
          description={i18nService.t('agentRuntimeAskUserTimeoutDescription')}
        >
          <label className="ml-auto flex h-9 w-32 items-center overflow-hidden rounded-lg border border-border bg-surface-inset">
            <input
              id="agent-runtime-ask-user-timeout"
              type="number"
              min={AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.min}
              max={AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.max}
              step={1}
              value={settings.askUserQuestion.timeoutMinutes}
              onChange={event => {
                const minutes = Math.min(
                  AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.max,
                  Math.max(
                    AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.min,
                    Number(event.target.value) ||
                      AGENT_RUNTIME_LIMITS.askUserQuestionTimeoutMinutes.min,
                  ),
                );
                updateAskUserQuestion({ timeoutMinutes: Math.round(minutes) });
              }}
              className="h-full min-w-0 flex-1 bg-transparent px-2 text-right text-sm font-medium tabular-nums text-foreground outline-none"
              aria-label={i18nService.t('agentRuntimeAskUserTimeoutTitle')}
            />
            <span className="border-l border-border px-2 text-[11px] text-secondary">
              {i18nService.t('agentRuntimeMinutes')}
            </span>
          </label>
        </SettingRow>
      </CollapsibleSection>

      <CollapsibleSection
        title={i18nService.t('agentRuntimeSubagentSectionTitle')}
        description={i18nService.t('agentRuntimeSubagentSectionDescription')}
        open={subagentOpen}
        onToggle={() => setSubagentOpen(value => !value)}
      >
        <SettingRow
          label={i18nService.t('agentRuntimeDefaultModel')}
          description={
            selectedModelAvailable
              ? i18nService.t('agentRuntimeModelDescription')
              : i18nService.t('agentRuntimeUnavailableModelDescription')
          }
        >
          <ThemedSelect
            id="agent-runtime-model"
            value={subagents.model ?? ''}
            onChange={value => updateSubagents({ model: value || null })}
            options={displayedModelOptions}
            className="py-2 text-xs"
          />
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeDefaultThinking')}
          description={i18nService.t('agentRuntimeThinkingHint')}
        >
          <ThemedSelect
            id="agent-runtime-thinking"
            value={subagents.thinking ?? ''}
            onChange={value =>
              updateSubagents({
                thinking: (value || null) as AgentRuntimeSettings['subagents']['thinking'],
              })
            }
            options={thinkingOptions}
            className="py-2 text-xs"
          />
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeMaxConcurrent')}
          description={i18nService.t('agentRuntimeMaxConcurrentDescription')}
        >
          <NumberControl
            label={i18nService.t('agentRuntimeMaxConcurrent')}
            value={subagents.maxConcurrent}
            min={AGENT_RUNTIME_LIMITS.maxConcurrent.min}
            max={AGENT_RUNTIME_LIMITS.maxConcurrent.max}
            onChange={maxConcurrent => updateSubagents({ maxConcurrent })}
          />
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeMaxChildren')}
          description={i18nService.t('agentRuntimeMaxChildrenDescription')}
        >
          <NumberControl
            label={i18nService.t('agentRuntimeMaxChildren')}
            value={subagents.maxChildrenPerAgent}
            min={AGENT_RUNTIME_LIMITS.maxChildrenPerAgent.min}
            max={AGENT_RUNTIME_LIMITS.maxChildrenPerAgent.max}
            onChange={maxChildrenPerAgent => updateSubagents({ maxChildrenPerAgent })}
          />
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeTimeoutTitle')}
          description={i18nService.t('agentRuntimeTimeoutDescription')}
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ThemedSelect
                id="agent-runtime-timeout"
                value={usesCustomTimeout ? 'custom' : String(subagents.runTimeoutSeconds)}
                onChange={value =>
                  updateSubagents({
                    runTimeoutSeconds: value === 'custom' ? 90 * 60 : Number(value),
                  })
                }
                options={timeoutOptions}
                className="py-2 text-xs"
              />
            </div>
            {usesCustomTimeout && (
              <label className="flex h-9 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-surface-inset">
                <input
                  type="number"
                  min={AGENT_RUNTIME_LIMITS.runTimeoutSeconds.min / 60}
                  max={AGENT_RUNTIME_LIMITS.runTimeoutSeconds.max / 60}
                  value={customTimeoutMinutes}
                  onChange={event => {
                    const minutes = Math.min(
                      AGENT_RUNTIME_LIMITS.runTimeoutSeconds.max / 60,
                      Math.max(
                        AGENT_RUNTIME_LIMITS.runTimeoutSeconds.min / 60,
                        Number(event.target.value) || 1,
                      ),
                    );
                    updateSubagents({ runTimeoutSeconds: Math.round(minutes * 60) });
                  }}
                  className="h-full w-16 bg-transparent px-2 text-right text-xs tabular-nums text-foreground outline-none"
                  aria-label={i18nService.t('agentRuntimeTimeoutCustomMinutes')}
                />
                <span className="border-l border-border px-2 text-[11px] text-secondary">
                  {i18nService.t('agentRuntimeMinutes')}
                </span>
              </label>
            )}
          </div>
        </SettingRow>
        <SettingRow
          label={i18nService.t('agentRuntimeNestingTitle')}
          description={i18nService.t('agentRuntimeNestingDescription')}
        >
          <div className="grid grid-cols-2 rounded-lg bg-surface-raised p-1">
            {[1, 2].map(depth => (
              <button
                key={depth}
                type="button"
                onClick={() => updateSubagents({ maxSpawnDepth: depth })}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${subagents.maxSpawnDepth === depth ? 'bg-surface text-primary shadow-sm' : 'text-secondary hover:text-foreground'}`}
              >
                {i18nService.t(
                  depth === 1 ? 'agentRuntimeNestingOff' : 'agentRuntimeNestingWorker',
                )}
              </button>
            ))}
          </div>
          {subagents.maxSpawnDepth === 2 && (
            <p className="mt-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
              {i18nService.t('agentRuntimeNestingWarning')}
            </p>
          )}
        </SettingRow>
      </CollapsibleSection>
    </div>
  );
};

export default AgentRuntimeSettingsTab;
