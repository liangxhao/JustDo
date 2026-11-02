import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { PluginOperationAction } from '@shared/plugins/pluginOperation';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { isDomHTMLElement, isDomNode, useOwnerDocument } from '@/shared/dom/ownerDocument';

import {
  pluginOperationFailurePresentation,
  pluginOperationHasPendingRecovery,
  pluginOperationNeedsConfirmation,
} from './pluginOperationPresentation';
import {
  type PluginOperationFailure,
  type PluginOperationFailureItem,
  PluginOperationFailureState,
} from './pluginOperationService';
import { PluginOperationStatusContent } from './PluginOperationStatusSlot';

export type OperationResultItem = PluginOperationFailureItem;

export type OperationResult = {
  type: 'success' | 'error';
  title: string;
  message?: string;
  items?: OperationResultItem[];
  persistent?: true;
};

interface OperationResultModalProps {
  result: OperationResult | null;
  onClose: () => void;
  operation?: PluginOperationFailure;
}

type DialogLayer = { token: symbol; priority: number; element: HTMLDivElement | null };
const dialogStacks = new WeakMap<Document, DialogLayer[]>();
const topDialog = (stack: DialogLayer[]) =>
  stack.reduce<DialogLayer | undefined>(
    (top, layer) => (!top || layer.priority >= top.priority ? layer : top),
    undefined,
  );

const operationStageLabel = (operation: PluginOperationFailure) =>
  (operation.items?.length ?? 0) > 1
    ? i18nService.t(
        operation.items?.some(item => item.failedStage)
          ? 'pluginOperationFailureStagesInItems'
          : 'pluginOperationFailureStageUnavailable',
      )
    : operation.failedStage
      ? i18nService.t(`pluginOperationStageLabel.${operation.failedStage}`)
      : operation.items?.some(item => item.failedStage)
        ? i18nService.t('pluginOperationFailureStagesInItems')
        : i18nService.t('pluginOperationFailureStageUnavailable');

const operationItemPresentation = (
  action: PluginOperationAction,
  item: PluginOperationFailureItem,
) =>
  pluginOperationFailurePresentation({
    action,
    state:
      item.operationUnconfirmed || item.installSourceInUse
        ? PluginOperationFailureState.UNCONFIRMED
        : item.mutationCompleted && item.runtimeRecoveryPending
          ? PluginOperationFailureState.REFRESH_FAILED
          : item.installationCommitted
            ? PluginOperationFailureState.COMMITTED
            : PluginOperationFailureState.FAILED,
    failedStage: item.failedStage,
    operationUnconfirmed: item.operationUnconfirmed,
    installSourceInUse: item.installSourceInUse,
    mutationCompleted: item.mutationCompleted,
    runtimeRecoveryPending: item.runtimeRecoveryPending,
  });

const operationItemStageDescription = (item: PluginOperationFailureItem, runtimeRecovered?: true) =>
  i18nService.t(
    runtimeRecovered || item.operationUnconfirmed || item.installSourceInUse
      ? 'pluginOperationFailureLastStage'
      : item.mutationCompleted && item.runtimeRecoveryPending
        ? 'pluginOperationPendingStage'
        : 'pluginOperationFailureStage',
  );

const operationDuration = (operation: PluginOperationFailure) =>
  i18nService
    .t('pluginOperationElapsed')
    .replace('{seconds}', String(Math.max(0, Math.floor(operation.elapsedMs / 1000))));

const operationStageDescription = (operation: PluginOperationFailure, runtimeRecovered?: true) =>
  i18nService.t(
    runtimeRecovered || pluginOperationNeedsConfirmation(operation)
      ? 'pluginOperationFailureLastStage'
      : pluginOperationHasPendingRecovery(operation)
        ? 'pluginOperationPendingStage'
        : 'pluginOperationFailureStage',
  );

const OperationReportDetails: React.FC<{
  operation: PluginOperationFailure;
  visibleReason?: string;
  runtimeRecovered?: true;
}> = ({ operation, visibleReason, runtimeRecovered }) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyGeneration = useRef(0);
  const errorDetails = [
    ...new Set([operation.message, operation.details?.trim()].filter(Boolean)),
  ].join('\n\n');
  const guidance = pluginOperationFailurePresentation(operation).guidance;
  const nextStep = pluginOperationFailurePresentation(operation).nextStep;

  useEffect(() => {
    copyGeneration.current += 1;
    setCopyState('idle');
    return () => {
      copyGeneration.current += 1;
    };
  }, [operation.requestId]);

  const copyDetails = async () => {
    const generation = ++copyGeneration.current;
    const text = [
      pluginOperationFailurePresentation(operation).title,
      operation.label,
      i18nService.t(`pluginOperationLabel.${operation.action}`),
      `${operationStageDescription(operation, runtimeRecovered)}: ${operationStageLabel(operation)}`,
      operationDuration(operation),
      errorDetails,
      ...(!runtimeRecovered ? [...(nextStep !== guidance ? [nextStep] : []), guidance] : []),
      ...(operation.items ?? [])
        .flatMap(item => [
          item.label,
          item.failedStage
            ? `${operationItemStageDescription(item, runtimeRecovered)}: ${i18nService.t(`pluginOperationStageLabel.${item.failedStage}`)}`
            : '',
          item.message,
          item.type === 'success' || runtimeRecovered
            ? ''
            : operationItemPresentation(operation.action, item).guidance,
          item.installationCommitted ? i18nService.t('pluginOperationFailureItemCommitted') : '',
          item.operationUnconfirmed || item.installSourceInUse
            ? i18nService.t('pluginOperationFailureItemUnconfirmed')
            : '',
        ])
        .filter(Boolean),
      `${i18nService.t('pluginOperationFailureReference')}: ${operation.requestId}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      if (generation === copyGeneration.current) setCopyState('copied');
    } catch {
      if (generation === copyGeneration.current) setCopyState('failed');
    }
  };

  return (
    <details className="group border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg text-xs font-medium text-secondary outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
        {i18nService.t(
          pluginOperationHasPendingRecovery(operation)
            ? 'pluginOperationReportDetails'
            : 'pluginOperationFailureDetails',
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="mt-3 space-y-3">
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-xs">
          <div className="min-w-0">
            <dt className="text-secondary">
              {operationStageDescription(operation, runtimeRecovered)}
            </dt>
            <dd className="mt-1 break-words font-medium text-foreground">
              {operationStageLabel(operation)}
            </dd>
          </div>
          <div>
            <dt className="text-secondary">{i18nService.t('pluginOperationFailureDuration')}</dt>
            <dd className="mt-1 tabular-nums text-foreground">{operationDuration(operation)}</dd>
          </div>
        </dl>
        {errorDetails && errorDetails !== visibleReason && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised px-3 py-2 font-mono text-[11px] leading-5 text-secondary [overflow-wrap:anywhere]">
            {errorDetails}
          </pre>
        )}
        {pluginOperationHasPendingRecovery(operation) && (operation.items?.length ?? 0) > 1 && (
          <div className="max-h-48 space-y-3 overflow-y-auto">
            {operation.items?.map((item, index) => (
              <div
                key={`${item.label}:${index}`}
                className="break-words text-xs leading-5 [overflow-wrap:anywhere]"
              >
                <p className="font-medium text-foreground">{item.label}</p>
                {item.failedStage && (
                  <p className="text-secondary">
                    {i18nService.t(
                      runtimeRecovered
                        ? 'pluginOperationFailureLastStage'
                        : 'pluginOperationPendingStage',
                    )}{' '}
                    · {i18nService.t(`pluginOperationStageLabel.${item.failedStage}`)}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-secondary">{item.message}</p>
              </div>
            ))}
          </div>
        )}
        <p className="break-all text-[11px] text-secondary">
          {i18nService.t('pluginOperationFailureReference')}: {operation.requestId}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="button"
            onClick={() => void copyDetails()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
            {i18nService.t(
              pluginOperationHasPendingRecovery(operation)
                ? 'pluginOperationReportCopy'
                : 'pluginOperationFailureCopy',
            )}
          </button>
          <span role="status" className="text-xs text-secondary">
            {copyState === 'copied'
              ? i18nService.t('pluginOperationFailureCopied')
              : copyState === 'failed'
                ? i18nService.t('pluginOperationFailureCopyFailed')
                : ''}
          </span>
        </div>
      </div>
    </details>
  );
};

const OperationFailureContent: React.FC<{ operation: PluginOperationFailure }> = ({
  operation,
}) => {
  const nativeReason = operation.message.trim();
  const reason = nativeReason
    ? `${nativeReason.slice(0, 480)}${nativeReason.length > 480 ? '…' : ''}`
    : i18nService.t('pluginOperationFailureReasonUnavailable');
  const installationOutcome =
    !(operation.mutationCompleted && !pluginOperationNeedsConfirmation(operation)) &&
    (operation.items?.length ?? 0) < 2 &&
    (operation.action === PluginOperationAction.INSTALL ||
      operation.action === PluginOperationAction.UPDATE) &&
    (operation.state === 'committed' || operation.state === 'unconfirmed')
      ? i18nService.t(`pluginOperationInstallationOutcome.${operation.state}`)
      : undefined;
  return (
    <div className="space-y-3">
      <p className="break-words text-sm font-medium text-secondary [overflow-wrap:anywhere]">
        {operation.label}
      </p>
      {installationOutcome && (
        <p className="text-xs leading-5 text-secondary">{installationOutcome}</p>
      )}
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        {reason}
      </p>
      <div className="text-xs leading-5 text-secondary">
        <h3 className="sr-only">{i18nService.t('pluginOperationFailureNextStep')}</h3>
        <p>{pluginOperationFailurePresentation(operation).nextStep}</p>
      </div>
      <OperationReportDetails operation={operation} visibleReason={reason} />
    </div>
  );
};

const StructuredMessage: React.FC<{ message: string; type: OperationResult['type'] }> = ({
  message,
  type,
}) => {
  const blocks = message
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean);

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const lines = block
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
        const listItems = lines.slice(1).filter(line => /^•\s*/.test(line));

        if (lines.length > 1 && listItems.length === lines.length - 1) {
          const processGroups = new Map<string, string[]>();
          for (const item of listItems) {
            const label = item.replace(/^•\s*/, '');
            const match = label.match(/^(.*?)\s+\(PID\s+(\d+)\)$/i);
            const name = match?.[1] || label;
            const pids = processGroups.get(name) ?? [];
            if (match?.[2]) pids.push(match[2]);
            processGroups.set(name, pids);
          }

          return (
            <div key={`${block}:${blockIndex}`}>
              <div className="mb-2 text-[11px] font-medium text-secondary">{lines[0]}</div>
              <div className="flex flex-wrap gap-1.5">
                {[...processGroups.entries()].map(([name, pids]) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-foreground shadow-sm"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        type === 'error' ? 'bg-red-400' : 'bg-green-400'
                      }`}
                    />
                    <span className="font-medium">{name}</span>
                    {pids.length > 0 && (
                      <span className="text-[10px] text-secondary">PID {pids.join(' · ')}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          );
        }

        if (lines.length > 1) {
          return (
            <div key={`${block}:${blockIndex}`}>
              <div className="mb-1.5 text-[11px] font-medium text-secondary">{lines[0]}</div>
              <div className="rounded-lg bg-surface-raised px-3 py-2 font-mono text-[11px] leading-5 text-secondary [overflow-wrap:anywhere]">
                {lines.slice(1).join('\n')}
              </div>
            </div>
          );
        }

        return (
          <div
            key={`${block}:${blockIndex}`}
            className={`rounded-lg px-3 py-2.5 text-xs leading-5 ${
              type === 'error'
                ? 'bg-red-500/[0.06] text-secondary'
                : 'bg-green-500/[0.06] text-secondary'
            }`}
          >
            {block}
          </div>
        );
      })}
    </div>
  );
};

export const OperationResultNotice: React.FC<{
  result: OperationResult;
  onClose: () => void;
  operation?: PluginOperationFailure;
  runtimeRecovered?: true;
}> = ({ result, onClose, operation, runtimeRecovered }) => {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (
      (operation && (!runtimeRecovered || operation.details?.trim())) ||
      result.persistent ||
      paused
    )
      return;
    const timer = window.setTimeout(() => onCloseRef.current(), 3000);
    return () => window.clearTimeout(timer);
  }, [operation, runtimeRecovered, paused, result.title, result.message, result.persistent]);

  return (
    <PluginOperationStatusContent>
      <div
        className="rounded-xl border border-border bg-surface px-4 py-3 shadow-lg animate-fade-in-up"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => {
          if (!isDomNode(event.relatedTarget) || !event.currentTarget.contains(event.relatedTarget))
            setFocused(false);
        }}
      >
        <div className="flex items-start gap-2.5">
          <CheckCircleIcon
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
          <div className="min-w-0 flex-1" role="status" aria-live="polite">
            <p className="break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
              {result.title}
            </p>
            {operation && (
              <p className="mt-0.5 break-words text-xs text-secondary [overflow-wrap:anywhere]">
                {operation.label}
              </p>
            )}
            {result.message && (
              <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-secondary [overflow-wrap:anywhere]">
                {result.message}
              </p>
            )}
            {operation && !runtimeRecovered && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                <ClockIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                {i18nService.t('pluginOperationRecoveryPending')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('pluginOperationNoticeDismiss')}
            className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <XMarkIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        {result.items?.map((item, index) => (
          <p
            key={`${item.label}:${index}`}
            className="mt-2 break-words text-xs leading-5 text-secondary [overflow-wrap:anywhere]"
          >
            <span className="font-medium">{item.label}</span> · {item.message}
          </p>
        ))}
        {operation && (
          <div className="mt-3 space-y-3">
            {!runtimeRecovered && (
              <p className="text-xs leading-5 text-secondary">
                {pluginOperationFailurePresentation(operation).nextStep}
              </p>
            )}
            {runtimeRecovered && operation.details?.trim() && (
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-amber-700 dark:text-amber-300 [overflow-wrap:anywhere]">
                {operation.details}
              </p>
            )}
            <OperationReportDetails operation={operation} runtimeRecovered={runtimeRecovered} />
          </div>
        )}
      </div>
    </PluginOperationStatusContent>
  );
};

const OperationResultModal: React.FC<OperationResultModalProps> = ({
  result,
  onClose,
  operation,
}) => {
  const ownerDocument = useOwnerDocument();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const isSuccessNotice =
    result?.type === 'success' &&
    !operation &&
    !(result.items ?? []).some(
      item =>
        item.type === 'error' ||
        item.operationUnconfirmed ||
        item.installSourceInUse ||
        item.failedStage ||
        (item.installationCommitted && !item.mutationCompleted),
    );
  const isOpen = result !== null && !isSuccessNotice;
  const operationId = operation?.requestId;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = isDomHTMLElement(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : null;
    const stack = dialogStacks.get(ownerDocument) ?? [];
    const dialogToken = Symbol();
    const layer = {
      token: dialogToken,
      priority: operationId ? 80 : 50,
      element: dialogRef.current,
    };
    stack.push(layer);
    dialogStacks.set(ownerDocument, stack);
    if (topDialog(stack)?.token === dialogToken)
      dialogRef.current?.querySelector<HTMLElement>('[data-primary-action]')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (topDialog(stack)?.token !== dialogToken) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      // The result sits over editable dialogs; only this top layer owns their keys.
      event.stopImmediatePropagation();
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(element => {
        if (element.hasAttribute('disabled')) return false;
        const closedDetails = element.closest('details:not([open])');
        return !closedDetails || closedDetails.querySelector('summary')?.contains(element);
      });
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (ownerDocument.activeElement === first ||
          !dialogRef.current.contains(ownerDocument.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (ownerDocument.activeElement === last ||
          !dialogRef.current.contains(ownerDocument.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const keyTarget = ownerDocument.defaultView ?? ownerDocument;
    keyTarget.addEventListener('keydown', handleKeyDown as EventListener, true);
    return () => {
      keyTarget.removeEventListener('keydown', handleKeyDown as EventListener, true);
      const wasTopmost = topDialog(stack)?.token === dialogToken;
      const index = stack.indexOf(layer);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) dialogStacks.delete(ownerDocument);
      if (wasTopmost) {
        const nextDialog = topDialog(stack)?.element;
        if (previousFocus?.isConnected && (!nextDialog || nextDialog.contains(previousFocus)))
          previousFocus.focus();
        else nextDialog?.querySelector<HTMLElement>('[data-primary-action]')?.focus();
      }
    };
  }, [isOpen, operationId, ownerDocument]);

  if (!result) return null;
  if (isSuccessNotice) return <OperationResultNotice result={result} onClose={onClose} />;

  return createPortal(
    <Modal
      onClose={onClose}
      closeOnBackdrop={false}
      overlayClassName={`fixed inset-0 ${operation ? 'z-[80]' : 'z-50'} flex items-center justify-center bg-black/50 backdrop-blur-[2px]`}
      className="mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl animate-fade-in-up"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={operation ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              result.type === 'success'
                ? 'bg-green-500/10'
                : operation && operation.state !== 'failed'
                  ? 'bg-amber-500/10'
                  : 'bg-red-500/10'
            }`}
          >
            {result.type === 'success' ? (
              <CheckCircleIcon className="h-5 w-5 text-green-500" />
            ) : (
              <ExclamationTriangleIcon
                className={`h-5 w-5 ${operation && operation.state !== 'failed' ? 'text-amber-500' : 'text-red-500'}`}
              />
            )}
          </div>
          <div
            id={titleId}
            className="min-w-0 flex-1 pt-1 text-base font-semibold leading-6 text-foreground"
          >
            {result.title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {operation && (
          <p id={descriptionId} className="sr-only">
            {operation.label}. {pluginOperationFailurePresentation(operation).nextStep}
          </p>
        )}

        <div className="max-h-[60vh] overflow-y-auto px-5 pb-4">
          <div className="space-y-3">
            {operation ? (
              <OperationFailureContent key={operation.requestId} operation={operation} />
            ) : (
              result.message && <StructuredMessage message={result.message} type={result.type} />
            )}
            {result.items?.map((item, index) => (
              <div key={`${item.label}:${index}`} className="border-t border-border pt-3">
                <div className="mb-3 flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      (item.type ?? result.type) === 'success' ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  />
                  <div
                    className="truncate text-sm font-semibold text-foreground"
                    title={item.label}
                  >
                    {item.label}
                  </div>
                </div>
                {item.failedStage && (
                  <p className="mb-2 text-xs text-secondary">
                    {operationItemStageDescription(item)} ·{' '}
                    {i18nService.t(`pluginOperationStageLabel.${item.failedStage}`)}
                  </p>
                )}
                {(item.installationCommitted ||
                  item.operationUnconfirmed ||
                  item.installSourceInUse) && (
                  <p className="mb-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    {i18nService.t(
                      item.installationCommitted
                        ? 'pluginOperationFailureItemCommitted'
                        : 'pluginOperationFailureItemUnconfirmed',
                    )}
                  </p>
                )}
                <StructuredMessage message={item.message} type={item.type ?? result.type} />
                {operation && (item.type ?? result.type) === 'error' && (
                  <p className="mt-2 text-xs leading-5 text-secondary">
                    {operationItemPresentation(operation.action, item).nextStep}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end px-5 pb-5">
          <button
            type="button"
            onClick={onClose}
            data-primary-action
            className="min-w-20 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-105 active:scale-[0.98]"
          >
            {i18nService.t(operation ? 'pluginOperationFailureDismiss' : 'confirm')}
          </button>
        </div>
      </div>
    </Modal>,
    ownerDocument.body,
  );
};

export default OperationResultModal;
