import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';

export const SUBAGENT_STATUSES = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus =
  (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

type Subagent = {
  id: string;
  sessionKey: string;
  label: string;
  status: SubagentStatus;
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
  const rootRef = useRef<HTMLDivElement>(null);
  const refreshInFlightRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsLoading(true);
    try {
      const result = await window.electron.cowork.getSubTaskStatus(sessionId);
      if (result.success && sessionIdRef.current === sessionId) {
        setSubagents((result.subagents as Subagent[] | undefined) ?? []);
      }
    } catch {
      // Preserve the last successful snapshot and retry on the next interval.
    } finally {
      refreshInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSubagents([]);
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
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isOpen]);

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
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
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
                {isLoading
                  ? i18nService.t('loading')
                  : i18nService.t('subagentEmpty')}
              </div>
            ) : (
              subagents.map(subagent => (
                <div
                  key={subagent.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-surface-raised"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${statusStyles[subagent.status]}`} />
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
    </div>
  );
};

export default SubagentMenu;
