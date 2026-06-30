import { InformationCircleIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { ChatController } from '../../libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import ChatMessageDisplay from './ChatMessageDisplay';
import { connectToGateway } from './JustDoChatWrapper';
import { type Subagent, subagentStatusStyles } from './SubagentMenu';

const DRAWER_DEFAULT_WIDTH = 672;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH = 960;
const DRAWER_WINDOW_MARGIN = 16;

interface SubagentMessageDrawerProps {
  subagent: Subagent | null;
  onClose: () => void;
}

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), Math.min(DRAWER_MAX_WIDTH, viewportMax));
};

const SubagentMessageDrawer: React.FC<SubagentMessageDrawerProps> = ({ subagent, onClose }) => {
  const [controller, setController] = useState<ChatController | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const drawerRef = useRef<HTMLElement>(null);
  const subagentSessionKey = subagent?.sessionKey;

  useEffect(() => {
    if (!subagentSessionKey) {
      setController(null);
      return;
    }

    const nextController = new ChatController();
    nextController.state.sessionKey = subagentSessionKey;
    let cancelled = false;

    setController(nextController);
    setIsLoading(true);
    setHasError(false);
    connectToGateway(nextController)
      .then(success => {
        if (cancelled) {
          nextController.disconnect();
          return;
        }
        setHasError(!success);
      })
      .catch(() => {
        if (!cancelled) {
          setHasError(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      nextController.disconnect();
      setController(current => (current === nextController ? null : current));
    };
  }, [subagentSessionKey]);

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

  if (!subagent) return null;

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

  const subagentStatus = subagent.status;
  const detailRows = [
    [i18nService.t('subagentInfoStatus'), subagentStatus],
    [i18nService.t('subagentInfoTask'), subagent.task],
    [i18nService.t('subagentInfoModel'), subagent.model],
    [i18nService.t('subagentInfoRuntime'), formatRuntime(subagent.runtimeMs)],
    [i18nService.t('subagentInfoStarted'), formatDateTime(subagent.startedAt)],
    [i18nService.t('subagentInfoEnded'), formatDateTime(subagent.endedAt)],
    [i18nService.t('subagentInfoTokens'), subagent.totalTokens?.toLocaleString()],
    [i18nService.t('subagentInfoSession'), subagent.sessionKey],
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
              {i18nService.t('subagentDrawerTitle').replace('{title}', subagent.label)}
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
          {hasError || (isLoading && !controller) ? (
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
            {subagent.label}
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
          {detailRows.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b border-border/60 py-2.5 last:border-0"
            >
              <dt className="text-sm text-secondary">{label}</dt>
              <dd className="break-words whitespace-pre-wrap text-sm text-foreground">
                {value || i18nService.t('subagentInfoUnavailable')}
              </dd>
            </div>
          ))}
        </dl>
      </Modal>
    </>
  );
};

export default SubagentMessageDrawer;
