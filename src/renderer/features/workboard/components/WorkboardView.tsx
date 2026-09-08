import {
  ArrowPathIcon,
  BoltIcon,
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import {
  canStartWorkboardCard,
  WORKBOARD_STATUSES,
  type WorkboardCard,
  workboardCardBoardId,
  workboardCardHasLiveExecution,
  type WorkboardCardInput,
  workboardCardSessionKey,
  type WorkboardDispatchSummary,
  type WorkboardSnapshot,
  type WorkboardStatus,
} from '@shared/openclaw/workboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import WindowTitleBar from '@/app/shell/window/WindowTitleBar';
import { i18nService } from '@/services/i18n';
import ComposeIcon from '@/shared/components/icons/ComposeIcon';
import SidebarToggleIcon from '@/shared/components/icons/SidebarToggleIcon';
import type { RootState } from '@/store';

import { workboardService } from '../workboardService';
import WorkboardCardDetailsDrawer from './WorkboardCardDetailsDrawer';
import WorkboardCardModal from './WorkboardCardModal';
import WorkboardSessionDrawer from './WorkboardSessionDrawer';

type Props = {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
};

const EMPTY_SNAPSHOT: WorkboardSnapshot = {
  cards: [],
  boards: [],
  statuses: WORKBOARD_STATUSES,
};

const priorityClasses: Record<WorkboardCard['priority'], string> = {
  low: 'bg-slate-500/10 text-slate-500',
  normal: 'bg-blue-500/10 text-blue-500',
  high: 'bg-amber-500/10 text-amber-500',
  urgent: 'bg-red-500/10 text-red-500',
};

const guideStatusGroups: readonly (readonly WorkboardStatus[])[] = [
  ['triage', 'backlog', 'todo'],
  ['scheduled', 'ready'],
  ['running', 'review', 'blocked', 'done'],
];

const guideStatusClasses: Record<WorkboardStatus, string> = {
  triage: 'border-slate-500/20 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  backlog: 'border-border bg-surface-raised text-foreground',
  todo: 'border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  scheduled: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  ready: 'border-cyan-500/20 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  running: 'border-primary/20 bg-primary/10 text-primary',
  review: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  blocked: 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-300',
  done: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
};

const WorkboardView: React.FC<Props> = ({ isSidebarCollapsed, onToggleSidebar, onNewChat }) => {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [boardId, setBoardId] = useState('all');
  const [editingCard, setEditingCard] = useState<WorkboardCard | null | undefined>(undefined);
  const [dispatchSummary, setDispatchSummary] = useState<WorkboardDispatchSummary | null>(null);
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [sessionSelection, setSessionSelection] = useState<{
    card: WorkboardCard;
    sessionKey: string;
  } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const agents = useSelector((state: RootState) => state.agent.agents).filter(
    agent => agent.enabled,
  );
  const busyRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const isMac = window.electron.platform === 'darwin';

  const load = useCallback(async (silent = false) => {
    const generation = ++loadGenerationRef.current;
    if (!silent) setLoading(true);
    try {
      const next = await workboardService.getSnapshot();
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setSnapshot({
        ...next,
        statuses: next.statuses.length > 0 ? next.statuses : WORKBOARD_STATUSES,
      });
      setError(null);
    } catch (loadError) {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setError(
        loadError instanceof Error ? loadError.message : i18nService.t('workboardLoadFailed'),
      );
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();

    return () => {
      mountedRef.current = false;
      sessionGenerationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const stop = workboardService.onChanged(() => {
      if (busyRef.current || editingCard !== undefined || draggedCardId) {
        refreshPendingRef.current = true;
        return;
      }
      void load(true);
    });
    if (
      !busyRef.current &&
      editingCard === undefined &&
      !draggedCardId &&
      refreshPendingRef.current
    ) {
      refreshPendingRef.current = false;
      void load(true);
    }
    return () => {
      stop();
    };
  }, [draggedCardId, editingCard, load]);

  const mutate = useCallback(
    async (operation: () => Promise<unknown>, reload = true) => {
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await operation();
        if (reload) await load(true);
      } catch (mutationError) {
        setError(
          mutationError instanceof Error
            ? mutationError.message
            : i18nService.t('workboardOperationFailed'),
        );
        throw mutationError;
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (refreshPendingRef.current) {
          refreshPendingRef.current = false;
          await load(true);
        }
      }
    },
    [load],
  );

  const visibleCards = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return snapshot.cards.filter(card => {
      if (!showArchived && card.metadata?.archivedAt) return false;
      if (boardId !== 'all' && workboardCardBoardId(card) !== boardId) return false;
      if (!normalizedQuery) return true;
      return [card.title, card.notes, card.agentId, ...card.labels]
        .filter(Boolean)
        .some(value => value?.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [boardId, query, showArchived, snapshot.cards]);

  const cardsByStatus = useMemo(() => {
    const result = new Map<WorkboardStatus, WorkboardCard[]>();
    snapshot.statuses.forEach(status => result.set(status, []));
    visibleCards.forEach(card => result.get(card.status)?.push(card));
    result.forEach(cards => cards.sort((left, right) => left.position - right.position));
    return result;
  }, [snapshot.statuses, visibleCards]);

  const selectedBoardId = boardId === 'all' ? undefined : boardId;
  const saveCard = async (input: WorkboardCardInput) => {
    if (editingCard) {
      const { boardId: _ignoredBoardId, ...patch } = input;
      await mutate(() => workboardService.updateCard(editingCard.id, patch, editingCard.updatedAt));
      return;
    }
    await mutate(() => workboardService.createCard(input));
  };

  const moveCard = async (status: WorkboardStatus, droppedCardId?: string) => {
    const cardId = droppedCardId || draggedCardId;
    const card = snapshot.cards.find(candidate => candidate.id === cardId);
    setDraggedCardId(null);
    if (!card || card.metadata?.archivedAt || card.status === status) return;
    const cards = cardsByStatus.get(status) ?? [];
    const position = (cards[cards.length - 1]?.position ?? 0) + 1024;
    await mutate(() => workboardService.moveCard(card.id, status, position));
  };

  const dispatch = async () => {
    let summary: WorkboardDispatchSummary | undefined;
    await mutate(async () => {
      summary = await workboardService.dispatch(selectedBoardId);
    });
    setDispatchSummary(summary ?? null);
  };

  const openSession = async (card: WorkboardCard) => {
    const linkedSessionKey = workboardCardSessionKey(card);
    if (!linkedSessionKey) return;
    const generation = ++sessionGenerationRef.current;
    try {
      const resolved = await workboardService.resolveSession(linkedSessionKey);
      if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
      setSessionSelection({ card, sessionKey: resolved.sessionKey });
      setDetailCardId(null);
      setEditingCard(undefined);
    } catch (sessionError) {
      if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
      setError(
        sessionError instanceof Error
          ? sessionError.message
          : i18nService.t('workboardSessionLoadFailed'),
      );
    }
  };

  const startCard = async (card: WorkboardCard) => {
    const generation = ++sessionGenerationRef.current;
    await mutate(async () => {
      const result = await workboardService.startCard(card.id);
      if (!mountedRef.current || generation !== sessionGenerationRef.current) return;
      setSessionSelection({ card: result.card, sessionKey: result.sessionKey });
      setDetailCardId(null);
    });
  };

  const archiveCard = async (card: WorkboardCard, archived: boolean) => {
    await mutate(() => workboardService.archiveCard(card.id, archived));
    if (archived && !showArchived) setDetailCardId(null);
  };

  const commentCard = async (card: WorkboardCard, body: string) => {
    await mutate(() => workboardService.commentCard(card.id, body));
  };

  const deleteCard = async (card: WorkboardCard) => {
    if (!window.confirm(i18nService.t('workboardDeleteConfirm'))) return;
    await mutate(() => workboardService.deleteCard(card.id));
    setDetailCardId(null);
  };

  const detailCard = detailCardId
    ? (snapshot.cards.find(card => card.id === detailCardId) ?? null)
    : null;
  const sessionCard = sessionSelection?.card;
  const sessionSnapshotCard = sessionCard
    ? snapshot.cards.find(card => card.id === sessionCard.id)
    : undefined;
  const latestSessionCard =
    sessionCard && (!sessionSnapshotCard || sessionCard.updatedAt > sessionSnapshotCard.updatedAt)
      ? sessionCard
      : sessionSnapshotCard;
  const canStopSession = Boolean(
    sessionCard &&
    sessionSnapshotCard &&
    latestSessionCard &&
    workboardCardSessionKey(sessionCard) === workboardCardSessionKey(latestSessionCard) &&
    (sessionCard.runId || sessionCard.execution?.runId) ===
      (latestSessionCard.runId || latestSessionCard.execution?.runId) &&
    sessionCard.taskId === latestSessionCard.taskId &&
    workboardCardHasLiveExecution(latestSessionCard),
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="draggable relative flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex h-8 items-center">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised"
                aria-label={i18nService.t('expand')}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised"
                aria-label={i18nService.t('newChat')}
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <WindowTitleBar inline />
      </div>

      <header className="flex min-h-0 max-h-[calc(100%-14rem)] shrink-0 flex-col overflow-hidden border-b border-border px-6 py-4">
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <h1 className="mr-auto text-lg font-semibold text-foreground">
            {i18nService.t('workboard')}
          </h1>
          <button
            type="button"
            onClick={() => setShowGuide(value => !value)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              showGuide
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-secondary hover:bg-surface-raised'
            }`}
            aria-pressed={showGuide}
          >
            <QuestionMarkCircleIcon className="h-4 w-4" />
            {i18nService.t('workboardHowToUse')}
          </button>
          <label className="relative min-w-52 flex-1 sm:max-w-xs">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-secondary" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={i18nService.t('workboardSearch')}
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          {snapshot.boards.length > 1 && (
            <select
              value={boardId}
              onChange={event => setBoardId(event.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              aria-label={i18nService.t('workboardBoard')}
            >
              <option value="all">{i18nService.t('workboardAllBoards')}</option>
              {snapshot.boards.map(board => (
                <option key={board.id} value={board.id}>
                  {board.name || board.id}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setShowArchived(value => !value)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium ${
              showArchived
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-secondary hover:bg-surface-raised'
            }`}
            aria-pressed={showArchived}
          >
            {showArchived ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
            {i18nService.t(showArchived ? 'workboardHideArchived' : 'workboardShowArchived')}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {i18nService.t('workboardRefresh')}
          </button>
          <button
            type="button"
            onClick={() => void dispatch().catch(() => undefined)}
            disabled={loading || busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            <BoltIcon className="h-4 w-4" />
            {i18nService.t('workboardDispatch')}
          </button>
          <button
            type="button"
            onClick={() => setEditingCard(null)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <PlusIcon className="h-4 w-4" />
            {i18nService.t('workboardNewCard')}
          </button>
        </div>
        {showGuide && (
          <section
            className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/[0.07] via-surface to-surface-raised/50 text-xs leading-5 text-secondary shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
            aria-label={i18nService.t('workboardHowToUse')}
            tabIndex={0}
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="mx-auto max-w-[96rem] p-4 lg:p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
                  <QuestionMarkCircleIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">
                    {i18nService.t('workboardGuideTitle')}
                  </h2>
                  <p className="mt-0.5 text-[13px] text-foreground/80">
                    {i18nService.t('workboardGuideIntro')}
                  </p>
                  <p className="mt-0.5 text-xs text-secondary">
                    {i18nService.t('workboardGuideUseCase')}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <h3 className="font-semibold text-foreground">
                  {i18nService.t('workboardGuideWorkflowTitle')}
                </h3>
                <div className="h-px flex-1 bg-border/70" />
              </div>
              <ol className="mt-2 grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
                {(['Capture', 'Prepare', 'Run', 'Review'] as const).map((step, index) => (
                  <li
                    key={step}
                    className="flex gap-2.5 rounded-xl border border-border/70 bg-surface/80 p-3 shadow-sm"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-white shadow-sm shadow-primary/20">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <h4 className="font-medium text-foreground">
                        {i18nService.t(`workboardGuide${step}Title`)}
                      </h4>
                      <p className="mt-0.5 text-xs leading-[1.55]">
                        {i18nService.t(`workboardGuide${step}`)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(26rem,0.65fr)]">
                <div className="rounded-xl bg-surface/75 p-3.5 ring-1 ring-border/70">
                  <h3 className="font-semibold text-foreground">
                    {i18nService.t('workboardGuideStatusesTitle')}
                  </h3>
                  <div className="mt-2 grid gap-3 md:grid-cols-3 md:gap-0">
                    {guideStatusGroups.map((group, groupIndex) => (
                      <div
                        key={group.join('-')}
                        className={`space-y-2 ${groupIndex > 0 ? 'md:border-l md:border-border/70 md:pl-3' : ''} ${groupIndex < guideStatusGroups.length - 1 ? 'md:pr-3' : ''}`}
                      >
                        {group.map(status => (
                          <div key={status} className="flex items-start gap-2">
                            <span
                              className={`min-w-14 shrink-0 rounded-md border px-1.5 py-0.5 text-center font-medium ${guideStatusClasses[status]}`}
                            >
                              {i18nService.t(`workboardStatus_${status}`)}
                            </span>
                            <p className="pt-0.5 text-xs leading-[1.45]">
                              {i18nService.t(`workboardGuideStatus_${status}`)}
                            </p>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl bg-surface/75 p-3.5 ring-1 ring-border/70">
                  <h3 className="font-semibold text-foreground">
                    {i18nService.t('workboardGuideActionsTitle')}
                  </h3>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    {[
                      ['Start', PlayIcon],
                      ['Dispatch', BoltIcon],
                      ['Details', InformationCircleIcon],
                      ['Session', ChatBubbleLeftRightIcon],
                    ].map(([action, Icon]) => (
                      <div key={action as string} className="flex gap-2.5 py-1">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <h4 className="font-medium text-foreground">
                            {i18nService.t(`workboardGuideAction${action}Title`)}
                          </h4>
                          <p className="text-xs leading-[1.45]">
                            {i18nService.t(`workboardGuideAction${action}`)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <details className="group mt-3 overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/[0.06]">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-amber-700 outline-none marker:hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/40 dark:text-amber-300">
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0" />
                  <span className="font-medium">
                    {i18nService.t('workboardGuideProblemsTitle')}
                  </span>
                  <span className="hidden truncate text-xs opacity-75 sm:inline">
                    {i18nService.t('workboardGuideProblemsHint')}
                  </span>
                  <ChevronDownIcon className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="grid gap-2 border-t border-amber-500/15 p-3 md:grid-cols-3">
                  {(['CannotStart', 'Claimed', 'Blocked'] as const).map(problem => (
                    <div key={problem} className="border-l-2 border-amber-500/25 px-2.5 py-1">
                      <h4 className="font-medium text-foreground">
                        {i18nService.t(`workboardGuideProblem${problem}Title`)}
                      </h4>
                      <p className="mt-0.5 text-xs leading-[1.5] text-secondary">
                        {i18nService.t(`workboardGuideProblem${problem}`)}
                      </p>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </section>
        )}
        {dispatchSummary && (
          <div className="mt-3 shrink-0 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
            {i18nService
              .t('workboardDispatchSummary')
              .replace('{started}', String(dispatchSummary.started))
              .replace('{promoted}', String(dispatchSummary.promoted))
              .replace('{blocked}', String(dispatchSummary.blocked))
              .replace('{failures}', String(dispatchSummary.failures))}
          </div>
        )}
        {error && (
          <div className="mt-3 flex shrink-0 items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-5">
        {loading && snapshot.cards.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-secondary">
            {i18nService.t('loading')}
          </div>
        ) : (
          <div className="grid h-full w-full grid-cols-[repeat(9,minmax(7rem,1fr))] gap-2">
            {snapshot.statuses.map(status => {
              const cards = cardsByStatus.get(status) ?? [];
              return (
                <section
                  key={status}
                  className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised/55"
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault();
                    void moveCard(status, event.dataTransfer.getData('text/plain')).catch(
                      () => undefined,
                    );
                  }}
                >
                  <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border px-2.5 py-2.5">
                    <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
                      {i18nService.t(`workboardStatus_${status}`)}
                    </h2>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-xs tabular-nums text-secondary">
                      {cards.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-1.5">
                    {cards.length === 0 ? (
                      <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-xs text-secondary/70">
                        {i18nService.t('workboardEmptyColumn')}
                      </div>
                    ) : (
                      cards.map(card => {
                        const sessionKey = workboardCardSessionKey(card);
                        return (
                          <article
                            key={card.id}
                            draggable={!busy && !card.metadata?.archivedAt}
                            onDragStart={event => {
                              setDraggedCardId(card.id);
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('text/plain', card.id);
                            }}
                            onDragEnd={() => setDraggedCardId(null)}
                            onClick={() => setDetailCardId(card.id)}
                            className={`cursor-pointer rounded-xl border border-border bg-background p-2 shadow-sm transition hover:border-primary/40 hover:shadow-md ${
                              draggedCardId === card.id ? 'opacity-50' : ''
                            } ${card.metadata?.archivedAt ? 'opacity-60' : ''}`}
                          >
                            <div className="flex items-start gap-2">
                              <h3 className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-foreground">
                                {card.title}
                              </h3>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${priorityClasses[card.priority]}`}
                              >
                                {i18nService.t(`workboardPriority_${card.priority}`)}
                              </span>
                            </div>
                            {card.notes && (
                              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-secondary">
                                {card.notes}
                              </p>
                            )}
                            {card.labels.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {card.labels.map(label => (
                                  <span
                                    key={label}
                                    className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                                  >
                                    {label}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="mt-2.5 flex min-w-0 items-center gap-1 text-[11px] text-secondary">
                              {card.agentId && (
                                <span className="min-w-0 flex-1 truncate">@{card.agentId}</span>
                              )}
                              <div
                                className={`${card.agentId ? '' : 'ml-auto'} flex shrink-0 items-center`}
                              >
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    setDetailCardId(card.id);
                                  }}
                                  className="inline-flex h-6 w-5 items-center justify-center rounded text-secondary hover:bg-surface-raised hover:text-foreground"
                                  aria-label={i18nService.t('workboardViewDetails')}
                                  title={i18nService.t('workboardViewDetails')}
                                >
                                  <InformationCircleIcon className="h-3.5 w-3.5" />
                                </button>
                                {sessionKey && (
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation();
                                      void openSession(card);
                                    }}
                                    className="inline-flex h-6 w-5 items-center justify-center rounded text-primary hover:bg-primary/10"
                                    aria-label={i18nService.t('workboardOpenSession')}
                                    title={i18nService.t('workboardOpenSession')}
                                  >
                                    <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                              {canStartWorkboardCard(card) && (
                                <button
                                  type="button"
                                  onClick={event => {
                                    event.stopPropagation();
                                    void startCard(card).catch(() => undefined);
                                  }}
                                  disabled={busy}
                                  className="inline-flex h-6 w-5 shrink-0 items-center justify-center rounded text-primary hover:bg-primary/10 disabled:opacity-50"
                                  aria-label={i18nService.t('workboardStart')}
                                  title={i18nService.t('workboardStart')}
                                >
                                  <PlayIcon className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {editingCard !== undefined && (
        <WorkboardCardModal
          card={editingCard}
          boardId={selectedBoardId}
          agents={agents}
          onClose={() => setEditingCard(undefined)}
          onSave={saveCard}
          onOpenSession={
            editingCard && workboardCardSessionKey(editingCard)
              ? () => {
                  void openSession(editingCard);
                }
              : undefined
          }
          onDelete={
            editingCard
              ? () => mutate(() => workboardService.deleteCard(editingCard.id))
              : undefined
          }
        />
      )}
      {detailCard && (
        <WorkboardCardDetailsDrawer
          key={detailCard.id}
          card={detailCard}
          busy={busy}
          onClose={() => setDetailCardId(null)}
          onEdit={() => {
            setEditingCard(detailCard);
            setDetailCardId(null);
          }}
          onOpenSession={
            workboardCardSessionKey(detailCard) ? () => void openSession(detailCard) : undefined
          }
          onStart={() => startCard(detailCard)}
          onStop={() =>
            mutate(() =>
              workboardService.stopCard(detailCard.id, {
                sessionKey: workboardCardSessionKey(detailCard) ?? undefined,
                runId: detailCard.runId || detailCard.execution?.runId,
                taskId: detailCard.taskId,
              }),
            )
          }
          onMove={status => moveCard(status, detailCard.id)}
          onArchive={archived => archiveCard(detailCard, archived)}
          onComment={body => commentCard(detailCard, body)}
          onDelete={() => deleteCard(detailCard)}
        />
      )}
      {sessionSelection && (
        <WorkboardSessionDrawer
          key={`${sessionSelection.card.id}:${sessionSelection.sessionKey}`}
          sessionKey={sessionSelection.sessionKey}
          cardTitle={latestSessionCard?.title ?? sessionSelection.card.title}
          canStop={canStopSession}
          busy={busy}
          onStop={async () => {
            if (!canStopSession) return;
            await mutate(() =>
              workboardService.stopCard(sessionSelection.card.id, {
                sessionKey: sessionSelection.sessionKey,
                runId: sessionSelection.card.runId || sessionSelection.card.execution?.runId,
                taskId: sessionSelection.card.taskId,
              }),
            );
          }}
          onClose={() => {
            sessionGenerationRef.current += 1;
            setSessionSelection(null);
          }}
        />
      )}
    </div>
  );
};

export default WorkboardView;
