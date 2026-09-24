import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CpuChipIcon,
  ShieldCheckIcon,
  SignalIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  EXTERNAL_AGENT_CATALOG,
  EXTERNAL_AGENT_OPERATION_TIMEOUT_OPTIONS,
  type ExternalAgentId,
  type ExternalAgentSettings,
} from '@shared/openclaw/externalAgents';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

import ExternalAgentBrandIcon from './ExternalAgentBrandIcon';

type Props = {
  settings: ExternalAgentSettings;
  onChange: (settings: ExternalAgentSettings) => void;
  isLoading: boolean;
  loadError: string | null;
  onRetry: () => void;
};

type AgentTestState = {
  status: 'success' | 'error';
  detail?: string;
};

type TestAllProgress = {
  current: number;
  total: number;
};

const AGENT_ICON_STYLES: Record<ExternalAgentId, string> = {
  claude: 'border-[#D97757]/20 bg-[#D97757]/10 text-[#C15F3C]',
  codex: 'border-foreground/10 bg-foreground/[0.055] text-foreground',
  opencode: 'border-[#211E1E] bg-[#211E1E] text-white',
  'deepseek-harness': 'border-[#4D6BFE]/20 bg-[#4D6BFE]/10 text-[#4D6BFE]',
  hermes: 'border-[#C99B2E]/20 bg-[#C99B2E]/10 text-[#9B7216]',
};

const SettingRow: React.FC<{
  label: string;
  description: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(210px,240px)] sm:items-center sm:gap-5">
    <div className="min-w-0">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <p className="mt-0.5 text-xs leading-5 text-secondary">{description}</p>
    </div>
    <div className="min-w-0">{children}</div>
  </div>
);

const ToolAccessToggle: React.FC<{
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}> = ({ checked, label, description, onChange }) => (
  <label className="group flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-surface px-3.5 py-3 transition-all hover:-translate-y-px hover:border-primary/25 hover:shadow-sm">
    <span className="min-w-0 flex-1">
      <span className="block text-xs font-semibold text-foreground transition-colors group-hover:text-primary">
        {label}
      </span>
      <span className="mt-0.5 block text-[11px] leading-4 text-secondary">{description}</span>
    </span>
    <span className="relative mt-0.5 inline-flex shrink-0 items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="peer sr-only"
        aria-label={label}
      />
      <span className="h-5 w-9 rounded-full bg-border-input transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/30" />
    </span>
  </label>
);

const ExternalAgentsSettingsSection: React.FC<Props> = ({
  settings,
  onChange,
  isLoading,
  loadError,
  onRetry,
}) => {
  const testBusyRef = useRef(false);
  const [testingAgentId, setTestingAgentId] = useState<ExternalAgentId | null>(null);
  const [testingStartedAt, setTestingStartedAt] = useState<number | null>(null);
  const [testingElapsedSeconds, setTestingElapsedSeconds] = useState(0);
  const [testAllProgress, setTestAllProgress] = useState<TestAllProgress | null>(null);
  const [testStates, setTestStates] = useState<Partial<Record<ExternalAgentId, AgentTestState>>>(
    {},
  );
  const [expandedErrors, setExpandedErrors] = useState<Partial<Record<ExternalAgentId, boolean>>>(
    {},
  );

  useEffect(() => {
    if (testingStartedAt === null) {
      setTestingElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setTestingElapsedSeconds(Math.floor((Date.now() - testingStartedAt) / 1_000));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [testingStartedAt]);

  const updateAgent = (id: ExternalAgentId, enabled: boolean) => {
    onChange({
      ...settings,
      agents: {
        ...settings.agents,
        [id]: { enabled },
      },
    });
  };

  const performAgentTest = async (id: ExternalAgentId) => {
    setTestingAgentId(id);
    setTestingStartedAt(Date.now());
    setTestStates(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setExpandedErrors(current => ({ ...current, [id]: false }));

    try {
      const result = await window.electron.openclaw.externalAgents.test(id);
      const runtimeDetail = result.success
        ? Array.from(
            new Set(
              [
                result.code ? `[${result.code}]` : undefined,
                result.message,
                ...(result.details ?? []),
              ].filter((detail): detail is string => Boolean(detail)),
            ),
          ).join('\n')
        : result.error;
      setTestStates(current => ({
        ...current,
        [id]: {
          status: result.success && result.ready ? 'success' : 'error',
          detail: runtimeDetail,
        },
      }));
    } catch (error) {
      setTestStates(current => ({
        ...current,
        [id]: {
          status: 'error',
          detail: error instanceof Error ? error.message : undefined,
        },
      }));
    } finally {
      setTestingStartedAt(null);
      setTestingAgentId(null);
    }
  };

  const testAgent = async (id: ExternalAgentId) => {
    if (testBusyRef.current) return;
    testBusyRef.current = true;
    try {
      await performAgentTest(id);
    } finally {
      testBusyRef.current = false;
    }
  };

  const testAllAgents = async () => {
    if (testBusyRef.current) return;
    testBusyRef.current = true;
    setTestStates({});
    setExpandedErrors({});

    try {
      for (const [index, definition] of EXTERNAL_AGENT_CATALOG.entries()) {
        setTestAllProgress({ current: index + 1, total: EXTERNAL_AGENT_CATALOG.length });
        await performAgentTest(definition.id);
      }
    } finally {
      setTestAllProgress(null);
      testBusyRef.current = false;
    }
  };

  const isTesting = testingAgentId !== null || testAllProgress !== null;

  if (isLoading) {
    return (
      <div className="space-y-4" aria-label={i18nService.t('loading')}>
        <div className="h-24 animate-pulse rounded-2xl border border-border/60 bg-surface-raised/60" />
        <div className="h-72 animate-pulse rounded-2xl border border-border/60 bg-surface-raised/60" />
      </div>
    );
  }

  if (loadError) {
    return (
      <section className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-8 text-center shadow-sm">
        <p className="text-xs text-secondary">{loadError}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-hover"
        >
          <ArrowPathIcon className="h-4 w-4" />
          {i18nService.t('agentRuntimeRetry')}
        </button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm">
        <div className="flex items-start gap-3 border-b border-border/70 bg-surface-raised/50 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.09] text-primary ring-1 ring-primary/10">
              <ShieldCheckIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {i18nService.t('externalAgentsRuntimeSettingsTitle')}
              </div>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('externalAgentsRuntimeSettingsDescription')}
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
          <div className="overflow-hidden rounded-xl border border-border/60 bg-surface-raised/20">
            <div className="divide-y divide-border/60">
              <SettingRow
                label={i18nService.t('externalAgentsPermissionMode')}
                description={i18nService.t('externalAgentsPermissionModeDescription')}
              >
                <ThemedSelect
                  id="external-agent-permission-mode"
                  value={settings.permissionMode}
                  onChange={value => {
                    if (
                      value === 'full-access' &&
                      settings.permissionMode !== 'full-access' &&
                      !window.confirm(i18nService.t('externalAgentsFullAccessConfirm'))
                    ) {
                      return;
                    }
                    onChange({
                      ...settings,
                      permissionMode: value as ExternalAgentSettings['permissionMode'],
                    });
                  }}
                  options={[
                    {
                      value: 'deny-all',
                      label: i18nService.t('externalAgentsPermissionDenyAll'),
                    },
                    {
                      value: 'read-only',
                      label: i18nService.t('externalAgentsPermissionReadOnly'),
                    },
                    {
                      value: 'full-access',
                      label: i18nService.t('externalAgentsPermissionFullAccess'),
                    },
                  ]}
                />
              </SettingRow>
              <SettingRow
                label={i18nService.t('externalAgentsReadOnlyViolationBehavior')}
                description={i18nService.t('externalAgentsReadOnlyViolationBehaviorDescription')}
              >
                <ThemedSelect
                  id="external-agent-read-only-violation-behavior"
                  value={settings.readOnlyViolationBehavior}
                  onChange={value =>
                    onChange({
                      ...settings,
                      readOnlyViolationBehavior:
                        value as ExternalAgentSettings['readOnlyViolationBehavior'],
                    })
                  }
                  options={[
                    {
                      value: 'continue',
                      label: i18nService.t('externalAgentsReadOnlyViolationContinue'),
                    },
                    {
                      value: 'fail-task',
                      label: i18nService.t('externalAgentsReadOnlyViolationFailTask'),
                    },
                  ]}
                />
              </SettingRow>
              <SettingRow
                label={i18nService.t('externalAgentsOperationTimeout')}
                description={i18nService.t('externalAgentsOperationTimeoutDescription')}
              >
                <ThemedSelect
                  id="external-agent-operation-timeout"
                  value={String(settings.operationTimeoutSeconds)}
                  onChange={value =>
                    onChange({
                      ...settings,
                      operationTimeoutSeconds: Number(
                        value,
                      ) as ExternalAgentSettings['operationTimeoutSeconds'],
                    })
                  }
                  options={EXTERNAL_AGENT_OPERATION_TIMEOUT_OPTIONS.map(seconds => ({
                    value: String(seconds),
                    label: `${seconds} ${i18nService.t('externalAgentsSecondsLabel')}`,
                  }))}
                />
              </SettingRow>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-surface-raised/20 p-4">
            <div className="mb-3">
              <div className="text-sm font-semibold text-foreground">
                {i18nService.t('externalAgentsToolAccess')}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-secondary">
                {i18nService.t('externalAgentsToolAccessDescription')}
              </p>
            </div>
            <div className="space-y-2">
              <ToolAccessToggle
                checked={settings.pluginToolsMcpBridge}
                label={i18nService.t('externalAgentsPluginToolsBridge')}
                description={i18nService.t('externalAgentsPluginToolsBridgeDescription')}
                onChange={pluginToolsMcpBridge => onChange({ ...settings, pluginToolsMcpBridge })}
              />
              <ToolAccessToggle
                checked={settings.openClawToolsMcpBridge}
                label={i18nService.t('externalAgentsOpenClawToolsBridge')}
                description={i18nService.t('externalAgentsOpenClawToolsBridgeDescription')}
                onChange={openClawToolsMcpBridge =>
                  onChange({ ...settings, openClawToolsMcpBridge })
                }
              />
              <ToolAccessToggle
                checked={settings.shareConfiguredMcpServers}
                label={i18nService.t('externalAgentsConfiguredMcpServers')}
                description={i18nService.t('externalAgentsConfiguredMcpServersDescription')}
                onChange={shareConfiguredMcpServers =>
                  onChange({ ...settings, shareConfiguredMcpServers })
                }
              />
            </div>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border/70 bg-surface-raised/50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/[0.09] text-primary ring-1 ring-primary/10">
              <CpuChipIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {i18nService.t('externalAgentsSectionTitle')}
              </div>
              <div className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('externalAgentsSectionDescription')}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void testAllAgents()}
            disabled={isTesting}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.07] px-3.5 text-xs font-semibold text-primary transition-all hover:border-primary/40 hover:bg-primary/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testAllProgress ? (
              <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <SignalIcon className="h-4 w-4" aria-hidden="true" />
            )}
            {testAllProgress
              ? `${i18nService.t('externalAgentsTesting')} ${testAllProgress.current}/${testAllProgress.total}`
              : i18nService.t('externalAgentsTestAll')}
          </button>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {EXTERNAL_AGENT_CATALOG.map(definition => {
            const enabled = settings.agents[definition.id].enabled;
            const testState = testStates[definition.id];
            const isCurrentTest = testingAgentId === definition.id;
            const testSucceeded = !isCurrentTest && testState?.status === 'success';
            const errorExpanded = Boolean(expandedErrors[definition.id]);

            return (
              <article
                key={definition.id}
                className={`relative flex flex-col overflow-hidden rounded-xl border p-3.5 transition-all ${
                  isCurrentTest
                    ? 'border-primary/35 bg-primary/[0.035] shadow-sm'
                    : enabled
                      ? 'border-primary/20 bg-primary/[0.018] hover:border-primary/35 hover:shadow-sm'
                      : 'border-border/65 bg-surface-raised/20 hover:-translate-y-px hover:border-border-input hover:shadow-sm'
                }`}
              >
                {isCurrentTest ? (
                  <span
                    className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10"
                    aria-hidden="true"
                  >
                    <span className="block h-full w-1/2 animate-shimmer bg-gradient-to-r from-transparent via-primary to-transparent" />
                  </span>
                ) : null}

                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-sm ${AGENT_ICON_STYLES[definition.id]}`}
                  >
                    <ExternalAgentBrandIcon agentId={definition.id} className="h-6 w-6" />
                  </span>
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                    {definition.name}
                  </h3>
                  <div className="flex w-[92px] shrink-0 flex-col gap-1 rounded-xl border border-border/60 bg-surface-raised/55 p-1 shadow-inner">
                    <button
                      type="button"
                      onClick={() => void testAgent(definition.id)}
                      disabled={isTesting}
                      className={`inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-lg text-[11px] font-semibold shadow-sm ring-1 ring-inset transition-all focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45 ${
                        testSucceeded
                          ? 'bg-success/10 text-success ring-success/20 hover:bg-success/15 focus-visible:ring-success/25'
                          : 'bg-surface text-primary ring-border/60 hover:bg-primary/[0.07] hover:ring-primary/25 focus-visible:ring-primary/25'
                      }`}
                      aria-label={`${i18nService.t('externalAgentsTest')} ${definition.name}`}
                    >
                      {isCurrentTest ? (
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current/25 border-t-current" />
                      ) : testSucceeded ? (
                        <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <SignalIcon className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {i18nService.t(
                        isCurrentTest
                          ? 'externalAgentsTesting'
                          : testSucceeded
                            ? 'externalAgentsTestPassed'
                            : 'externalAgentsTest',
                      )}
                    </button>
                    <label className="group relative inline-flex h-7 w-full cursor-pointer items-center justify-between rounded-lg px-1.5 transition-colors hover:bg-surface/80">
                      <span className="text-[10px] font-medium text-secondary transition-colors group-hover:text-foreground">
                        {i18nService.t(
                          enabled ? 'externalAgentsEnabledState' : 'externalAgentsDisabledState',
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={event => updateAgent(definition.id, event.target.checked)}
                        className="peer sr-only"
                        aria-label={`${definition.name} ${i18nService.t('enabled')}`}
                      />
                      <span className="relative h-4 w-7 rounded-full bg-border-input shadow-inner transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-3 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/30" />
                    </label>
                  </div>
                </div>

                {isCurrentTest || testState?.status === 'error' ? (
                  <div className="mt-3">
                    {isCurrentTest ? (
                      <div
                        className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/[0.055] px-3 py-2 text-xs text-primary"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">
                            {i18nService.t('externalAgentsTestingDescription')}
                          </span>
                          <span className="ml-1.5 tabular-nums text-secondary">
                            · {testingElapsedSeconds}
                            {i18nService.t('externalAgentsSeconds')}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-primary" />
                        </span>
                      </div>
                    ) : testState?.status === 'error' ? (
                      <div
                        className="rounded-lg border border-danger/20 bg-danger/[0.045] px-3 py-2"
                        role="status"
                        aria-live="polite"
                      >
                        <div className="flex items-center gap-2">
                          <XCircleIcon className="h-4 w-4 shrink-0 text-danger" />
                          <span className="min-w-0 flex-1 text-xs font-medium text-danger">
                            {i18nService.t('externalAgentsTestFailed')}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedErrors(current => ({
                                ...current,
                                [definition.id]: !current[definition.id],
                              }))
                            }
                            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-secondary transition-colors hover:bg-danger/[0.08] hover:text-danger"
                            aria-expanded={errorExpanded}
                          >
                            {i18nService.t(
                              errorExpanded
                                ? 'externalAgentsHideErrorDetails'
                                : 'externalAgentsShowErrorDetails',
                            )}
                            <ChevronDownIcon
                              className={`h-3 w-3 transition-transform ${
                                errorExpanded ? 'rotate-180' : ''
                              }`}
                            />
                          </button>
                        </div>
                        {errorExpanded ? (
                          <div className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words border-t border-danger/15 pt-2 font-mono text-[11px] leading-5 text-secondary">
                            {testState.detail || i18nService.t('externalAgentsNoErrorDetails')}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
};

export default ExternalAgentsSettingsSection;
