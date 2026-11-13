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
    <li className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex items-start gap-2.5 border-b border-border bg-surface-raised/60 px-3.5 py-3 sm:px-4">
        <GlobeAltIcon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
        <h5 id={addressId} title={url} className="min-w-0 truncate select-text font-mono text-xs font-semibold leading-4 text-foreground">
          {url}
        </h5>
      </div>
      <table aria-labelledby={addressId} className="m-0 w-full table-fixed text-left text-xs">
        <thead className="border-b border-border-subtle">
          <tr>
            <th scope="col" className="w-1/4 whitespace-nowrap bg-surface px-2.5 py-2 font-medium text-secondary opacity-100 sm:px-4">
              {i18nService.t('outboundHeaderPolicyHeaderName')}
            </th>
            <th scope="col" className="whitespace-nowrap bg-surface px-2.5 py-2 font-medium text-secondary opacity-100 sm:px-4">
              {i18nService.t('outboundHeaderPolicyHeaderValue')}
            </th>
            <th scope="col" className="w-1/4 whitespace-nowrap bg-surface px-2.5 py-2 font-medium text-secondary opacity-100 sm:px-4">
              {i18nService.t('outboundHeaderPolicyHeaderSource')}
            </th>
            <th scope="col" className="w-14 whitespace-nowrap bg-surface px-2 py-2 text-center font-medium text-secondary opacity-100 sm:w-[4.5rem]">
              {i18nService.t('outboundHeaderPolicyHeaderState')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {headers.map(({ name, sourceField, value }) => {
            const source = sourceField ?? i18nService.t('outboundHeaderPolicyFixedValue');
            const injected = value !== null;
            const state = i18nService.t(injected ? 'outboundHeaderPolicyInjected' : 'outboundHeaderPolicyNotInjected');
            const StateIcon = injected ? CheckIcon : MinusIcon;
            return (
              <tr key={name} className="align-middle">
                <th scope="row" className="bg-transparent px-2.5 py-2 font-normal opacity-100 sm:px-4">
                  <code title={name} className="block truncate select-text font-semibold text-foreground">{name}</code>
                </th>
                <td className="px-2.5 py-2 sm:px-4">
                  {injected && (
                    <code
                      tabIndex={value ? 0 : undefined}
                      className="block min-h-7 overflow-x-auto overflow-y-hidden whitespace-pre rounded-md bg-surface-inset px-2 py-1.5 leading-4 text-foreground select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    >
                      {value}
                    </code>
                  )}
                </td>
                <td className="px-2.5 py-2 sm:px-4">
                  <span title={source} className="block truncate text-secondary">{source}</span>
                </td>
                <td className="px-2 py-2 text-center">
                  <span
                    role="img"
                    aria-label={state}
                    title={state}
                    className={`inline-grid size-6 place-items-center rounded-full align-middle ${
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
      </table>
    </li>
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
        <header className="flex shrink-0 items-start gap-3.5 border-b border-border px-4 py-4 sm:px-6 sm:py-5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-muted text-primary">
            <CodeBracketSquareIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 self-center">
            <h3 id={titleId} className="text-lg font-semibold leading-snug text-foreground">
              {i18nService.t('outboundHeaderPolicyTitle')}
            </h3>
            {policy && (
              <p role="status" className="mt-1 flex items-center gap-1.5 text-xs font-medium text-secondary">
                <StatusIcon className={`size-4 shrink-0 ${policy.enabled ? 'text-success' : ''}`} aria-hidden="true" />
                {i18nService.t(policy.enabled ? 'outboundHeaderPolicyEnabled' : 'outboundHeaderPolicyDisabled')}
              </p>
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
            className="min-h-0 overflow-y-auto overscroll-contain bg-background px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-6 sm:py-5"
          >
            <div className="mb-3 flex items-baseline gap-2">
              <h4 className="text-sm font-semibold text-foreground">{i18nService.t('outboundHeaderPolicyTargets')}</h4>
              <span className="rounded-full bg-surface-raised px-2 text-xs font-medium leading-5 tabular-nums text-secondary">
                {policy.targets.length}
              </span>
            </div>
            <ul className="space-y-3">
              {policy.targets.map(target => <PolicyTarget key={target.url} {...target} />)}
            </ul>
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
