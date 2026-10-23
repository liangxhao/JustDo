import { CheckIcon, ChevronDownIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { PRODUCT_NAME } from '@shared/productMetadata';
import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface Props {
  command: string;
}

const ExampleField = {
  Protocol: 'protocol',
  Name: 'name',
  Command: 'command',
  Description: 'description',
} as const;
type ExampleField = (typeof ExampleField)[keyof typeof ExampleField];

const ApplicationConnectionExamples: React.FC<Props> = ({ command }) => {
  const [copied, setCopied] = useState<ExampleField | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const copyTimer = useRef<number>();

  useEffect(() => {
    revision.current += 1;
    setCopied(null);
    setError('');
    window.clearTimeout(copyTimer.current);
    return () => {
      revision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [command]);

  const copy = async (field: ExampleField, value: string) => {
    if (!value) return;
    const current = ++revision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(null);
    try {
      await navigator.clipboard.writeText(value);
      if (revision.current !== current) return;
      setCopied(field);
      setError('');
      copyTimer.current = window.setTimeout(() => setCopied(null), 1800);
    } catch {
      if (revision.current !== current) return;
      setError(i18nService.t('agentCliCopyFailed'));
    }
  };

  const fields = [
    { id: ExampleField.Protocol, label: 'applicationConnectionProtocol', value: 'codex' },
    { id: ExampleField.Name, label: 'applicationConnectionName', value: PRODUCT_NAME },
    { id: ExampleField.Command, label: 'agentCliCommand', value: command },
    {
      id: ExampleField.Description,
      label: 'applicationConnectionDescription',
      value: i18nService.t('applicationConnectionRuntimeDescription'),
    },
  ];
  const copyLabel = (label: string, isCopied: boolean) => i18nService
    .t(isCopied ? 'applicationConnectionValueCopied' : 'applicationConnectionCopyValue')
    .replace('{field}', i18nService.t(label));
  const copiedField = fields.find(field => field.id === copied);

  return (
    <details className="group min-w-0 rounded-xl border border-border bg-surface-raised/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
        {i18nService.t('applicationConnectionExampleSummary')}
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-secondary transition-transform group-open:rotate-180" />
      </summary>
      <div className="min-w-0 space-y-4 border-t border-border p-4">
        <p className="text-xs leading-5 text-secondary">
          {i18nService.t('applicationConnectionExamplesDescription')}
        </p>
        <ol className="space-y-3 text-xs leading-5 text-secondary">
          {[
            'applicationConnectionSetupRuntime',
            'applicationConnectionSetupValues',
            'applicationConnectionSetupAgent',
          ].map((key, index) => (
            <li key={key} className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {index + 1}
              </span>
              <span>{i18nService.t(key)}</span>
            </li>
          ))}
        </ol>
        <dl className="divide-y divide-border rounded-lg border border-border bg-surface">
          {fields.map(({ id, label, value }) => (
            <div key={id} className="min-w-0 space-y-1.5 p-3">
              <dt className="flex items-center justify-between gap-3 text-xs font-medium leading-5 text-secondary">
                <span>{i18nService.t(label)}</span>
                <button
                  type="button"
                  disabled={!value}
                  aria-label={copyLabel(label, copied === id)}
                  onClick={() => void copy(id, value)}
                  className="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                >
                  {copied === id ? (
                    <CheckIcon className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <ClipboardDocumentIcon className="h-3.5 w-3.5" />
                  )}
                  {i18nService.t(copied === id ? 'applicationConnectionCopied' : 'applicationConnectionCopy')}
                </button>
              </dt>
              <dd className="min-w-0 select-all whitespace-pre-wrap break-all font-mono text-xs leading-5 text-foreground">
                {value || '—'}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-5 text-secondary">
          {i18nService.t('applicationConnectionLaunchDescription')}
        </p>
        {error && <p role="alert" className="text-xs leading-5 text-danger">{error}</p>}
        <span className="sr-only" aria-live="polite">
          {copiedField ? copyLabel(copiedField.label, true) : ''}
        </span>
      </div>
    </details>
  );
};

export default ApplicationConnectionExamples;
