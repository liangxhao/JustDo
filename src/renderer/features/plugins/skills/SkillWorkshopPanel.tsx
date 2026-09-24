import {
  ChevronDownIcon,
  DocumentTextIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import { MAIN_USER_AGENT_ID } from '@shared/agents/agents';
import {
  type SkillProposalInspection,
  SkillProposalStatus,
  type SkillProposalSummary,
  type SkillWorkshopResult,
} from '@shared/plugins/skillWorkshop';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

const t = (key: string) => i18nService.t(key);
const unwrap = <T,>(result: SkillWorkshopResult<T>): T => {
  if (!result.success) throw new Error(result.error);
  return result.value;
};
const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'skillWorkshopUnavailable';
  return message.startsWith('skillWorkshop')
    ? t(message)
    : `${t('skillWorkshopRequestFailed')} ${message}`;
};
const button =
  'rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed';

interface Props {
  onSkillsChanged: () => Promise<void>;
}

/** Low-frequency entry: no background requests until the workshop is opened. */
export default function SkillWorkshopPanel(props: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = useCallback(() => {
    setIsOpen(false);
    launcher.current?.focus();
  }, []);
  return (
    <>
      <div className="flex items-center justify-end">
        <button
          ref={launcher}
          type="button"
          className="flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          aria-haspopup="dialog"
          onClick={() => setIsOpen(true)}
        >
          <DocumentTextIcon className="h-4 w-4" />
          {t('skillWorkshopTitle')}
        </button>
      </div>
      {isOpen &&
        createPortal(
          <Modal
            onClose={close}
            closeOnBackdrop={false}
            className="w-[min(1280px,94vw)] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface shadow-2xl"
          >
            <WorkshopDialog {...props} onClose={close} titleId={titleId} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

/** All proposal bodies remain dialog-local; reopening re-reads the native Workshop. */
function WorkshopDialog({
  onSkillsChanged,
  onClose,
  titleId,
}: Props & {
  onClose: () => void;
  titleId: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [showGuide, setShowGuide] = useState(false);
  const guideId = useId();
  const [available, setAvailable] = useState(false);
  const [proposals, setProposals] = useState<SkillProposalSummary[]>([]);
  const [inspection, setInspection] = useState<SkillProposalInspection | null>(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const mounted = useRef(false);
  const mutation = useRef(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const latestProposals = useRef<SkillProposalSummary[]>([]);
  const invalidateReads = useCallback(() => {
    generation.current++;
    selectionGeneration.current++;
  }, []);

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    try {
      const api = window.electron.skillWorkshop;
      const nextProposals = unwrap(await api.list(MAIN_USER_AGENT_ID));
      if (!mounted.current || version !== generation.current) return;
      latestProposals.current = nextProposals;
      setReadError('');
      setAvailable(true);
      setProposals(nextProposals);
      setInspection(current => {
        const updated = nextProposals.find(item => item.id === current?.record.id);
        return updated?.revisionHash === current?.revisionHash &&
          updated?.status === current?.record.status
          ? current
          : null;
      });
    } catch (failure) {
      if (!mounted.current || version !== generation.current) return;
      selectionGeneration.current++;
      setAvailable(false);
      setInspection(null);
      setReadError(errorText(failure));
    } finally {
      if (mounted.current && version === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    // Decisions and refreshes may remove the focused detail button.
    // Restore focus before the next key press so the dialog trap stays active.
    if (document.activeElement === document.body) {
      dialog.current?.focus();
    }
  }, [inspection, busy]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      invalidateReads();
    };
  }, [refresh, invalidateReads]);

  useEffect(() => {
    const onFocus = () => {
      if (!mutation.current) void refresh();
    };
    window.addEventListener('focus', onFocus);
    // Only the visible review panel polls; writes are never replayed on reconnect.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !mutation.current) void refresh();
    }, 15000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const inspect = async (id: string) => {
    const version = ++selectionGeneration.current;
    setInspection(null);
    setError('');
    try {
      const result = unwrap(await window.electron.skillWorkshop.inspect(MAIN_USER_AGENT_ID, id));
      if (!mounted.current || version !== selectionGeneration.current) return;
      const latest = latestProposals.current.find(proposal => proposal.id === id);
      if (latest?.revisionHash !== result.revisionHash || latest?.status !== result.record.status)
        return;
      setInspection(result);
    } catch (failure) {
      if (mounted.current && version === selectionGeneration.current) setError(errorText(failure));
    }
  };

  const mutate = async (operation: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    selectionGeneration.current++;
    try {
      await operation();
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusy(false);
        await refresh();
      }
    }
  };

  const decide = (action: 'apply' | 'reject') => {
    const reviewed = inspection;
    if (!reviewed?.revisionHash) return;
    void mutate(async () => {
      // Never leave a stale approval button active after a timeout or conflict.
      setInspection(null);
      unwrap(
        await window.electron.skillWorkshop.decide({
          agentId: MAIN_USER_AGENT_ID,
          proposalId: reviewed.record.id,
          expectedRevisionHash: reviewed.revisionHash!,
          action,
        }),
      );
      await onSkillsChanged();
      // Refresh the list after a decision; a changed status requires a fresh selection.
    });
  };

  const pending = proposals.filter(item => item.status === SkillProposalStatus.Pending).length;
  const visible = proposals.filter(item => filter === 'all' || item.status === filter);
  const canDecide =
    available &&
    inspection?.record.status === SkillProposalStatus.Pending &&
    Boolean(inspection.revisionHash) &&
    !busy;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="p-6 space-y-5 outline-none text-foreground"
      onKeyDown={event => {
        if (event.key === 'Escape' && !mutation.current) {
          event.stopPropagation();
          onClose();
        }
        if (event.key !== 'Tab') return;
        const items = dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        );
        if (!items?.length) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-xl font-semibold flex items-center gap-3">
            <span className="rounded-xl bg-primary/10 p-2 text-primary">
              <DocumentTextIcon className="h-6 w-6" />
            </span>
            {t('skillWorkshopTitle')}
          </h2>
          <p className="mt-2 text-sm text-secondary">{t('skillWorkshopIntro')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowGuide(value => !value)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${showGuide ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-secondary hover:bg-surface-raised'}`}
            aria-pressed={showGuide}
            aria-expanded={showGuide}
            aria-controls={guideId}
          >
            <QuestionMarkCircleIcon className="h-4 w-4" />
            {t('skillWorkshopHelp')}
          </button>
          <button type="button" className={button} disabled={busy} onClick={onClose}>
            {t('skillWorkshopClose')}
          </button>
        </div>
      </div>
      {showGuide && (
        <section
          id={guideId}
          aria-label={t('skillWorkshopHelp')}
          className="grid gap-3 rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.07] via-surface to-surface-raised/50 p-4 sm:grid-cols-3"
        >
          {[
            {
              key: 'Purpose',
              tone: 'border-blue-500/20 bg-blue-500/5 text-blue-700 dark:text-blue-300',
            },
            {
              key: 'Effect',
              tone: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
            },
            {
              key: 'Choice',
              tone: 'border-violet-500/20 bg-violet-500/5 text-violet-700 dark:text-violet-300',
            },
          ].map(({ key, tone }) => (
            <div key={key} className={`space-y-2 rounded-xl border p-3 ${tone}`}>
              <h3 className="text-sm font-semibold">{t(`skillWorkshop${key}Title`)}</h3>
              <p className="text-xs leading-6">{t(`skillWorkshop${key}Body`)}</p>
            </div>
          ))}
        </section>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-secondary">
          {t('skillWorkshopReview')} ({pending})
        </p>
        <button
          type="button"
          className={`${button} ml-auto`}
          disabled={busy || loading}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          {t('skillWorkshopRefresh')}
        </button>
      </div>
      {(error || readError) && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 p-3 text-sm text-red-500 whitespace-pre-wrap"
        >
          {error || readError}
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4 lg:sticky lg:top-0">
          {loading && (
            <p role="status" className="text-sm text-secondary">
              {t('skillWorkshopLoading')}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            {t('skillWorkshopFilter')}
            <span className="relative w-28 shrink-0">
              <select
                className="w-full appearance-none cursor-pointer rounded-lg border border-border bg-surface-raised py-2 pl-3 pr-9 text-sm text-foreground shadow-sm transition-colors hover:border-primary/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                value={filter}
                onChange={event => {
                  selectionGeneration.current++;
                  setInspection(null);
                  setFilter(event.target.value);
                }}
              >
                <option value="all">{t('skillWorkshopAll')}</option>
                {Object.values(SkillProposalStatus).map(value => (
                  <option key={value} value={value}>
                    {t(`skillWorkshopStatus.${value}`)}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                aria-hidden="true"
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary"
              />
            </span>
          </label>
          {visible.length === 0 && (
            <p className="text-sm text-secondary">{t('skillWorkshopEmpty')}</p>
          )}
          <ul className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
            {visible.map(proposal => (
              <li key={proposal.id}>
                <button
                  type="button"
                  className={`${button} w-full text-left ${inspection?.record.id === proposal.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'bg-surface'}`}
                  disabled={busy || !available}
                  onClick={() => void inspect(proposal.id)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium" title={proposal.title}>
                      {proposal.title}
                    </span>
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                      {t(`skillWorkshopStatus.${proposal.status}`)}
                    </span>
                  </span>
                  <span className="block text-xs text-secondary mt-1">{proposal.description}</span>
                  {proposal.degradedState && (
                    <span className="block text-xs text-red-500">
                      {t('skillWorkshopDraftMissing')}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        {!inspection && (
          <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background p-8 text-center">
            <DocumentTextIcon className="mb-4 h-10 w-10 text-secondary" />
            <h3 className="font-medium">{t('skillWorkshopSelectTitle')}</h3>
            <p className="mt-2 max-w-sm text-sm leading-6 text-secondary">
              {t('skillWorkshopSelectHint')}
            </p>
          </div>
        )}
        {inspection && (
          <article className="min-w-0 space-y-5 rounded-xl border border-border bg-surface p-5">
            <header className="space-y-3 border-b border-border pb-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md bg-primary/10 px-2 py-1 text-primary">
                  {t(
                    inspection.record.kind === 'create'
                      ? 'skillWorkshopCreate'
                      : 'skillWorkshopUpdate',
                  )}
                </span>
                <span className="rounded-md bg-background px-2 py-1 text-secondary">
                  {t(`skillWorkshopStatus.${inspection.record.status}`)}
                </span>
              </div>
              <h4 className="text-lg font-semibold">{inspection.record.title}</h4>
              <p className="text-sm leading-6 text-secondary whitespace-pre-wrap">
                {inspection.record.description}
              </p>
              <p className="text-xs text-secondary">
                {t('skillWorkshopTarget')}{' '}
                <span className="font-mono break-all text-foreground">
                  {inspection.record.target.skillName}
                </span>
              </p>
            </header>
            {inspection.record.goal && (
              <section className="space-y-2">
                <h5 className="text-sm font-medium">{t('skillWorkshopGoal')}</h5>
                <p className="text-sm leading-6 whitespace-pre-wrap text-secondary">
                  {inspection.record.goal}
                </p>
              </section>
            )}
            <section className="rounded-lg bg-background p-4 space-y-2">
              <h5 className="text-sm font-medium">{t('skillWorkshopEvidence')}</h5>
              <p className="text-sm leading-6 whitespace-pre-wrap text-secondary">
                {inspection.record.evidence || t('skillWorkshopNoEvidence')}
              </p>
            </section>
            <p className="text-xs leading-5 text-secondary">{t('skillWorkshopReviewHint')}</p>
            {inspection.record.statusReason && (
              <p className="text-sm whitespace-pre-wrap">{inspection.record.statusReason}</p>
            )}
            {(inspection.comparisonUnavailable || inspection.targetChanged) && (
              <p role="alert" className="text-sm text-red-500">
                {t('skillWorkshopTargetChanged')}
              </p>
            )}
            <div
              className={`grid grid-cols-1 ${inspection.record.kind === 'update' ? 'xl:grid-cols-2' : ''} gap-3`}
            >
              {inspection.record.kind === 'update' && (
                <Instruction
                  label={t('skillWorkshopBefore')}
                  content={inspection.currentContent ?? t('skillWorkshopComparisonUnavailable')}
                />
              )}
              <Instruction label={t('skillWorkshopAfter')} content={inspection.content} />
            </div>
            {inspection.supportFiles?.map(file => (
              <Instruction
                key={file.path}
                label={`${t('skillWorkshopSupportFile')} · ${file.path}`}
                content={file.content}
              />
            ))}
            {inspection.record.scan.findings.map((finding, index) => (
              <p key={index} className="text-xs whitespace-pre-wrap text-secondary">
                {finding.file}:{finding.line} · {finding.message}
              </p>
            ))}
            <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-surface pt-4 pb-1">
              <button
                type="button"
                className={`${button} bg-primary text-white border-primary hover:opacity-90`}
                disabled={
                  !canDecide || inspection.comparisonUnavailable || inspection.targetChanged
                }
                onClick={() => decide('apply')}
              >
                {t('skillWorkshopApply')}
              </button>
              <button
                type="button"
                className={button}
                disabled={!canDecide}
                onClick={() => decide('reject')}
              >
                {t('skillWorkshopReject')}
              </button>
            </div>
          </article>
        )}
      </div>
    </div>
  );
}

function Instruction({ label, content }: { label: string; content: string }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border">
      <h5 className="border-b border-border bg-background px-3 py-2 text-xs font-medium">
        {label}
      </h5>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-4 text-xs leading-6 select-text">
        {content || t('skillWorkshopNoContent')}
      </pre>
    </section>
  );
}
