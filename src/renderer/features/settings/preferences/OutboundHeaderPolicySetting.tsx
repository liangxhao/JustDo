import {
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  CodeBracketSquareIcon,
  ExclamationCircleIcon,
  GlobeAltIcon,
  MinusCircleIcon,
  MinusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { OutboundHeaderPolicyView } from '@shared/network/network';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useDialogFocusTrap } from '@/shared/hooks/useDialogFocusTrap';

function PolicyTarget({ url, headers }: OutboundHeaderPolicyView['targets'][number]) {
  const addressId = useId();

  return (
    <tbody aria-labelledby={addressId} className="bg-surface">
      <tr>
        <th scope="rowgroup" colSpan={4} className="border-b border-border bg-surface-raised px-2.5 py-1.5 opacity-100 sm:px-3.5">
          <div className="flex items-center gap-2">
            <GlobeAltIcon className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
            <code id={addressId} title={url} className="min-w-0 truncate select-text font-semibold text-foreground">
              {url}
            </code>
          </div>
        </th>
      </tr>
      {headers.map(({ name, sourceField, value }) => {
        const source = sourceField ?? i18nService.t('outboundHeaderPolicyFixedValue');
        const injected = value !== null;
        const state = i18nService.t(injected ? 'outboundHeaderPolicyInjected' : 'outboundHeaderPolicyNotInjected');
        const StateIcon = injected ? CheckIcon : MinusIcon;
        return (
          <tr key={name} className="align-middle [&>*]:border-b [&>*]:border-border-subtle">
            <th scope="row" className="bg-transparent px-2.5 py-1 font-normal opacity-100 sm:px-3.5">
              <code title={name} className="block truncate select-text font-semibold text-foreground">{name}</code>
            </th>
            <td className="px-2.5 py-1 sm:px-3.5">
              {injected && (
                <code
                  tabIndex={value ? 0 : undefined}
                  className="block min-h-5 overflow-x-auto overflow-y-hidden whitespace-pre rounded bg-surface-inset px-1.5 py-0.5 leading-4 text-foreground select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  {value}
                </code>
              )}
            </td>
            <td className="px-2.5 py-1 sm:px-3.5">
              <span title={source} className="block truncate text-secondary">{source}</span>
            </td>
            <td className="px-2 py-1 text-center">
              <span
                role="img"
                aria-label={state}
                title={state}
                className={`inline-grid size-5 place-items-center rounded-full align-middle ${
                  injected ? 'bg-success/10 text-success' : 'bg-surface-raised text-secondary'
                }`}
              >
                <StateIcon className="size-3.5" aria-hidden="true" />
              </span>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

function OutboundHeaderPolicyDialog({ onClose }: { onClose: () => void }) {
  const [policy, setPolicy] = useState<OutboundHeaderPolicyView | null>(null);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocusTrap(dialogRef, closeRef, titleId);
  const StatusIcon = policy?.enabled ? CheckCircleIcon : MinusCircleIcon;

  useEffect(() => {
    let active = true;
    const readPolicy = async () => {
      try {
        const result = await window.electron.api.getOutboundHeaderPolicy();
        if (active) setPolicy(result);
      } catch {
        if (active) setFailed(true);
      }
    };
    void readPolicy();
    return () => {
      active = false;
    };
  }, []);

  return createPortal(
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      className="w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-muted text-primary">
            <CodeBracketSquareIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 self-center">
            <h3 id={titleId} className="text-lg font-semibold leading-snug text-foreground">
              {i18nService.t('outboundHeaderPolicyTitle')}
            </h3>
            {policy && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-secondary">
                <p role="status" className="flex items-center gap-1.5 font-medium">
                  <StatusIcon className={`size-4 shrink-0 ${policy.enabled ? 'text-success' : ''}`} aria-hidden="true" />
                  {i18nService.t(policy.enabled ? 'outboundHeaderPolicyEnabled' : 'outboundHeaderPolicyDisabled')}
                </p>
                {policy.targets.length > 0 && (
                  <span className="border-l border-border pl-3 tabular-nums">
                    {i18nService.t('outboundHeaderPolicyTargets')} {policy.targets.length}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XMarkIcon className="size-5" aria-hidden="true" />
          </button>
        </header>
        {policy && policy.targets.length > 0 ? (
          <div
            role="region"
            aria-label={i18nService.t('outboundHeaderPolicyTargets')}
            tabIndex={0}
            className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          >
            <table className="m-0 w-full table-fixed border-separate border-spacing-0 text-left text-xs">
              <thead className="sticky top-0 z-10 bg-surface [&_th]:border-b [&_th]:border-border [&_th]:bg-surface [&_th]:font-medium [&_th]:text-secondary [&_th]:opacity-100">
                <tr>
                  <th scope="col" className="w-1/4 px-2.5 py-1.5 sm:px-3.5">
                    {i18nService.t('outboundHeaderPolicyHeaderName')}
                  </th>
                  <th scope="col" className="px-2.5 py-1.5 sm:px-3.5">
                    {i18nService.t('outboundHeaderPolicyHeaderValue')}
                  </th>
                  <th scope="col" className="w-1/4 px-2.5 py-1.5 sm:px-3.5">
                    {i18nService.t('outboundHeaderPolicyHeaderSource')}
                  </th>
                  <th scope="col" className="w-14 px-2 py-1.5 text-center sm:w-[4.5rem]">
                    {i18nService.t('outboundHeaderPolicyHeaderState')}
                  </th>
                </tr>
              </thead>
              {policy.targets.map(target => <PolicyTarget key={target.url} {...target} />)}
            </table>
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto bg-background px-4 py-10 text-center sm:px-6">
            {failed ? (
              <div role="alert" className="space-y-2 text-danger">
                <ExclamationCircleIcon className="mx-auto size-7" aria-hidden="true" />
                <p className="text-sm">{i18nService.t('outboundHeaderPolicyReadFailed')}</p>
              </div>
            ) : (
              <div role="status" className="space-y-2 text-secondary">
                {policy ? (
                  <GlobeAltIcon className="mx-auto size-7" aria-hidden="true" />
                ) : (
                  <ArrowPathIcon className="mx-auto size-7 animate-spin" aria-hidden="true" />
                )}
                <p className="text-sm">
                  {i18nService.t(policy ? 'outboundHeaderPolicyEmpty' : 'loading')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>,
    document.body,
  );
}

export function OutboundHeaderPolicySetting() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-5">
      <h4 className="text-sm font-medium text-foreground">{i18nService.t('outboundHeaderPolicyTitle')}</h4>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <CodeBracketSquareIcon className="size-4 text-secondary" aria-hidden="true" />
        {i18nService.t('outboundHeaderPolicyView')}
      </button>
      {isOpen && <OutboundHeaderPolicyDialog onClose={() => setIsOpen(false)} />}
    </div>
  );
}
