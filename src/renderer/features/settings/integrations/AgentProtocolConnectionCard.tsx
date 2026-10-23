import { CheckIcon, ClipboardDocumentIcon, LinkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export const AgentConnectionProtocol = {
  Acp: 'acp',
  CodexAppServer: 'codex-app-server',
} as const;
export type AgentConnectionProtocol =
  (typeof AgentConnectionProtocol)[keyof typeof AgentConnectionProtocol];

interface Props {
  protocol: AgentConnectionProtocol;
  command: string;
  children?: React.ReactNode;
}

const protocolDetails = {
  [AgentConnectionProtocol.Acp]: {
    title: 'agentProtocolAcpTitle',
    description: 'agentProtocolAcpDescription',
    args: ['acp'],
    copy: 'agentCliCopyConfig',
    copied: 'agentCliCopied',
  },
  [AgentConnectionProtocol.CodexAppServer]: {
    title: 'agentProtocolCodexTitle',
    description: 'agentProtocolCodexDescription',
    args: ['app-server', '--listen', 'stdio://'],
    copy: 'agentProtocolCodexCopyConfig',
    copied: 'agentProtocolCodexCopied',
  },
} as const;

const AgentProtocolConnectionCard: React.FC<Props> = ({ protocol, command, children }) => {
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const copyTimer = useRef<number>();
  const details = protocolDetails[protocol];

  useEffect(() => {
    revision.current += 1;
    setCopied(false);
    setError('');
    window.clearTimeout(copyTimer.current);
    return () => {
      revision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [command, protocol]);

  const copy = async () => {
    if (!command) return;
    const current = ++revision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(JSON.stringify({ command, args: details.args }, null, 2));
      if (revision.current !== current) return;
      setCopied(true);
      setError('');
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (revision.current !== current) return;
      setError(i18nService.t('agentCliCopyFailed'));
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-card sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LinkIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h4 id={titleId} className="text-base font-semibold text-foreground">
            {i18nService.t(details.title)}
          </h4>
          <p className="mt-1 text-sm leading-6 text-secondary">
            {i18nService.t(details.description)}
          </p>
        </div>
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-surface-raised/40 p-4">
        <p className="text-xs font-medium text-secondary">
          {i18nService.t('agentProtocolArguments')}
        </p>
        <code className="block select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
          {details.args.join(' ')}
        </code>
      </div>
      <button
        type="button"
        disabled={!command}
        onClick={() => void copy()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50"
      >
        {copied ? <CheckIcon className="h-4 w-4" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
        {i18nService.t(copied ? details.copied : details.copy)}
      </button>
      {children}
      {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}
      <span className="sr-only" aria-live="polite">
        {copied ? i18nService.t(details.copied) : ''}
      </span>
    </section>
  );
};

export default AgentProtocolConnectionCard;
