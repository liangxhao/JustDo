import { DocumentDuplicateIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import { connectToGateway } from '@/features/cowork/components/chat/JustDoChatWrapper';
import {
  mergeSubtaskSnapshots,
  resolveSubtaskElapsedMs,
  type Subtask as Subagent,
  SUBTASK_STATUS_I18N_KEYS,
  subtaskStatusStyles,
} from '@/features/cowork/components/subagents/subtaskPresentation';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

import { startSubagentGatewayConnection } from '../shared/subagentGatewayConnection';
import { reconcileSubagentLabel } from './subagentLabel';
import { ACTIVE_SUBAGENT_POLL_INTERVAL_MS, isActiveSubagentStatus } from './subagentPolling';
import SubagentTokenUsage from './SubagentTokenUsage';

const DRAWER_DEFAULT_WIDTH = 672;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_WINDOW_MARGIN = 16;
const SUBAGENT_INITIAL_HISTORY_TIMEOUT_MS = 15_000;

interface SubagentMessageDrawerProps {
  parentSessionId: string;
  subagent: Subagent | null;
  onClose: () => void;
  embedded?: boolean;
  isObscured?: boolean;
}

const clampDrawerWidth = (width: number, viewportWidth = window.innerWidth): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, viewportWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), viewportMax);
};

const SubagentMessageDrawer: React.FC<SubagentMessageDrawerProps> = ({
  parentSessionId,
  subagent,
  onClose,
  embedded = false,
  isObscured = false,
}) => {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const [controller, setController] = useState<ChatController | null>(null);
  const [displaySubagent, setDisplaySubagent] = useState<Subagent | null>(subagent);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmpty, setIsEmpty] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [hasActiveChildTurn, setHasActiveChildTurn] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [detailStats, setDetailStats] = useState<SessionDetailStats>();
  const [isDetailStatsLoading, setIsDetailStatsLoading] = useState(false);
  const [detailStatsFailed, setDetailStatsFailed] = useState(false);
  const [detailUsageUnavailable, setDetailUsageUnavailable] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const [clock, setClock] = useState(Date.now());
  const drawerRef = useRef<HTMLElement>(null);
  const detailStatsSessionKeyRef = useRef<string>();
  const detailStatsRef = useRef<SessionDetailStats>();
  const lifecycleRequestSequenceRef = useRef(0);
  const subagentRef = useRef(subagent);
  subagentRef.current = subagent;
  const subagentSessionKey = subagent?.sessionKey;
  const subagentRuntime = subagent?.runtime;
  const shouldPollStatus = isActiveSubagentStatus(displaySubagent?.status) || hasActiveChildTurn;

  useEffect(() => {
    setDisplaySubagent(subagent);
  }, [subagent]);

  useEffect(() => {
    if (!drawerRef.current) return;
    (drawerRef.current as HTMLElement & { inert: boolean }).inert = isObscured;
  }, [displaySubagent, isObscured]);

  useEffect(() => {
    if (!subagentSessionKey) {
      setController(null);
      setHasActiveChildTurn(false);
      return;
    }

    const nextController = new ChatController({
      expectInitialHistory: true,
      expectInitialUserMessage: subagentRuntime === 'acp',
    });
    nextController.state.sessionKey = subagentSessionKey;
    let cancelled = false;
    let initialHistoryTimedOut = false;
    const unsubscribe = nextController.subscribe(state => {
      if (cancelled) return;
      const hasVisibleTranscript =
        state.chatMessages.length > 0 || state.transcript.activeTurn !== null;
      setHasActiveChildTurn(state.transcript.activeTurn !== null);
      if (!state.initialHistoryReady) {
        setIsLoading(!initialHistoryTimedOut);
        if (initialHistoryTimedOut) {
          setHasError(!hasVisibleTranscript);
          setIsEmpty(false);
        }
        return;
      }
      setIsLoading(false);
      setHasError(!hasVisibleTranscript && Boolean(state.lastError));
      setIsEmpty(!hasVisibleTranscript && !state.lastError);
    });
    let initialHistoryTimeout: number | undefined;
    setController(nextController);
    const stopConnection = startSubagentGatewayConnection({
      controller: nextController,
      connect: connectToGateway,
      subscribeProgress: window.electron?.openclaw?.engine?.onProgress,
      onConnecting: () => {
        window.clearTimeout(initialHistoryTimeout);
        initialHistoryTimedOut = false;
        const hasVisibleTranscript =
          nextController.state.chatMessages.length > 0 ||
          nextController.state.transcript.activeTurn !== null;
        setIsLoading(!hasVisibleTranscript);
        setIsEmpty(false);
        setHasError(false);
        initialHistoryTimeout = window.setTimeout(() => {
          if (cancelled || nextController.state.initialHistoryReady) return;
          initialHistoryTimedOut = true;
          const hasTranscript =
            nextController.state.chatMessages.length > 0 ||
            nextController.state.transcript.activeTurn !== null;
          setIsLoading(false);
          setHasError(!hasTranscript);
          setIsEmpty(false);
        }, SUBAGENT_INITIAL_HISTORY_TIMEOUT_MS);
      },
      onFailure: () => {
        setIsLoading(false);
        setHasError(
          !nextController.state.chatMessages.length &&
            nextController.state.transcript.activeTurn === null,
        );
      },
    });

    return () => {
      cancelled = true;
      window.clearTimeout(initialHistoryTimeout);
      unsubscribe();
      stopConnection();
      setController(current => (current === nextController ? null : current));
    };
  }, [subagentRuntime, subagentSessionKey]);

  useEffect(() => {
    if (!parentSessionId || !subagentSessionKey) return;
    let cancelled = false;
    let refreshInFlight = false;

    const refreshStatus = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const lifecycleRequestSequence = ++lifecycleRequestSequenceRef.current;
      try {
        const result = await window.electron.cowork.getSubTaskStatus(
          parentSessionId,
          hasActiveChildTurn,
        );
        if (cancelled || !result.success) return;
        const latest = result.subagents?.find(item => item.id === subagent?.id);
        if (latest) {
          setDisplaySubagent(current => {
            const previous = current ?? subagentRef.current;
            if (!previous) return current;
            return mergeSubtaskSnapshots(
              previous,
              {
                ...latest,
                lifecycleRequestSequence,
                ...reconcileSubagentLabel(
                  { label: previous.label, labelSource: previous.labelSource },
                  { label: latest.label, labelSource: latest.labelSource },
                ),
              },
              { preserveCurrentTask: true },
            );
          });
        }
      } catch {
        // Preserve the last known drawer status and retry on the next interval.
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshStatus();
    const timer = shouldPollStatus
      ? window.setInterval(() => void refreshStatus(), ACTIVE_SUBAGENT_POLL_INTERVAL_MS)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [hasActiveChildTurn, parentSessionId, shouldPollStatus, subagent?.id, subagentSessionKey]);

  useEffect(() => {
    if (!isInfoOpen || !isActiveSubagentStatus(displaySubagent?.status)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [displaySubagent?.status, isInfoOpen]);

  useEffect(() => {
    const sessionKey = displaySubagent?.sessionKey;
    const taskId = displaySubagent?.id;
    if (!sessionKey) {
      detailStatsSessionKeyRef.current = undefined;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(false);
      setDetailStatsFailed(false);
      setDetailUsageUnavailable(false);
      return;
    }
    const detailIdentity = `${taskId ?? ''}:${sessionKey}`;
    const isNewTask = detailStatsSessionKeyRef.current !== detailIdentity;
    if (isNewTask) {
      detailStatsSessionKeyRef.current = detailIdentity;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setDetailStatsFailed(false);
      setDetailUsageUnavailable(false);
    }
    if (!isInfoOpen) {
      setIsDetailStatsLoading(false);
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    let retryTimer: number | undefined;
    if (!detailStatsRef.current) setIsDetailStatsLoading(true);
    const isActive = displaySubagent?.status === 'pending' || displaySubagent?.status === 'running';
    const refreshDetails = async (attempt = 0): Promise<void> => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      const lifecycleRequestSequence = ++lifecycleRequestSequenceRef.current;
      let succeeded = false;
      try {
        const result = await window.electron.cowork.getSubTaskDetails(sessionKey, taskId);
        if (!cancelled && result.success) {
          succeeded = true;
          if (result.stats) {
            detailStatsRef.current = result.stats;
            setDetailStats(result.stats);
          }
          setDetailUsageUnavailable(!result.stats);
          setDetailStatsFailed(false);
          if (result.subagent) {
            setDisplaySubagent(current => {
              if (!current || current.id !== result.subagent?.id) return current;
              return mergeSubtaskSnapshots(current, {
                ...result.subagent,
                lifecycleRequestSequence,
                ...reconcileSubagentLabel(
                  { label: current.label, labelSource: current.labelSource },
                  {
                    label: result.subagent.label,
                    labelSource: result.subagent.labelSource,
                  },
                ),
              });
            });
          }
        }
      } catch {
        // Preserve the last complete lifetime total until the next refresh.
      } finally {
        refreshInFlight = false;
        const willRetry = !succeeded && !isActive && attempt < 2;
        if (!cancelled && !willRetry) {
          setIsDetailStatsLoading(false);
          if (!succeeded) setDetailStatsFailed(true);
        }
      }
      if (!cancelled && !succeeded && !isActive && attempt < 2) {
        retryTimer = window.setTimeout(() => void refreshDetails(attempt + 1), 1000);
      }
    };
    void refreshDetails();
    const timer = isActive ? window.setInterval(() => void refreshDetails(), 5000) : undefined;
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    detailReloadKey,
    displaySubagent?.id,
    displaySubagent?.sessionKey,
    displaySubagent?.status,
    isInfoOpen,
  ]);

  useEffect(() => {
    const handleResize = () => {
      setDrawerWidth(width => clampDrawerWidth(width, ownerWindow.innerWidth));
    };
    ownerWindow.addEventListener('resize', handleResize);
    return () => ownerWindow.removeEventListener('resize', handleResize);
  }, [ownerWindow]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const right = drawerRef.current?.getBoundingClientRect().right ?? ownerWindow.innerWidth;
      event.preventDefault();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setDrawerWidth(clampDrawerWidth(right - moveEvent.clientX, ownerWindow.innerWidth));
      };

      const handleMouseUp = () => {
        ownerDocument.body.style.cursor = '';
        ownerDocument.body.style.userSelect = '';
        ownerWindow.removeEventListener('mousemove', handleMouseMove);
        ownerWindow.removeEventListener('mouseup', handleMouseUp);
      };

      ownerDocument.body.style.cursor = 'col-resize';
      ownerDocument.body.style.userSelect = 'none';
      ownerWindow.addEventListener('mousemove', handleMouseMove);
      ownerWindow.addEventListener('mouseup', handleMouseUp);
    },
    [ownerDocument, ownerWindow],
  );

  if (!displaySubagent) return null;

  const formatDateTime = (value?: number): string =>
    value ? new Date(value).toLocaleString() : i18nService.t('subtaskInfoUnavailable');

  const formatRuntime = (value?: number): string => {
    if (value === undefined) return i18nService.t('subtaskInfoUnavailable');
    const seconds = Math.max(0, Math.round(value / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${remainder}s`]
      .filter(Boolean)
      .join(' ');
  };

  const copySessionId = async (value: string): Promise<void> => {
    try {
      await ownerWindow.navigator.clipboard.writeText(value);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: { message: i18nService.t('copySessionIdSuccess'), tone: 'success' },
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: { message: i18nService.t('copySessionIdFailed'), tone: 'error' },
        }),
      );
    }
  };

  const subagentStatus = displaySubagent.status;
  const subagentStatusLabel = i18nService.t(SUBTASK_STATUS_I18N_KEYS[subagentStatus]);
  const detailRows: Array<[string, React.ReactNode, boolean?]> = [
    [i18nService.t('subtaskInfoStatus'), subagentStatusLabel],
    [i18nService.t('subtaskInfoAgentId'), displaySubagent.agentId],
    ...(displaySubagent.swarmGroupId
      ? [
          [i18nService.t('subtaskInfoSwarmGroup'), displaySubagent.swarmGroupId] as [
            string,
            React.ReactNode,
          ],
        ]
      : []),
    [i18nService.t('subtaskInfoTask'), displaySubagent.task],
    [i18nService.t('subtaskInfoModel'), displaySubagent.model],
    [
      i18nService.t('subtaskInfoRequestedModels'),
      detailStats?.models.length ? detailStats.models.join('\n') : undefined,
    ],
    [
      i18nService.t('subtaskInfoDuration'),
      formatRuntime(resolveSubtaskElapsedMs(displaySubagent, clock)),
    ],
    [i18nService.t('subtaskInfoStarted'), formatDateTime(displaySubagent.startedAt)],
    [i18nService.t('subtaskInfoEnded'), formatDateTime(displaySubagent.endedAt)],
    [
      i18nService.t('subtaskInfoTokens'),
      <div key="token-usage" className="space-y-2">
        <SubagentTokenUsage stats={detailStats} isLoading={isDetailStatsLoading} />
        {detailUsageUnavailable && (
          <div className="text-xs text-secondary" role="status">
            <p>{i18nService.t(detailStats ? 'subtaskUsageStale' : 'subtaskUsageUnavailable')}</p>
            <button
              type="button"
              disabled={isDetailStatsLoading}
              className="mt-1 text-primary hover:underline disabled:opacity-50"
              onClick={() => {
                setIsDetailStatsLoading(true);
                setDetailReloadKey(value => value + 1);
              }}
            >
              {i18nService.t('subtaskUsageRetry')}
            </button>
          </div>
        )}
      </div>,
    ],
    [i18nService.t('subtaskInfoSession'), displaySubagent.sessionKey],
    [i18nService.t('subtaskInfoSessionId'), displaySubagent.sessionId, true],
  ];

  const emptyText = hasError
    ? i18nService.t('subtaskMessagesLoadFailed')
    : isLoading
      ? i18nService.t('loading')
      : i18nService.t('subtaskMessagesEmpty');

  return (
    <>
      <aside
        ref={drawerRef}
        className={`absolute flex max-w-full flex-col overflow-hidden bg-background ${
          embedded
            ? 'inset-0 min-h-0 min-w-0'
            : 'right-0 top-2 bottom-4 z-[60] rounded-l-xl border border-r-0 border-border shadow-2xl'
        } ${isObscured ? 'invisible' : ''}`}
        style={embedded ? undefined : { width: drawerWidth }}
        aria-hidden={isObscured || undefined}
      >
        {!embedded && (
          <div
            className="absolute left-0 top-0 bottom-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/20"
            onMouseDown={handleResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label={i18nService.t('subtaskDrawerResize')}
            title={i18nService.t('subtaskDrawerResize')}
          />
        )}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${subtaskStatusStyles[subagentStatus]}`}
            />
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {i18nService.t('subtaskDrawerTitle').replace('{title}', displaySubagent.label)}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              onClick={() => setIsInfoOpen(true)}
              aria-label={i18nService.t('subtaskShowInfo')}
              title={i18nService.t('subtaskShowInfo')}
            >
              <InformationCircleIcon className="h-4 w-4" />
            </button>
            <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-secondary">
              {subagentStatusLabel}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground"
              aria-label={i18nService.t('close')}
              title={i18nService.t('close')}
            >
              ×
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 bg-background">
          {hasError || isLoading || isEmpty ? (
            <div className="flex flex-1 items-center justify-center px-3 text-center text-sm text-secondary">
              {emptyText}
            </div>
          ) : (
            <ChatMessageDisplay className="flex-1 min-h-0" controller={controller} fullWidth />
          )}
        </div>
      </aside>

      <Modal
        isOpen={isInfoOpen}
        onClose={() => setIsInfoOpen(false)}
        className="w-[min(36rem,calc(100vw-2rem))] max-h-[80vh] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
            {displaySubagent.label}
          </h2>
          <button
            type="button"
            onClick={() => setIsInfoOpen(false)}
            className="ml-4 rounded-lg px-2 py-1 text-secondary hover:bg-surface-raised"
            aria-label={i18nService.t('close')}
          >
            ×
          </button>
        </div>
        {detailStatsFailed && (
          <div
            className="border-b border-amber-500/30 bg-amber-500/5 px-5 py-2 text-xs text-amber-700 dark:text-amber-300"
            role="status"
          >
            {i18nService.t('subtaskDetailsRefreshFailed')}
          </div>
        )}
        <dl className="max-h-[calc(80vh-4rem)] overflow-y-auto px-5 py-3">
          {detailRows.map(([label, value, copyable]) => (
            <div
              key={label}
              className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-2.5 last:border-0"
            >
              <dt className="text-sm text-secondary">{label}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap text-sm text-foreground">
                {copyable && typeof value === 'string' ? (
                  <button
                    type="button"
                    className="inline-flex max-w-full items-start gap-1.5 text-left hover:text-primary"
                    onClick={() => void copySessionId(value)}
                    aria-label={i18nService.t('copySessionId')}
                    title={i18nService.t('copySessionId')}
                  >
                    <span className="min-w-0 break-all">{value}</span>
                    <DocumentDuplicateIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  </button>
                ) : value == null ? (
                  i18nService.t('subtaskInfoUnavailable')
                ) : typeof value === 'string' ? (
                  value || i18nService.t('subtaskInfoUnavailable')
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </Modal>
    </>
  );
};

export default SubagentMessageDrawer;
