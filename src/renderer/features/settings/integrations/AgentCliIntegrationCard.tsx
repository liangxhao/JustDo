import {
  ArrowPathIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  CommandLineIcon,
} from '@heroicons/react/24/outline';
import type { AgentCliIntegrationStatus } from '@shared/integrations/agentCliIntegration';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface Props {
  onCommandChange?: (command: string) => void;
}

const AgentCliIntegrationCard: React.FC<Props> = ({ onCommandChange }) => {
  const titleId = useId();
  const [status, setStatus] = useState<AgentCliIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const copyRevision = useRef(0);
  const copyTimer = useRef<number>();

  useEffect(() => {
    onCommandChange?.(status?.command ?? '');
  }, [onCommandChange, status?.command]);

  const resetCopyFeedback = useCallback(() => {
    copyRevision.current += 1;
    setCopied(false);
    window.clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    resetCopyFeedback();
    return () => {
      copyRevision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [resetCopyFeedback, status?.command]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    resetCopyFeedback();
    setBusy(true);
    try {
      const next = await window.electron.agentCli.getStatus();
      if (generation.current === current) {
        setStatus(next);
        setError('');
      }
    } catch {
      if (generation.current === current) setError(i18nService.t('agentCliStatusFailed'));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [resetCopyFeedback]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const copy = async () => {
    if (!status?.command) return;
    const current = ++copyRevision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(status.command);
      if (copyRevision.current !== current) return;
      setCopied(true);
      setError('');
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (copyRevision.current !== current) return;
      setError(i18nService.t('agentCliCopyFailed'));
    }
  };

  const ready = status?.supported && status.launcherReady && status.bridgeRunning;
  const statusKey = !status
    ? busy
      ? 'agentCliLoading'
      : 'agentCliNotReady'
    : !status.supported
      ? 'agentCliUnsupported'
      : ready
        ? 'agentCliReady'
        : 'agentCliNotReady';
  const statusTone = !status && busy
    ? 'border-border bg-surface-raised text-secondary'
    : ready
      ? 'border-success/20 bg-success/10 text-success'
      : 'border-warning/20 bg-warning/10 text-warning';

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CommandLineIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h4 id={titleId} className="text-base font-semibold text-foreground">
              {i18nService.t('agentCliTitle')}
            </h4>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">
              {i18nService.t('agentCliDescription')}
            </p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span
            role="status"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${statusTone}`}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
            {i18nService.t(statusKey)}
          </span>
          {status && (
            <span className="text-secondary">
              {i18nService
                .t('agentCliActiveTasks')
                .replace('{count}', String(status.activeTaskCount))}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {i18nService.t('agentCliRefresh')}
        </button>
      </div>
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface-raised/40">
        <div className="space-y-2.5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-secondary">{i18nService.t('agentCliCommand')}</p>
            <button
              type="button"
              disabled={!status?.command}
              onClick={() => void copy()}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              {copied ? (
                <CheckIcon className="h-3.5 w-3.5 text-success" />
              ) : (
                <ClipboardDocumentIcon className="h-3.5 w-3.5" />
              )}
              {i18nService.t(
                copied ? 'agentCliCommandCopied' : 'agentCliCopyCommand',
              )}
            </button>
          </div>
          <code className="block min-w-0 select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
            {status?.command || '—'}
          </code>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-secondary">
          <span>{i18nService.t('agentCliCommonCommands')}</span>
          {['--help', 'status', 'models list', 'exec'].map(command => (
            <code
              key={command}
              className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            >
              {command}
            </code>
          ))}
        </div>
        <p className="text-xs leading-5 text-secondary">
          {i18nService.t('agentCliBackgroundHint')}
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/15 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger"
        >
          {error}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? i18nService.t('agentCliCommandCopied') : ''}
      </span>
    </section>
  );
};

export default AgentCliIntegrationCard;
