import {
  ArchiveBoxArrowDownIcon,
  ArrowUturnLeftIcon,
  ChatBubbleLeftRightIcon,
  PencilSquareIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  canStartWorkboardCard,
  WORKBOARD_STATUSES,
  type WorkboardCard,
  workboardCardHasLiveExecution,
  workboardCardSessionKey,
  type WorkboardDiagnostic,
  type WorkboardEvent,
  type WorkboardStatus,
} from '@shared/openclaw/workboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

type Props = {
  card: WorkboardCard;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpenSession?: () => void;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onMove: (status: WorkboardStatus) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onComment: (body: string) => Promise<void>;
  onDelete: () => Promise<void>;
};

const DRAWER_DEFAULT_WIDTH = 480;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_EDGE_GAP = 24;

export const clampWorkboardDetailsDrawerWidth = (width: number, availableWidth: number): number => {
  const maximum = Math.max(280, availableWidth - DRAWER_EDGE_GAP);
  const minimum = Math.min(DRAWER_MIN_WIDTH, maximum);
  return Math.min(Math.max(width, minimum), maximum);
};

const formatDate = (value?: number): string =>
  value ? new Date(value).toLocaleString() : i18nService.t('workboardValueUnavailable');

const detailValues = (values: Array<string | undefined>): string[] =>
  values.map(value => value?.trim() ?? '').filter(Boolean);

const LOCALIZED_DIAGNOSTIC_KINDS = new Set([
  'stranded_ready',
  'running_without_heartbeat',
  'blocked_too_long',
  'repeated_failures',
  'missing_proof',
  'orphaned_session',
  'archived_but_active',
]);

const LOCALIZED_EVENT_KINDS = new Set([
  'created',
  'edited',
  'moved',
  'linked',
  'specified',
  'decomposed',
  'claimed',
  'heartbeat',
  'execution_updated',
  'attempt_started',
  'attempt_updated',
  'comment_added',
  'link_added',
  'proof_added',
  'artifact_added',
  'attachment_added',
  'diagnostic',
  'notification',
  'dispatch',
  'orchestration',
  'protocol_violation',
  'archived',
  'unarchived',
  'stale',
]);

const diagnosticCopy = (diagnostic: WorkboardDiagnostic): { title: string; detail: string } => {
  if (!LOCALIZED_DIAGNOSTIC_KINDS.has(diagnostic.kind)) {
    return { title: diagnostic.title, detail: diagnostic.detail };
  }
  return {
    title: i18nService.t(`workboardDiagnostic_${diagnostic.kind}_title`),
    detail: i18nService.t(`workboardDiagnostic_${diagnostic.kind}_detail`),
  };
};

const eventCopy = (event: WorkboardEvent): string => {
  const label = LOCALIZED_EVENT_KINDS.has(event.kind)
    ? i18nService.t(`workboardEvent_${event.kind}`)
    : event.kind;
  if (event.kind !== 'moved' || !event.fromStatus || !event.toStatus) return label;
  return `${label}：${i18nService.t(`workboardStatus_${event.fromStatus}`)} → ${i18nService.t(`workboardStatus_${event.toStatus}`)}`;
};

const DetailList: React.FC<{ title: string; values: string[] }> = ({ title, values }) => {
  const entries = values.filter(Boolean).slice(-6);
  if (entries.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      <ul className="space-y-1.5 text-xs text-secondary">
        {entries.map((entry, index) => (
          <li
            key={`${entry}:${index}`}
            className="break-words rounded-lg bg-surface-raised px-3 py-2"
          >
            {entry}
          </li>
        ))}
      </ul>
    </section>
  );
};

const WorkboardCardDetailsDrawer: React.FC<Props> = ({
  card,
  busy,
  onClose,
  onEdit,
  onOpenSession,
  onStart,
  onStop,
  onMove,
  onArchive,
  onComment,
  onDelete,
}) => {
  const [comment, setComment] = useState('');
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const drawerRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const archived = Boolean(card.metadata?.archivedAt);
  const sessionKey = workboardCardSessionKey(card);
  const attempts = card.metadata?.attempts ?? [];
  const comments = card.metadata?.comments ?? [];
  const diagnostics = card.metadata?.diagnostics ?? [];
  const proof = card.metadata?.proof ?? [];
  const artifacts = card.metadata?.artifacts ?? [];
  const links = card.metadata?.links ?? [];
  const attachments = card.metadata?.attachments ?? [];
  const workerLogs = card.metadata?.workerLogs ?? [];
  const notifications = card.metadata?.notifications ?? [];
  const automation = card.metadata?.automation;
  const events = card.events ?? [];
  const runId = card.runId || card.execution?.runId;
  const hasMissingProof = diagnostics.some(diagnostic => diagnostic.kind === 'missing_proof');
  const latestAttemptSucceeded = attempts[attempts.length - 1]?.status === 'succeeded';
  const isLive = workboardCardHasLiveExecution(card);
  const summary = (() => {
    if (card.status === 'running') return i18nService.t('workboardSummaryRunning');
    if (card.status === 'review') return i18nService.t('workboardSummaryReview');
    if (card.status === 'done') {
      return i18nService.t(
        hasMissingProof
          ? latestAttemptSucceeded
            ? 'workboardSummaryDoneMissingProofSucceeded'
            : 'workboardSummaryDoneMissingProof'
          : 'workboardSummaryDone',
      );
    }
    if (card.status === 'blocked') return i18nService.t('workboardSummaryBlocked');
    if (archived || canStartWorkboardCard(card)) return null;
    if (sessionKey || card.taskId || card.metadata?.claim) {
      return i18nService.t('workboardExistingExecutionHint');
    }
    if (!['backlog', 'todo', 'ready'].includes(card.status)) {
      return i18nService.t('workboardStartStatusHint');
    }
    return null;
  })();
  const summaryTone =
    hasMissingProof || card.status === 'blocked'
      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      : card.status === 'done'
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : 'bg-primary/10 text-primary';
  const hasTechnicalDetails = Boolean(
    sessionKey ||
    card.taskId ||
    runId ||
    workerLogs.length ||
    automation ||
    notifications.length ||
    card.metadata?.workerProtocol?.detail,
  );

  const availableWidth = useCallback(
    () => drawerRef.current?.parentElement?.clientWidth ?? window.innerWidth,
    [],
  );

  useEffect(() => {
    const handleWindowResize = () => {
      setDrawerWidth(width => clampWorkboardDetailsDrawerWidth(width, availableWidth()));
    };
    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [availableWidth]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      event.preventDefault();
      resizeCleanupRef.current?.();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setDrawerWidth(
          clampWorkboardDetailsDrawerWidth(right - moveEvent.clientX, availableWidth()),
        );
      };
      const stopResize = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', stopResize);
        resizeCleanupRef.current = null;
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      resizeCleanupRef.current = stopResize;
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', stopResize);
    },
    [availableWidth],
  );

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    [],
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? 1 : -1;
      setDrawerWidth(width =>
        clampWorkboardDetailsDrawerWidth(width + direction * 24, availableWidth()),
      );
    },
    [availableWidth],
  );

  const submitComment = async () => {
    const body = comment.trim();
    if (!body) return;
    try {
      await onComment(body);
      setComment('');
    } catch {
      // The owning view presents the canonical operation error.
    }
  };

  return (
    <aside
      ref={drawerRef}
      className="absolute bottom-3 right-3 top-3 z-50 flex max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      style={{ width: drawerWidth }}
      role="dialog"
      aria-modal="true"
      aria-label={i18nService.t('workboardCardDetails')}
    >
      <div
        className="group absolute bottom-0 left-0 top-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/10"
        onMouseDown={handleResizeStart}
        onKeyDown={handleResizeKeyDown}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={Math.min(
          DRAWER_MIN_WIDTH,
          Math.max(280, availableWidth() - DRAWER_EDGE_GAP),
        )}
        aria-valuemax={Math.max(280, availableWidth() - DRAWER_EDGE_GAP)}
        aria-valuenow={Math.round(drawerWidth)}
        aria-label={i18nService.t('workboardDetailsResize')}
        title={i18nService.t('workboardDetailsResize')}
      >
        <span className="absolute left-0.5 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary" />
      </div>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
              {i18nService.t(`workboardPriority_${card.priority}`)}
            </span>
            {isLive && card.metadata?.claim?.ownerId && (
              <span className="truncate text-xs text-secondary">
                {i18nService
                  .t('workboardClaimedBy')
                  .replace('{owner}', card.metadata.claim.ownerId)}
              </span>
            )}
          </div>
          <h2 className="break-words text-base font-semibold text-foreground">{card.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground"
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <section className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl bg-surface-raised p-3 text-sm">
          <span className="text-secondary">{i18nService.t('workboardStatus')}</span>
          <select
            value={card.status}
            onChange={event =>
              void onMove(event.target.value as WorkboardStatus).catch(() => undefined)
            }
            disabled={busy || archived}
            className="min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-foreground outline-none focus:border-primary disabled:opacity-50"
          >
            {WORKBOARD_STATUSES.map(status => (
              <option key={status} value={status}>
                {i18nService.t(`workboardStatus_${status}`)}
              </option>
            ))}
          </select>
          <span className="text-secondary">{i18nService.t('workboardAgent')}</span>
          <strong className="break-all font-medium text-foreground">
            {card.agentId || i18nService.t('workboardDefaultAgent')}
          </strong>
          <span className="text-secondary">{i18nService.t('workboardLinkedSession')}</span>
          <strong className="font-normal text-foreground">
            {sessionKey
              ? i18nService.t('workboardSessionLinked')
              : i18nService.t('workboardNoLinkedSession')}
          </strong>
          <span className="text-secondary">{i18nService.t('workboardUpdatedAt')}</span>
          <strong className="font-normal text-foreground">{formatDate(card.updatedAt)}</strong>
          <span className="text-secondary">{i18nService.t('workboardCreatedAt')}</span>
          <strong className="font-normal text-foreground">{formatDate(card.createdAt)}</strong>
          {card.startedAt && (
            <>
              <span className="text-secondary">{i18nService.t('workboardStartedAt')}</span>
              <strong className="font-normal text-foreground">{formatDate(card.startedAt)}</strong>
            </>
          )}
          {card.completedAt && (
            <>
              <span className="text-secondary">{i18nService.t('workboardCompletedAt')}</span>
              <strong className="font-normal text-foreground">
                {formatDate(card.completedAt)}
              </strong>
            </>
          )}
        </section>

        {summary && (
          <p className={`rounded-lg px-3 py-2 text-xs leading-5 ${summaryTone}`}>{summary}</p>
        )}

        {card.notes && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardCardNotes')}
            </h3>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-secondary">
              {card.notes}
            </p>
          </section>
        )}

        {card.labels.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardLabels')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {card.labels.map(label => (
                <span key={label} className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">
                  {label}
                </span>
              ))}
            </div>
          </section>
        )}

        {attempts.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardAttempts').replace('{count}', String(attempts.length))}
            </h3>
            <ul className="space-y-1.5 text-xs text-secondary">
              {attempts
                .slice(-6)
                .reverse()
                .map(attempt => (
                  <li key={attempt.id} className="rounded-lg bg-surface-raised px-3 py-2">
                    {detailValues([
                      i18nService.t(`workboardAttemptStatus_${attempt.status}`),
                      attempt.engine === 'openclaw'
                        ? i18nService.t('workboardEngine_openclaw')
                        : attempt.engine,
                      attempt.model,
                      attempt.error,
                    ]).join(' · ')}
                  </li>
                ))}
            </ul>
          </section>
        )}

        <DetailList
          title={i18nService.t('workboardLinks').replace('{count}', String(links.length))}
          values={links.map(item =>
            detailValues([item.type, item.title, item.targetCardId, item.url]).join(' · '),
          )}
        />

        {(diagnostics.length > 0 || card.metadata?.workerProtocol?.detail) && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardDiagnostics')}
            </h3>
            <ul className="space-y-1.5 text-xs text-amber-500">
              {diagnostics.slice(-6).map(diagnostic => (
                <li
                  key={`${diagnostic.kind}:${diagnostic.lastSeenAt}`}
                  className="rounded-lg bg-amber-500/10 px-3 py-2"
                >
                  <strong>{diagnosticCopy(diagnostic).title}</strong>
                  {diagnosticCopy(diagnostic).detail && (
                    <p className="mt-1 text-secondary">{diagnosticCopy(diagnostic).detail}</p>
                  )}
                </li>
              ))}
              {card.metadata?.workerProtocol?.detail && (
                <li className="rounded-lg bg-amber-500/10 px-3 py-2">
                  {card.metadata.workerProtocol.detail}
                </li>
              )}
            </ul>
          </section>
        )}

        {(proof.length > 0 || artifacts.length > 0) && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardEvidence')}
            </h3>
            <ul className="space-y-1.5 text-xs text-secondary">
              {proof.slice(-6).map(item => (
                <li key={item.id} className="rounded-lg bg-surface-raised px-3 py-2">
                  {detailValues([
                    i18nService.t(`workboardProofStatus_${item.status}`),
                    item.label,
                    item.command,
                    item.url,
                    item.note,
                  ]).join(' · ')}
                </li>
              ))}
              {artifacts.slice(-6).map(item => (
                <li key={item.id} className="rounded-lg bg-surface-raised px-3 py-2">
                  {detailValues([item.label, item.path, item.url, item.mimeType]).join(' · ')}
                </li>
              ))}
            </ul>
          </section>
        )}

        <DetailList
          title={i18nService
            .t('workboardAttachments')
            .replace('{count}', String(attachments.length))}
          values={attachments.map(item =>
            detailValues([item.fileName, item.mimeType, item.note]).join(' · '),
          )}
        />

        {events.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-foreground">
              {i18nService.t('workboardRecentEvents')}
            </h3>
            <ul className="space-y-1.5 text-xs text-secondary">
              {events
                .slice(-6)
                .reverse()
                .map(event => (
                  <li key={event.id} className="flex justify-between gap-3">
                    <span>{eventCopy(event)}</span>
                    <time className="shrink-0">{formatDate(event.at)}</time>
                  </li>
                ))}
            </ul>
          </section>
        )}

        {hasTechnicalDetails && (
          <details className="rounded-xl border border-border bg-surface-raised/40 px-3 py-2">
            <summary className="cursor-pointer select-none text-sm font-medium text-secondary hover:text-foreground">
              {i18nService.t('workboardTechnicalDetails')}
            </summary>
            <div className="mt-3 space-y-4 border-t border-border pt-3">
              <section className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                {sessionKey && (
                  <>
                    <span className="text-secondary">
                      {i18nService.t('workboardLinkedSession')}
                    </span>
                    <span className="break-all font-mono text-foreground">{sessionKey}</span>
                  </>
                )}
                {card.taskId && (
                  <>
                    <span className="text-secondary">{i18nService.t('workboardTask')}</span>
                    <span className="break-all font-mono text-foreground">{card.taskId}</span>
                  </>
                )}
                {runId && (
                  <>
                    <span className="text-secondary">{i18nService.t('workboardRun')}</span>
                    <span className="break-all font-mono text-foreground">{runId}</span>
                  </>
                )}
              </section>

              <DetailList
                title={i18nService.t('workboardWorkerLogs')}
                values={workerLogs.map(item =>
                  detailValues([
                    i18nService.t(`workboardLogLevel_${item.level}`),
                    item.message,
                    item.sessionKey,
                    item.runId,
                  ]).join(' · '),
                )}
              />

              <DetailList
                title={i18nService.t('workboardAutomation')}
                values={
                  automation
                    ? [
                        ...detailValues([automation.tenant, automation.boardId]),
                        automation.skills?.join(', '),
                        automation.workspace
                          ? detailValues([
                              automation.workspace.kind,
                              automation.workspace.path,
                              automation.workspace.branch,
                            ]).join(' · ')
                          : undefined,
                        automation.summary,
                      ].filter((value): value is string => Boolean(value))
                    : []
                }
              />

              <DetailList
                title={i18nService.t('workboardNotifications')}
                values={notifications.map(item =>
                  detailValues([item.kind, item.message, formatDate(item.createdAt)]).join(' · '),
                )}
              />

              <DetailList
                title={i18nService.t('workboardDiagnostics')}
                values={detailValues([card.metadata?.workerProtocol?.detail])}
              />
            </div>
          </details>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {i18nService.t('workboardOperatorNotes')}
          </h3>
          {comments.length > 0 ? (
            <ul className="mb-3 space-y-1.5 text-sm text-secondary">
              {comments.slice(-6).map(item => (
                <li key={item.id} className="rounded-lg bg-surface-raised px-3 py-2">
                  <p className="whitespace-pre-wrap break-words">{item.body}</p>
                  <time className="mt-1 block text-[10px] text-muted">
                    {formatDate(item.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-secondary">{i18nService.t('workboardNoNotes')}</p>
          )}
          <textarea
            value={comment}
            onChange={event => setComment(event.target.value)}
            maxLength={2000}
            rows={3}
            disabled={busy}
            placeholder={i18nService.t('workboardCommentPlaceholder')}
            className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void submitComment()}
            disabled={busy || !comment.trim()}
            className="mt-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            {i18nService.t('workboardAddComment')}
          </button>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy || archived}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          <PencilSquareIcon className="h-4 w-4" />
          {i18nService.t('workboardEdit')}
        </button>
        <button
          type="button"
          onClick={() => void onArchive(!archived).catch(() => undefined)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          {archived ? (
            <ArrowUturnLeftIcon className="h-4 w-4" />
          ) : (
            <ArchiveBoxArrowDownIcon className="h-4 w-4" />
          )}
          {i18nService.t(archived ? 'workboardRestore' : 'workboardArchive')}
        </button>
        {onOpenSession && (
          <button
            type="button"
            onClick={onOpenSession}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10"
          >
            <ChatBubbleLeftRightIcon className="h-4 w-4" />
            {i18nService.t('workboardOpenSession')}
          </button>
        )}
        {canStartWorkboardCard(card) && (
          <button
            type="button"
            onClick={() => void onStart().catch(() => undefined)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <PlayIcon className="h-4 w-4" />
            {i18nService.t('workboardStart')}
          </button>
        )}
        {workboardCardHasLiveExecution(card) && Boolean(sessionKey || card.taskId) && (
          <button
            type="button"
            onClick={() => void onStop().catch(() => undefined)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          >
            <StopIcon className="h-4 w-4" />
            {i18nService.t('workboardStop')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void onDelete().catch(() => undefined)}
          disabled={busy}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-50"
          aria-label={i18nService.t('delete')}
          title={i18nService.t('delete')}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  );
};

export default WorkboardCardDetailsDrawer;
