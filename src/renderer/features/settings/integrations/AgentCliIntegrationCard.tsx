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

const CopyTarget = { Path: 'path', Acp: 'acp' } as const;
type CopyTarget = (typeof CopyTarget)[keyof typeof CopyTarget];

const AgentCliIntegrationCard: React.FC<Props> = ({ onCommandChange }) => {
  const titleId = useId();
  const [status, setStatus] = useState<AgentCliIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const generation = useRef(0);
  const copyRevision = useRef(0);
  const copyTimer = useRef<number>();

  useEffect(() => {
    onCommandChange?.(status?.command ?? '');
  }, [onCommandChange, status?.command]);

  const resetCopyFeedback = useCallback(() => {
    copyRevision.current += 1;
    setCopied(null);
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

  const copy = async (target: CopyTarget) => {
    if (!status?.command) return;
    const current = ++copyRevision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(null);
    try {
      const value = target === CopyTarget.Path
        ? status.command
        : JSON.stringify({ command: status.command, args: ['acp'] }, null, 2);
      await navigator.clipboard.writeText(value);
      if (copyRevision.current !== current) return;
      setCopied(target);
      setError('');
      copyTimer.current = window.setTimeout(() => setCopied(null), 1800);
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
      className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-surface p-4 sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <CommandLineIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h4 id={titleId} className="text-sm font-semibold text-foreground">
              {i18nService.t('agentCliTitle')}
            </h4>
            <p className="mt-0.5 text-xs leading-5 text-secondary">
              {i18nService.t('agentCliDescription')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <span
            role="status"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium ${statusTone}`}
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
          <button
            type="button"
            disabled={busy}
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            {i18nService.t('agentCliRefresh')}
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-raised/60 px-3 py-2.5">
        <span className="text-xs font-medium text-secondary">{i18nService.t('agentCliCommand')}</span>
        <code className="min-w-0 flex-1 basis-48 select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
          {status?.command || '—'}
        </code>
        <button
          type="button"
          disabled={!status?.command}
          onClick={() => void copy(CopyTarget.Path)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          {copied === CopyTarget.Path ? (
            <CheckIcon className="h-3.5 w-3.5 text-success" />
          ) : (
            <ClipboardDocumentIcon className="h-3.5 w-3.5" />
          )}
          {i18nService.t(copied === CopyTarget.Path ? 'agentCliCommandCopied' : 'agentCliCopyCommand')}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-secondary">
          <span>{i18nService.t('agentCliCommonCommands')}</span>
          {['--help', 'status', 'models list', 'exec', 'acp'].map(command => (
            <code
              key={command}
              className="rounded-md bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            >
              {command}
            </code>
          ))}
          <button
            type="button"
            disabled={!status?.command}
            onClick={() => void copy(CopyTarget.Acp)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            {copied === CopyTarget.Acp ? (
              <CheckIcon className="h-3.5 w-3.5" />
            ) : (
              <ClipboardDocumentIcon className="h-3.5 w-3.5" />
            )}
            {i18nService.t(copied === CopyTarget.Acp ? 'agentCliCopied' : 'agentCliCopyConfig')}
          </button>
        </div>
        <p className="text-[11px] leading-5 text-secondary">
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
        {copied ? i18nService.t(copied === CopyTarget.Path ? 'agentCliCommandCopied' : 'agentCliCopied') : ''}
      </span>
    </section>
  );
};

export default AgentCliIntegrationCard;
