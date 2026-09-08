import { OPENCLAW_INDEFINITE_APPROVAL_EXPIRES_AT_MS } from '@shared/openclaw/agentRuntimeSettings';
import {
  ApprovalDecision,
  type ApprovalDecision as ApprovalDecisionValue,
  ApprovalKind,
  type ApprovalRequest,
  canGrantExecApprovalForSession,
  ExecApprovalDecision,
  PERSISTENT_APPROVAL_EXPIRES_AT_MS,
} from '@shared/openclaw/approvals';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

interface ExecApprovalModalProps {
  approval: ApprovalRequest;
  onExpire: () => void;
  onResolve: (decision: ApprovalDecisionValue) => Promise<void>;
}

export const resolveAllowedDecisions = (approval: ApprovalRequest): ApprovalDecisionValue[] => {
  const supplied =
    Array.isArray(approval.request.allowedDecisions) && approval.request.allowedDecisions.length > 0
      ? approval.request.allowedDecisions
      : undefined;
  const unavailable = new Set(
    approval.kind === ApprovalKind.Exec ? (approval.request.unavailableDecisions ?? []) : [],
  );
  const allowOnce = Array.isArray(supplied)
    ? supplied.includes(ExecApprovalDecision.AllowOnce)
    : !unavailable.has(ExecApprovalDecision.AllowOnce);
  const deny = Array.isArray(supplied)
    ? supplied.includes(ExecApprovalDecision.Deny)
    : !unavailable.has(ExecApprovalDecision.Deny);
  return [
    ...(allowOnce ? [ApprovalDecision.AllowOnce] : []),
    ...(allowOnce && approval.kind === ApprovalKind.Exec && canGrantExecApprovalForSession(approval)
      ? [ApprovalDecision.AllowForSession]
      : []),
    ...(deny ? [ApprovalDecision.Deny] : []),
  ];
};

export const resolveApprovalSummary = (approval: ApprovalRequest): string => {
  if (approval.kind === ApprovalKind.Exec) {
    return approval.request.command?.trim() || approval.request.commandPreview?.trim() || '';
  }

  const detail = approval.request.detail?.trim();
  const description = approval.request.description.trim();
  const toolName = approval.request.toolName?.trim();
  return [toolName, detail || description].filter(Boolean).join(' ');
};

export const resolveApprovalDeadline = (
  expiresAtMs: number,
  now: number,
): { remainingSeconds: number | null; expired: boolean } => {
  if (
    expiresAtMs >= PERSISTENT_APPROVAL_EXPIRES_AT_MS ||
    expiresAtMs === OPENCLAW_INDEFINITE_APPROVAL_EXPIRES_AT_MS
  ) {
    return { remainingSeconds: null, expired: false };
  }
  const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  return { remainingSeconds, expired: remainingSeconds <= 0 };
};

const ExecApprovalModal: React.FC<ExecApprovalModalProps> = ({ approval, onExpire, onResolve }) => {
  const [now, setNow] = useState(Date.now());
  const [submitting, setSubmitting] = useState<ApprovalDecisionValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const expirationNotifiedRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    expirationNotifiedRef.current = false;
    setNow(Date.now());
    setSubmitting(null);
    setError(null);
  }, [approval.id, approval.kind]);

  const allowed = useMemo(() => resolveAllowedDecisions(approval), [approval]);
  const { remainingSeconds, expired } = resolveApprovalDeadline(approval.expiresAtMs, now);
  const isPluginApproval = approval.kind === ApprovalKind.Plugin;
  const heading = isPluginApproval
    ? approval.request.title?.trim() || i18nService.t('pluginApprovalHeading')
    : i18nService.t('execApprovalHeading');
  const summary = resolveApprovalSummary(approval);

  useEffect(() => {
    if (!expired || expirationNotifiedRef.current) return;
    expirationNotifiedRef.current = true;
    onExpire();
  }, [expired, onExpire]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const fallback = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
      (denyButtonRef.current ?? fallback)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocus?.focus();
    };
  }, [approval.id, approval.kind]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex < 0 || currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  };

  const submit = async (decision: ApprovalDecisionValue) => {
    if (expired || submitting) return;
    setSubmitting(decision);
    setError(null);
    try {
      await onResolve(decision);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setSubmitting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 px-4 backdrop-blur-[2px]">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="exec-approval-title"
        onKeyDown={handleDialogKeyDown}
        onKeyUp={event => event.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-background shadow-[0_24px_70px_rgba(0,0,0,0.24)]"
      >
        <div className="px-5 pb-4 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="exec-approval-title" className="text-[15px] font-semibold text-foreground">
                {heading}
              </h2>
            </div>
            {remainingSeconds !== null && (
              <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-warning">
                {expired ? i18nService.t('execApprovalExpired') : `${remainingSeconds}s`}
              </span>
            )}
          </div>
        </div>

        {summary && (
          <div className="px-5 pb-4">
            <div
              className={
                isPluginApproval
                  ? 'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface/70 px-3 py-2 font-mono text-xs text-foreground'
                  : 'truncate rounded-lg bg-surface/70 px-3 py-2 font-mono text-xs text-foreground'
              }
              title={summary}
            >
              {summary}
            </div>
          </div>
        )}

        {(error || (!isPluginApproval && approval.request.warningText)) && (
          <div className="space-y-2 px-5 pb-4">
            {!isPluginApproval && approval.request.warningText && (
              <div className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                {approval.request.warningText}
              </div>
            )}
            {error && <div className="text-xs text-danger">{error}</div>}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border/70 bg-surface/60 px-5 py-3.5">
          {allowed.includes(ApprovalDecision.Deny) && (
            <button
              ref={denyButtonRef}
              type="button"
              disabled={expired || submitting !== null}
              onClick={() => void submit(ApprovalDecision.Deny)}
              className="rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              {i18nService.t('execApprovalDeny')}
            </button>
          )}
          {allowed.includes(ApprovalDecision.AllowForSession) && (
            <button
              type="button"
              disabled={expired || submitting !== null}
              onClick={() => void submit(ApprovalDecision.AllowForSession)}
              className="rounded-lg border border-primary/35 bg-background px-3.5 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5 disabled:opacity-50"
            >
              {i18nService.t('execApprovalAllowSession')}
            </button>
          )}
          {allowed.includes(ApprovalDecision.AllowOnce) && (
            <button
              type="button"
              disabled={expired || submitting !== null}
              onClick={() => void submit(ApprovalDecision.AllowOnce)}
              className="rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {i18nService.t('execApprovalAllowOnce')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ExecApprovalModal;
