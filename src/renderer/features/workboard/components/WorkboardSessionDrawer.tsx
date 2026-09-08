import { StopIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import ChatMessageDisplay from '@/features/cowork/components/ChatMessageDisplay';
import { connectToGateway } from '@/features/cowork/components/JustDoChatWrapper';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';

type Props = {
  sessionKey: string;
  cardTitle: string;
  canStop: boolean;
  busy: boolean;
  onStop: () => Promise<void>;
  onClose: () => void;
};

const INITIAL_HISTORY_TIMEOUT_MS = 15_000;
const DRAWER_DEFAULT_WIDTH = 704;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_EDGE_GAP = 24;

export const clampWorkboardSessionDrawerWidth = (width: number, availableWidth: number): number => {
  const maximum = Math.max(280, availableWidth - DRAWER_EDGE_GAP);
  const minimum = Math.min(DRAWER_MIN_WIDTH, maximum);
  return Math.min(Math.max(width, minimum), maximum);
};

const WorkboardSessionDrawer: React.FC<Props> = ({
  sessionKey,
  cardTitle,
  canStop,
  busy,
  onStop,
  onClose,
}) => {
  const [controller, setController] = useState<ChatController | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const drawerRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const nextController = new ChatController({
      expectInitialHistory: true,
      expectInitialUserMessage: true,
    });
    nextController.state.sessionKey = sessionKey;
    let cancelled = false;
    let historyTimedOut = false;

    const unsubscribe = nextController.subscribe(state => {
      if (cancelled) return;
      const hasTranscript = state.chatMessages.length > 0 || state.transcript.activeTurn !== null;
      if (!state.initialHistoryReady) {
        setLoading(!historyTimedOut);
        if (historyTimedOut) setFailed(!hasTranscript);
        return;
      }
      setLoading(false);
      setFailed(!hasTranscript && Boolean(state.lastError));
      setEmpty(!hasTranscript && !state.lastError);
    });
    const timeout = window.setTimeout(() => {
      if (cancelled || nextController.state.initialHistoryReady) return;
      historyTimedOut = true;
      const hasTranscript =
        nextController.state.chatMessages.length > 0 ||
        nextController.state.transcript.activeTurn !== null;
      setLoading(false);
      setFailed(!hasTranscript);
    }, INITIAL_HISTORY_TIMEOUT_MS);

    setController(nextController);
    setLoading(true);
    setEmpty(false);
    setFailed(false);
    void connectToGateway(nextController)
      .then(success => {
        if (cancelled) {
          nextController.disconnect();
        } else if (!success) {
          setLoading(false);
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      nextController.disconnect();
    };
  }, [sessionKey]);

  const availableWidth = useCallback(
    () => drawerRef.current?.parentElement?.clientWidth ?? window.innerWidth,
    [],
  );

  useEffect(() => {
    const handleResize = () => {
      setDrawerWidth(width => clampWorkboardSessionDrawerWidth(width, availableWidth()));
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [availableWidth]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      event.preventDefault();
      resizeCleanupRef.current?.();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setDrawerWidth(
          clampWorkboardSessionDrawerWidth(right - moveEvent.clientX, availableWidth()),
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
        clampWorkboardSessionDrawerWidth(width + direction * 24, availableWidth()),
      );
    },
    [availableWidth],
  );

  const placeholder = failed
    ? i18nService.t('workboardSessionLoadFailed')
    : loading
      ? i18nService.t('loading')
      : i18nService.t('workboardSessionEmpty');

  const handleStop = useCallback(async () => {
    if (!canStop || busy || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await onStop();
    } catch (error) {
      setStopError(
        error instanceof Error ? error.message : i18nService.t('workboardOperationFailed'),
      );
    } finally {
      setStopping(false);
    }
  }, [busy, canStop, onStop, stopping]);

  return (
    <aside
      ref={drawerRef}
      className="absolute bottom-3 right-3 top-3 z-[60] flex max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      style={{ width: drawerWidth }}
      role="dialog"
      aria-modal="true"
      aria-label={i18nService.t('workboardSessionTitle').replace('{title}', cardTitle)}
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
        aria-label={i18nService.t('workboardSessionResize')}
        title={i18nService.t('workboardSessionResize')}
      >
        <span className="absolute left-0.5 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary" />
      </div>
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4">
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {i18nService.t('workboardSessionTitle').replace('{title}', cardTitle)}
        </h2>
        <div className="flex shrink-0 items-center gap-1.5">
          {canStop && (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={busy || stopping}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-500/30 px-2.5 text-xs font-medium text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              aria-label={i18nService.t('workboardStop')}
              title={i18nService.t('workboardStop')}
            >
              <StopIcon className="h-4 w-4" />
              <span>{i18nService.t('workboardStop')}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground"
            aria-label={i18nService.t('close')}
            title={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
      </header>
      {stopError && (
        <div
          role="alert"
          className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-600 dark:text-red-300"
        >
          {stopError}
        </div>
      )}
      <div className="flex min-h-0 flex-1 bg-background">
        {failed || loading || empty ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-secondary">
            {placeholder}
          </div>
        ) : (
          <ChatMessageDisplay className="min-h-0 flex-1" controller={controller} fullWidth />
        )}
      </div>
    </aside>
  );
};

export default WorkboardSessionDrawer;
