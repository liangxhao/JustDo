import { DocumentDuplicateIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import ChatMessageDisplay from '@/features/cowork/components/ChatMessageDisplay';
import { connectToGateway } from '@/features/cowork/components/JustDoChatWrapper';
import { type Subagent, subagentStatusStyles } from '@/features/cowork/components/SubagentMenu';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

import { reconcileSubagentLabel } from './subagentLabel';
import SubagentTokenUsage from './SubagentTokenUsage';

const DRAWER_DEFAULT_WIDTH = 672;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_WINDOW_MARGIN = 16;
const SUBAGENT_INITIAL_HISTORY_TIMEOUT_MS = 15_000;

interface SubagentMessageDrawerProps {
  parentSessionId: string;
  subagent: Subagent | null;
  onClose: () => void;
}

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), viewportMax);
};

const SubagentMessageDrawer: React.FC<SubagentMessageDrawerProps> = ({
  parentSessionId,
  subagent,
  onClose,
}) => {
  const [controller, setController] = useState<ChatController | null>(null);
  const [displaySubagent, setDisplaySubagent] = useState<Subagent | null>(subagent);
  const [isLoading, setIsLoading] = useState(false);
  const [isEmpty, setIsEmpty] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [detailStats, setDetailStats] = useState<SessionDetailStats>();
  const [isDetailStatsLoading, setIsDetailStatsLoading] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const drawerRef = useRef<HTMLElement>(null);
  const detailStatsSessionKeyRef = useRef<string>();
  const detailStatsRef = useRef<SessionDetailStats>();
  const subagentSessionKey = subagent?.sessionKey;

  useEffect(() => {
    setDisplaySubagent(subagent);
  }, [subagent]);

  useEffect(() => {
    if (!subagentSessionKey) {
      setController(null);
      return;
    }

    const nextController = new ChatController({ expectInitialHistory: true });
    nextController.state.sessionKey = subagentSessionKey;
    let cancelled = false;
    let initialHistoryTimedOut = false;
    const unsubscribe = nextController.subscribe(state => {
      if (cancelled) return;
      const hasVisibleTranscript =
        state.chatMessages.length > 0 || state.transcript.activeTurn !== null;
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
    const initialHistoryTimeout = window.setTimeout(() => {
      if (cancelled || nextController.state.initialHistoryReady) return;
      initialHistoryTimedOut = true;
      const hasVisibleTranscript =
        nextController.state.chatMessages.length > 0 ||
        nextController.state.transcript.activeTurn !== null;
      setIsLoading(false);
      setHasError(!hasVisibleTranscript);
      setIsEmpty(false);
    }, SUBAGENT_INITIAL_HISTORY_TIMEOUT_MS);

    setController(nextController);
    setIsLoading(true);
    setIsEmpty(false);
    setHasError(false);
    connectToGateway(nextController)
      .then(success => {
        if (cancelled) {
          nextController.disconnect();
          return;
        }
        if (!success) {
          setIsLoading(false);
          setHasError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoading(false);
          setHasError(true);
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(initialHistoryTimeout);
      unsubscribe();
      nextController.disconnect();
      setController(current => (current === nextController ? null : current));
    };
  }, [subagentSessionKey]);

  useEffect(() => {
    if (!parentSessionId || !subagent?.sessionKey) return;
    let cancelled = false;

    const refreshStatus = async () => {
      try {
        const result = await window.electron.cowork.getSubTaskStatus(parentSessionId);
        if (cancelled || !result.success) return;
        const latest = result.subagents?.find(item => item.sessionKey === subagent.sessionKey);
        if (latest) {
          setDisplaySubagent(current => {
            const previous = current ?? subagent;
            return {
              ...previous,
              ...latest,
              ...reconcileSubagentLabel(
                { label: previous.label, labelSource: previous.labelSource },
                { label: latest.label, labelSource: latest.labelSource },
              ),
            };
          });
        }
      } catch {
        // Preserve the last known drawer status and retry on the next interval.
      }
    };

    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [parentSessionId, subagent]);

  useEffect(() => {
    const sessionKey = displaySubagent?.sessionKey;
    if (!sessionKey) {
      detailStatsSessionKeyRef.current = undefined;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
      setIsDetailStatsLoading(false);
      return;
    }
    const isNewSession = detailStatsSessionKeyRef.current !== sessionKey;
    if (isNewSession) {
      detailStatsSessionKeyRef.current = sessionKey;
      detailStatsRef.current = undefined;
      setDetailStats(undefined);
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
      let succeeded = false;
      try {
        const result = await window.electron.cowork.getSubTaskDetails(sessionKey);
        if (!cancelled && result.success) {
          succeeded = true;
          detailStatsRef.current = result.stats;
          setDetailStats(result.stats);
        }
      } catch {
        // Preserve the last complete lifetime total until the next refresh.
      } finally {
        refreshInFlight = false;
        if (!cancelled) setIsDetailStatsLoading(false);
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
  }, [displaySubagent?.sessionKey, displaySubagent?.status, isInfoOpen]);

  useEffect(() => {
    const handleResize = () => {
      setDrawerWidth(width => clampDrawerWidth(width));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    event.preventDefault();

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setDrawerWidth(clampDrawerWidth(right - moveEvent.clientX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  if (!displaySubagent) return null;

  const formatDateTime = (value?: number): string =>
    value ? new Date(value).toLocaleString() : i18nService.t('subagentInfoUnavailable');

  const formatRuntime = (value?: number): string => {
    if (value === undefined) return i18nService.t('subagentInfoUnavailable');
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
      await navigator.clipboard.writeText(value);
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('copySessionIdSuccess'),
        }),
      );
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t('copySessionIdFailed'),
        }),
      );
    }
  };

  const subagentStatus = displaySubagent.status;
  const detailRows: Array<[string, React.ReactNode, boolean?]> = [
    [i18nService.t('subagentInfoStatus'), subagentStatus],
    [i18nService.t('subagentInfoTask'), displaySubagent.task],
    [i18nService.t('subagentInfoModel'), displaySubagent.model],
    [i18nService.t('subagentInfoRuntime'), formatRuntime(displaySubagent.runtimeMs)],
    [i18nService.t('subagentInfoStarted'), formatDateTime(displaySubagent.startedAt)],
    [i18nService.t('subagentInfoEnded'), formatDateTime(displaySubagent.endedAt)],
    [
      i18nService.t('subagentInfoTokens'),
      <SubagentTokenUsage key="token-usage" stats={detailStats} isLoading={isDetailStatsLoading} />,
    ],
    [i18nService.t('subagentInfoSession'), displaySubagent.sessionKey],
    [i18nService.t('subagentInfoSessionId'), displaySubagent.sessionId, true],
  ];

  const emptyText = hasError
    ? i18nService.t('subagentMessagesLoadFailed')
    : isLoading
      ? i18nService.t('loading')
      : i18nService.t('subagentMessagesEmpty');

  return (
    <>
      <aside
        ref={drawerRef}
        className="absolute right-0 top-2 bottom-4 z-[60] flex max-w-full flex-col overflow-hidden rounded-l-xl border border-r-0 border-border bg-background shadow-2xl"
        style={{ width: drawerWidth }}
      >
        <div
          className="absolute left-0 top-0 bottom-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/20"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={i18nService.t('subagentDrawerResize')}
          title={i18nService.t('subagentDrawerResize')}
        />
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${subagentStatusStyles[subagentStatus]}`}
            />
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {i18nService.t('subagentDrawerTitle').replace('{title}', displaySubagent.label)}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
              onClick={() => setIsInfoOpen(true)}
              aria-label={i18nService.t('subagentShowInfo')}
              title={i18nService.t('subagentShowInfo')}
            >
              <InformationCircleIcon className="h-4 w-4" />
            </button>
            <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-secondary">
              {subagentStatus}
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
                  i18nService.t('subagentInfoUnavailable')
                ) : typeof value === 'string' ? (
                  value || i18nService.t('subagentInfoUnavailable')
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
