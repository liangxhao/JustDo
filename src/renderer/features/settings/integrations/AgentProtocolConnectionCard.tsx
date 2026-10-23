import { CheckIcon, ClipboardDocumentIcon, LinkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface Props {
  command: string;
  children?: React.ReactNode;
  webSocket: React.ReactNode;
}

const APP_SERVER_ARGUMENTS = ['app-server', '--listen', 'stdio://'];

const AgentProtocolConnectionCard: React.FC<Props> = ({ command, children, webSocket }) => {
  const titleId = useId();
  const stdioTitleId = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const copyTimer = useRef<number>();

  useEffect(() => {
    revision.current += 1;
    setCopied(false);
    setError('');
    window.clearTimeout(copyTimer.current);
    return () => {
      revision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [command]);

  const copy = async () => {
    if (!command) return;
    const current = ++revision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(JSON.stringify({ command, args: APP_SERVER_ARGUMENTS }, null, 2));
      if (revision.current !== current) return;
      setCopied(true);
      setError('');
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (revision.current !== current) return;
      setError(i18nService.t('agentCliCopyFailed'));
    }
  };

  const heading = (
    <div className="flex min-w-0 items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <LinkIcon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h4 id={titleId} className="text-sm font-semibold text-foreground">
          {i18nService.t('agentProtocolCodexTitle')}
        </h4>
        <p className="mt-1 text-xs leading-5 text-secondary">
          {i18nService.t('agentProtocolCodexDescription')}
        </p>
      </div>
    </div>
  );
  const launchArguments = (
    <div className="min-w-0 space-y-1.5 rounded-lg bg-surface-raised/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-secondary">
        {i18nService.t('agentProtocolArguments')}
      </p>
      <code className="block min-w-0 select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
        {APP_SERVER_ARGUMENTS.join(' ')}
      </code>
    </div>
  );
  const copyAction = (
    <button
      type="button"
      disabled={!command}
      onClick={() => void copy()}
      className="inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" />}
      {i18nService.t(copied ? 'agentProtocolCodexCopied' : 'agentProtocolCodexCopyConfig')}
    </button>
  );
  const feedback = (
    <>
      {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}
      <span className="sr-only" aria-live="polite">
        {copied ? i18nService.t('agentProtocolCodexCopied') : ''}
      </span>
    </>
  );

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-xl border border-border/70 bg-surface p-4 sm:p-5"
    >
      {heading}
      <div className="grid min-w-0 items-stretch gap-4 lg:grid-cols-2">
        <section
          aria-labelledby={stdioTitleId}
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 p-4"
        >
          <div className="space-y-1.5">
            <h5 id={stdioTitleId} className="text-sm font-semibold text-foreground">
              {i18nService.t('agentProtocolStdioTitle')}
            </h5>
            <p className="text-xs leading-5 text-secondary">
              {i18nService.t('agentProtocolStdioDescription')}
            </p>
          </div>
          {launchArguments}
          {copyAction}
          {feedback}
          {children && <div className="mt-auto border-t border-border/60 pt-3">{children}</div>}
        </section>
        {webSocket}
      </div>
    </section>
  );
};

export default AgentProtocolConnectionCard;
