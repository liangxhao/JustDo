import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

export const SUBAGENT_STATUSES = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus = (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

type Subagent = {
  id: string;
  sessionKey: string;
  label: string;
  status: SubagentStatus;
  task?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
};

type ContextMenuState = {
  x: number;
  y: number;
  subagent: Subagent;
};

const statusStyles: Record<SubagentStatus, string> = {
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  failed: 'bg-red-500',
  killed: 'bg-red-500',
  timeout: 'bg-red-500',
};

const statusLabels: Record<SubagentStatus, string> = {
  running: 'subagentStatusRunning',
  done: 'subagentStatusDone',
  failed: 'subagentStatusFailed',
  killed: 'subagentStatusKilled',
  timeout: 'subagentStatusTimeout',
};

interface SubagentMenuProps {
  sessionId: string;
}

const SubagentMenu: React.FC<SubagentMenuProps> = ({ sessionId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [detailSubagent, setDetailSubagent] = useState<Subagent | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const refreshInFlightRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const result = await window.electron.cowork.getSubTaskStatus(sessionId);
      if (result.success && sessionIdRef.current === sessionId) {
        const nextSubagents = (result.subagents as Subagent[] | undefined) ?? [];
        setSubagents(current => {
          const stableLabels = new Map(current.map(subagent => [subagent.id, subagent.label]));
          return nextSubagents.map(subagent => ({
            ...subagent,
            label: stableLabels.get(subagent.id) || subagent.label,
          }));
        });
        hasLoadedRef.current = true;
        setIsLoading(false);
      }
    } catch {
      // Preserve the last successful snapshot and retry on the next interval.
    } finally {
      refreshInFlightRef.current = false;
      if (sessionIdRef.current === sessionId) setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    hasLoadedRef.current = false;
    setSubagents([]);
    setContextMenu(null);
    setDetailSubagent(null);
  }, [sessionId]);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

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

  const detailRows = detailSubagent
    ? [
        [i18nService.t('subagentInfoStatus'), i18nService.t(statusLabels[detailSubagent.status])],
        [i18nService.t('subagentInfoTask'), detailSubagent.task],
        [i18nService.t('subagentInfoModel'), detailSubagent.model],
        [i18nService.t('subagentInfoRuntime'), formatRuntime(detailSubagent.runtimeMs)],
        [i18nService.t('subagentInfoStarted'), formatDateTime(detailSubagent.startedAt)],
        [i18nService.t('subagentInfoEnded'), formatDateTime(detailSubagent.endedAt)],
        [i18nService.t('subagentInfoTokens'), detailSubagent.totalTokens?.toLocaleString()],
        [i18nService.t('subagentInfoSession'), detailSubagent.sessionKey],
      ]
    : [];

  const runningCount = subagents.filter(
    subagent => subagent.status === SUBAGENT_STATUSES.RUNNING,
  ).length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(value => !value)}
        className="relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        aria-label={i18nService.t('subagents')}
        title={i18nService.t('subagents')}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-[18px] w-[18px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="8" r="3" />
          <circle cx="5" cy="16" r="2.5" />
          <circle cx="19" cy="16" r="2.5" />
          <path d="M12 11v2M7.5 14.5 10 13m6.5 1.5L14 13" />
        </svg>
        {runningCount > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-2 ring-background" />
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-10 z-[70] w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold text-foreground">
              {i18nService.t('subagents')}
            </span>
            <span className="text-xs text-secondary">{subagents.length}</span>
          </div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {subagents.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-secondary">
                {isLoading ? i18nService.t('loading') : i18nService.t('subagentEmpty')}
              </div>
            ) : (
              subagents.map(subagent => (
                <div
                  key={subagent.id}
                  onContextMenu={event => {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu({
                      x: Math.min(event.clientX, window.innerWidth - 180),
                      y: Math.min(event.clientY, window.innerHeight - 48),
                      subagent,
                    });
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-raised"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${statusStyles[subagent.status]}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {subagent.label}
                  </span>
                  <span className="shrink-0 text-xs text-secondary">
                    {i18nService.t(statusLabels[subagent.status])}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          className="context-menu fixed z-[90] min-w-44"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="menu-item w-full text-left"
            onClick={() => {
              setDetailSubagent(contextMenu.subagent);
              setContextMenu(null);
            }}
          >
            {i18nService.t('subagentShowInfo')}
          </button>
        </div>
      )}

      <Modal
        isOpen={detailSubagent !== null}
        onClose={() => setDetailSubagent(null)}
        className="w-[min(36rem,calc(100vw-2rem))] max-h-[80vh] overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        overlayClassName="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      >
        {detailSubagent && (
          <>
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="min-w-0 truncate text-base font-semibold text-foreground">
                {detailSubagent.label}
              </h2>
              <button
                type="button"
                onClick={() => setDetailSubagent(null)}
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
          </>
        )}
      </Modal>
    </div>
  );
};

export default SubagentMenu;
