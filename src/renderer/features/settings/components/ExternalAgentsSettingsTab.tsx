import {
  ArrowPathIcon,
  CheckCircleIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import {
  EXTERNAL_AGENT_IDS,
  type ExternalAgentDiagnostic,
  type ExternalAgentDiagnosticCode,
  type ExternalAgentId,
} from '@shared/openclaw/externalAgents';
import React, { useCallback, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

const AGENT_COPY: Record<ExternalAgentId, { nameKey: string; descriptionKey: string }> = {
  claude: {
    nameKey: 'externalAgentClaudeName',
    descriptionKey: 'externalAgentClaudeDescription',
  },
  codex: {
    nameKey: 'externalAgentCodexName',
    descriptionKey: 'externalAgentCodexDescription',
  },
  opencode: {
    nameKey: 'externalAgentOpenCodeName',
    descriptionKey: 'externalAgentOpenCodeDescription',
  },
};

const CODE_MESSAGE_KEYS: Record<ExternalAgentDiagnosticCode, string> = {
  ok: 'externalAgentConnected',
  'backend-missing': 'externalAgentBackendMissing',
  'adapter-missing': 'externalAgentAdapterMissing',
  'authentication-required': 'externalAgentAuthenticationRequired',
  timeout: 'externalAgentTimeout',
  'connection-failed': 'externalAgentConnectionFailed',
};

const actionButtonClassName =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-border/70 bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-40';

const getStatusPresentation = (diagnostic: ExternalAgentDiagnostic) => {
  switch (diagnostic.state) {
    case 'connected':
      return {
        label: i18nService.t('externalAgentConnected'),
        className: 'bg-success/10 text-success',
        icon: <CheckCircleIcon className="h-4 w-4" />,
      };
    case 'failed':
      return {
        label: i18nService.t('externalAgentFailed'),
        className: 'bg-danger/10 text-danger',
        icon: <XCircleIcon className="h-4 w-4" />,
      };
    case 'unavailable':
      return {
        label: i18nService.t('externalAgentUnavailable'),
        className: 'bg-warning/10 text-warning',
        icon: <ExclamationTriangleIcon className="h-4 w-4" />,
      };
    default:
      return {
        label: i18nService.t('externalAgentNotTested'),
        className: 'bg-surface-raised text-muted',
        icon: <CommandLineIcon className="h-4 w-4" />,
      };
  }
};

const ExternalAgentsSettingsTab: React.FC = () => {
  const [diagnostics, setDiagnostics] = useState<ExternalAgentDiagnostic[]>([]);
  const [backendAvailable, setBackendAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<Set<ExternalAgentId>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron.openclaw.externalAgents.list();
      if (!result.success) throw new Error(i18nService.t('externalAgentsLoadFailed'));
      setBackendAvailable(result.backendAvailable);
      setDiagnostics(result.agents);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : i18nService.t('externalAgentsLoadFailed'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const testAgent = useCallback(async (agentId: ExternalAgentId) => {
    setTesting(current => new Set(current).add(agentId));
    setError(null);
    try {
      const result = await window.electron.openclaw.externalAgents.test(agentId);
      if (!result.diagnostic) {
        throw new Error(i18nService.t('externalAgentConnectionFailed'));
      }
      setDiagnostics(current =>
        current.map(item => (item.id === agentId ? result.diagnostic! : item)),
      );
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : i18nService.t('externalAgentConnectionFailed'),
      );
    } finally {
      setTesting(current => {
        const next = new Set(current);
        next.delete(agentId);
        return next;
      });
    }
  }, []);

  const testAll = async () => {
    for (const agentId of EXTERNAL_AGENT_IDS) {
      const diagnostic = diagnostics.find(item => item.id === agentId);
      if (diagnostic?.adapterAvailable) await testAgent(agentId);
    }
  };

  const testingAll = testing.size > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {i18nService.t('externalAgentsTitle')}
          </h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">
            {i18nService.t('externalAgentsDescription')}
          </p>
        </div>
        <button
          type="button"
          className={actionButtonClassName}
          disabled={loading || testingAll || !backendAvailable}
          onClick={() => void testAll()}
        >
          <ArrowPathIcon className={`h-4 w-4 ${testingAll ? 'animate-spin' : ''}`} />
          {testingAll
            ? i18nService.t('externalAgentTesting')
            : i18nService.t('externalAgentTestAll')}
        </button>
      </div>

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          backendAvailable
            ? 'border-success/20 bg-success/5 text-secondary'
            : 'border-warning/30 bg-warning/5 text-secondary'
        }`}
      >
        {loading
          ? i18nService.t('externalAgentsInspecting')
          : backendAvailable
            ? i18nService.t('externalAgentsBackendReady')
            : i18nService.t('externalAgentsBackendUnavailable')}
      </div>

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {diagnostics.map(diagnostic => {
          const copy = AGENT_COPY[diagnostic.id];
          const status = getStatusPresentation(diagnostic);
          const isTesting = testing.has(diagnostic.id);
          const codeMessage = diagnostic.code
            ? i18nService.t(CODE_MESSAGE_KEYS[diagnostic.code])
            : null;
          return (
            <section key={diagnostic.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-foreground">
                      {i18nService.t(copy.nameKey)}
                    </h4>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${status.className}`}
                    >
                      {status.icon}
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] leading-5 text-secondary">
                    {i18nService.t(copy.descriptionKey)}
                  </p>
                  {codeMessage && diagnostic.state !== 'connected' ? (
                    <p className="mt-2 text-xs text-secondary">{codeMessage}</p>
                  ) : null}
                  {diagnostic.detail ? (
                    <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-surface-raised px-3 py-2 text-[11px] leading-4 text-muted">
                      {diagnostic.detail}
                    </pre>
                  ) : null}
                  {diagnostic.testedAt ? (
                    <p className="mt-2 text-[11px] text-muted">
                      {i18nService.t('externalAgentLastTested')}{' '}
                      {new Date(diagnostic.testedAt).toLocaleString()}
                      {typeof diagnostic.durationMs === 'number'
                        ? ` · ${(diagnostic.durationMs / 1000).toFixed(1)}s`
                        : ''}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={actionButtonClassName}
                  disabled={loading || testingAll || !diagnostic.adapterAvailable}
                  onClick={() => void testAgent(diagnostic.id)}
                >
                  <ArrowPathIcon className={`h-4 w-4 ${isTesting ? 'animate-spin' : ''}`} />
                  {isTesting
                    ? i18nService.t('externalAgentTesting')
                    : i18nService.t('externalAgentTest')}
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-surface-raised/40 px-4 py-3 text-xs leading-5 text-muted">
        <p>{i18nService.t('externalAgentTestNotice')}</p>
        <p className="mt-1">{i18nService.t('externalAgentPermissionNotice')}</p>
      </div>
    </div>
  );
};

export default ExternalAgentsSettingsTab;
