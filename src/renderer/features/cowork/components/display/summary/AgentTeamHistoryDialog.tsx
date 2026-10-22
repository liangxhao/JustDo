import { MagnifyingGlassIcon, UserGroupIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { CollaborationRoomEntry } from '@shared/cowork/agent-team/collaboration';
import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';
import type { RootState } from '@/store';

import { AgentTeamKind } from './agentTeamEntries';
import { type AgentTeamHistoryEntry, buildAgentTeamHistory } from './agentTeamHistory';
import AgentTeamRecordSummary from './AgentTeamRecordSummary';

export type OpenTeamHistory = (
  entry: AgentTeamHistoryEntry,
  isCurrent: () => boolean,
) => Promise<void>;

/** An explicit metadata browser; opening it never creates or executes a team. */
export default function AgentTeamHistoryDialog({
  onOpen,
  onClose,
}: {
  onOpen: OpenTeamHistory;
  onClose: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const titleId = useId();
  const content = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const request = useRef(0);
  const metadataRequest = useRef(0);
  const [collaborations, setCollaborations] = useState<CollaborationRoomEntry[]>([]);
  const [discussions, setDiscussions] = useState<TeamDiscussionRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const [filter, setFilter] = useState<'all' | 'task' | 'group'>('all');
  const [query, setQuery] = useState('');
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const t = i18nService.t.bind(i18nService);
  const entries = buildAgentTeamHistory(
    collaborations,
    discussions,
    new Map(sessions.map(session => [session.id, session.title])),
    new Map(agents.map(agent => [agent.id, agent.name])),
    t,
  );
  const text = query.trim().toLocaleLowerCase();
  const visible = entries.filter(
    entry =>
      (filter === 'all' || entry.kind === filter) &&
      (!text ||
        [entry.title, ...entry.memberNames].some(value =>
          value.toLocaleLowerCase().includes(text),
        )),
  );
  const close = () => {
    request.current += 1;
    live.current = false;
    onClose();
  };
  useEffect(() => {
    live.current = true;
    const id = ++metadataRequest.current;
    const previous = ownerDocument.activeElement as HTMLElement | null;
    content.current?.focus();
    void Promise.allSettled([
      Promise.resolve().then(() => window.electron.collaboration.list()),
      Promise.resolve().then(() => window.electron.teamDiscussion.list()),
    ]).then(([tasks, groups]) => {
      if (!live.current || id !== metadataRequest.current) return;
      if (tasks.status === 'fulfilled' && tasks.value.success) setCollaborations(tasks.value.value);
      if (groups.status === 'fulfilled' && groups.value.success) setDiscussions(groups.value.value);
      if (
        tasks.status === 'rejected' ||
        groups.status === 'rejected' ||
        !tasks.value.success ||
        !groups.value.success
      )
        setError('teamRecordsUnavailable');
      setLoading(false);
    });
    return () => {
      live.current = false;
      request.current += 1;
      metadataRequest.current += 1;
      if (previous?.isConnected) previous.focus();
    };
  }, [ownerDocument]);
  return createPortal(
    <Modal
      onClose={close}
      className="mx-4 w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl"
    >
      <div
        ref={content}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(
            content.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled)',
            ) ?? [],
          );
          const first = controls[0],
            last = controls[controls.length - 1];
          if (
            event.shiftKey
              ? ownerDocument.activeElement === first ||
                ownerDocument.activeElement === content.current
              : ownerDocument.activeElement === last ||
                ownerDocument.activeElement === content.current
          ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }}
      >
        <header className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <UserGroupIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <h2 id={titleId} className="flex-1 text-base font-semibold">
            {t('teamRecords')}
          </h2>
          <button
            type="button"
            aria-label={t('close')}
            onClick={close}
            className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-5 pb-4">
          <div
            className="flex rounded-lg bg-surface-raised p-0.5"
            role="group"
            aria-label={t('teamHistoryFilter')}
          >
            {(['all', 'task', 'group'] as const).map(kind => (
              <button
                key={kind}
                type="button"
                aria-pressed={filter === kind}
                onClick={() => setFilter(kind)}
                className="rounded-md px-2.5 py-1.5 text-xs text-secondary transition-colors aria-pressed:bg-surface aria-pressed:text-foreground aria-pressed:shadow-sm"
              >
                {t(kind === 'all' ? 'teamHistoryAll' : kind === 'task' ? 'teamTask' : 'teamGroup')}
                <span className="ml-1.5 text-[10px] tabular-nums opacity-60">
                  {kind === 'all'
                    ? entries.length
                    : entries.filter(entry => entry.kind === kind).length}
                </span>
              </button>
            ))}
          </div>
          <label className="relative ml-auto min-w-36 flex-1 sm:max-w-52">
            <MagnifyingGlassIcon
              className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-secondary"
              aria-hidden="true"
            />
            <input
              aria-label={t('teamHistorySearch')}
              placeholder={t('teamHistorySearch')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-8 w-full rounded-lg border border-border-subtle bg-surface-raised py-1.5 pl-8 pr-2 text-xs outline-none focus:border-primary/50"
            />
          </label>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          {error && (
            <p role="alert" className="px-2 py-3 text-xs text-amber-600 dark:text-amber-400">
              {t(error)}
            </p>
          )}
          {loading ? (
            <p role="status" className="px-2 py-6 text-center text-sm text-secondary">
              {t('teamHistoryLoading')}
            </p>
          ) : !visible.length && !error ? (
            <p className="px-2 py-8 text-center text-sm text-secondary">
              {t(entries.length ? 'teamHistoryNoMatches' : 'teamHistoryEmpty')}
            </p>
          ) : (
            visible.map(entry => (
              <button
                key={entry.key}
                type="button"
                disabled={opening}
                className="group mb-1 flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-3 text-left transition-colors hover:border-border-subtle hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                onClick={() => {
                  if (opening) return;
                  const id = ++request.current;
                  const isCurrent = () => live.current && request.current === id;
                  setOpening(true);
                  setError('');
                  void onOpen(entry, isCurrent)
                    .catch(() => {
                      if (isCurrent()) setError('teamHistoryOpenFailed');
                    })
                    .finally(() => {
                      if (isCurrent()) setOpening(false);
                    });
                }}
              >
                <AgentTeamRecordSummary
                  entry={entry}
                  title={entry.title}
                  memberNames={entry.memberNames}
                  caption={
                    entry.kind === AgentTeamKind.TASK && entry.title !== entry.label
                      ? entry.label
                      : entry.updatedAt
                        ? new Date(entry.updatedAt).toLocaleDateString(
                            i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
                            { month: 'short', day: 'numeric' },
                          )
                        : undefined
                  }
                />
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
